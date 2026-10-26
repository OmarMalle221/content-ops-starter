#!/usr/bin/env node
// Faux Supabase pour les tests de bout en bout (et les démonstrations locales sans compte Supabase).
//
// - Auth est simulée : connexion par code, vérification en deux étapes (TOTP), sessions en mémoire.
// - Les données NE sont PAS simulées : chaque requête PostgREST de l'application est traduite en SQL et
//   exécutée sur la vraie base migrée (DATABASE_URL), sous le rôle `anon` ou `authenticated` et avec les
//   claims JWT de l'appelant. La RLS, les fonctions et les déclencheurs réels s'appliquent donc.
//   Seul le sous-ensemble de PostgREST utilisé par Relais est pris en charge.
//
//   Code de connexion : 123456     Code TOTP : 654321
//   Adresse commençant par « intervenante » → rôle relais_worker ; par « admin » → rôle admin.
//   POST /__test/reset vide les données ; GET /__test/state renvoie l'état (assertions des tests).
//
// - Storage : fichiers dans .tmp/fake-storage ; le dépôt insère d'abord dans storage.objects sous le rôle
//   de l'appelant (la politique RLS du bucket s'applique), comme l'API Storage. URL signées à durée limitée.
// - Fonctions Edge : le VRAI code serveur (supabase/functions/_shared/handlers.ts) avec une IA SIMULÉE
//   (tests/support/simulated-llm.ts) ; aucun appel réseau. GET /__test/storage?path=… lit un fichier déposé.
//   Rappels : POST /functions/v1/send-reminders avec l'en-tête x-relais-cron-secret: test-cron-secret ;
//   les courriels sont gardés en mémoire (état « emails »), jamais envoyés.
//
// Lancement : bash scripts/test-db.sh --serve node tests/e2e/fake-supabase.mjs
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { HANDLERS, RpcError } from '../../supabase/functions/_shared/handlers.ts';
import { cronSecretMatches, handleSendReminders } from '../../supabase/functions/_shared/reminders.ts';
import { SimulatedLlm } from '../support/simulated-llm.ts';

const PORT = Number(process.env.FAKE_SUPABASE_PORT ?? 54399);
const LOGIN_CODE = '123456';
const TOTP_CODE = '654321';

if (!process.env.DATABASE_URL) {
    console.error('[fake-supabase] DATABASE_URL manquant : lancer via scripts/test-db.sh --serve');
    process.exit(1);
}
// Connexion en superutilisateur : le rôle de l'appelant est fixé par SET LOCAL ROLE dans chaque transaction.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

const STORAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../.tmp/fake-storage');
const signedUrls = new Map(); // jeton → { bucket, path, expiresAt }
const contentTypes = new Map(); // « bucket/chemin » → type MIME déposé
const llm = new SimulatedLlm();
const emails = []; // courriels « envoyés » par la fonction de rappels

const sessions = new Map(); // jeton d'accès → { userId, email, aal }
const refreshTokens = new Map(); // jeton de rafraîchissement → { userId, email, aal }
const factors = new Map(); // userId → [{ id, friendly_name, status }]

// ------------------------------------------------------------------------------------------- outils
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const IDENT = /^[a-z_][a-z0-9_]*$/;

class HttpError extends Error {
    constructor(status, body) {
        super(body.message ?? body.msg ?? 'error');
        this.status = status;
        this.body = body;
    }
}

function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
}

async function readRaw(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function readBody(req) {
    const raw = (await readRaw(req)).toString('utf8');
    return raw ? JSON.parse(raw) : {};
}

function ident(name) {
    if (!IDENT.test(name)) throw new HttpError(400, { code: 'PGRST100', message: `invalid identifier ${name}` });
    return `"${name}"`;
}

// Codes SQLSTATE → statut HTTP, comme PostgREST.
function pgHttpError(error, anon) {
    const status = { 42501: anon ? 401 : 403, 23505: 409, 23503: 409, '42P01': 404, 42883: 404 }[error.code] ?? 400;
    return new HttpError(status, { code: error.code ?? 'XX000', message: error.message, details: error.detail ?? null, hint: null });
}

// ------------------------------------------------------------------------------------------- Auth
function caller(req) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    return sessions.get(token) ?? null;
}

async function userJson(userId) {
    const { rows } = await pool.query('select id, email from auth.users where id = $1', [userId]);
    const user = rows[0];
    if (!user) return null;
    const now = new Date().toISOString();
    return {
        id: user.id,
        aud: 'authenticated',
        role: 'authenticated',
        email: user.email,
        email_confirmed_at: now,
        confirmed_at: now,
        last_sign_in_at: now,
        phone: '',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        identities: [],
        created_at: now,
        updated_at: now,
        factors: (factors.get(user.id) ?? []).map((f) => ({
            id: f.id,
            friendly_name: f.friendly_name,
            factor_type: 'totp',
            status: f.status,
            created_at: now,
            updated_at: now
        }))
    };
}

async function issueSession(userId, email, aal) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        sub: userId,
        email,
        role: 'authenticated',
        aud: 'authenticated',
        aal,
        amr: [{ method: aal === 'aal2' ? 'totp' : 'otp', timestamp: now }],
        session_id: randomUUID(),
        iat: now,
        exp: now + 3600
    };
    const accessToken = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fake-signature`;
    const refreshToken = randomUUID();
    sessions.set(accessToken, { userId, email, aal });
    refreshTokens.set(refreshToken, { userId, email, aal });
    return {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: now + 3600,
        refresh_token: refreshToken,
        user: await userJson(userId)
    };
}

function roleFor(email) {
    if (email.startsWith('intervenante')) return 'relais_worker';
    if (email.startsWith('admin')) return 'admin';
    return 'member';
}

async function handleAuth(req, res, path) {
    if (req.method === 'POST' && path === '/otp') {
        const email = String((await readBody(req)).email ?? '').toLowerCase();
        const existing = await pool.query('select id from auth.users where email = $1', [email]);
        if (existing.rowCount === 0) {
            const id = randomUUID();
            await pool.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
            await pool.query('update public.users set app_role = $2 where id = $1', [id, roleFor(email)]);
        }
        return send(res, 200, {});
    }

    if (req.method === 'POST' && path === '/verify') {
        const body = await readBody(req);
        const email = String(body.email ?? '').toLowerCase();
        const { rows } = await pool.query('select id from auth.users where email = $1', [email]);
        if (!rows[0] || body.token !== LOGIN_CODE) {
            return send(res, 403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
        }
        return send(res, 200, await issueSession(rows[0].id, email, 'aal1'));
    }

    if (req.method === 'POST' && path === '/token') {
        const entry = refreshTokens.get((await readBody(req)).refresh_token);
        if (!entry) return send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
        return send(res, 200, await issueSession(entry.userId, entry.email, entry.aal));
    }

    const who = caller(req);
    const user = who && (await userJson(who.userId));
    if (!who || !user) return send(res, 401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });

    if (req.method === 'GET' && path === '/user') return send(res, 200, user);
    if (req.method === 'POST' && path === '/logout') return send(res, 204);

    const mine = factors.get(who.userId) ?? [];
    factors.set(who.userId, mine);

    if (req.method === 'POST' && path === '/factors') {
        const factor = { id: randomUUID(), friendly_name: (await readBody(req)).friendly_name, status: 'unverified' };
        mine.push(factor);
        return send(res, 200, {
            id: factor.id,
            type: 'totp',
            friendly_name: factor.friendly_name,
            totp: {
                qr_code:
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/><rect x="2" y="2" width="6" height="6"/></svg>',
                secret: 'RELAISTESTSECRET',
                uri: 'otpauth://totp/Relais:test?secret=RELAISTESTSECRET'
            }
        });
    }

    const factorPath = path.match(/^\/factors\/([^/]+)$/);
    if (req.method === 'DELETE' && factorPath) {
        factors.set(
            who.userId,
            mine.filter((f) => f.id !== factorPath[1])
        );
        return send(res, 200, { id: factorPath[1] });
    }

    if (req.method === 'POST' && /^\/factors\/[^/]+\/challenge$/.test(path)) {
        return send(res, 200, { id: randomUUID(), type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 300 });
    }

    const verify = path.match(/^\/factors\/([^/]+)\/verify$/);
    if (req.method === 'POST' && verify) {
        const body = await readBody(req);
        const factor = mine.find((f) => f.id === verify[1]);
        if (!factor || body.code !== TOTP_CODE) {
            return send(res, 422, { code: 422, error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' });
        }
        factor.status = 'verified';
        return send(res, 200, await issueSession(who.userId, who.email, 'aal2'));
    }

    return send(res, 404, { code: 404, error_code: 'not_found', msg: 'not found' });
}

// ------------------------------------------------------------------------------------ mini PostgREST
/** Exécute `work` dans une transaction, sous le rôle et les claims JWT de l'appelant (ou du service). */
async function asCaller(who, work, service = false) {
    const client = await pool.connect();
    try {
        await client.query('begin');
        const claims = service
            ? { role: 'service_role' }
            : who
              ? { sub: who.userId, email: who.email, role: 'authenticated', aal: who.aal }
              : { role: 'anon' };
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        await client.query(`set local role ${service ? 'service_role' : who ? 'authenticated' : 'anon'}`);
        const result = await work(client);
        await client.query('commit');
        return result;
    } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error instanceof HttpError ? error : pgHttpError(error, !who);
    } finally {
        client.release();
    }
}

const COMPARATORS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

/** Filtres PostgREST (eq, neq, gt, gte, lt, lte, is, in) → clause WHERE paramétrée. */
function whereClause(url, params, alias) {
    const conditions = [];
    for (const [key, raw] of url.searchParams) {
        if (RESERVED.has(key)) continue;
        const column = `${alias}.${ident(key)}`;
        const dot = raw.indexOf('.');
        const op = raw.slice(0, dot);
        const value = raw.slice(dot + 1);
        if (op in COMPARATORS) {
            params.push(value);
            conditions.push(`${column} ${COMPARATORS[op]} $${params.length}`);
        } else if (op === 'is' && ['null', 'true', 'false'].includes(value)) {
            conditions.push(`${column} is ${value}`);
        } else if (op === 'in') {
            const values = value
                .replace(/^\(|\)$/g, '')
                .split(',')
                .map((v) => v.replace(/^"|"$/g, ''));
            params.push(values);
            conditions.push(`${column} = any($${params.length})`);
        } else {
            throw new HttpError(400, { code: 'PGRST100', message: `unsupported filter ${key}=${raw}` });
        }
    }
    return conditions.length ? `where ${conditions.join(' and ')}` : '';
}

function orderClause(url, alias) {
    const order = url.searchParams.get('order');
    if (!order) return '';
    const parts = order.split(',').map((part) => {
        const [column, ...modifiers] = part.split('.');
        const direction = modifiers.includes('desc') ? 'desc' : 'asc';
        const nulls = modifiers.includes('nullsfirst') ? ' nulls first' : modifiers.includes('nullslast') ? ' nulls last' : '';
        return `${alias}.${ident(column)} ${direction}${nulls}`;
    });
    return `order by ${parts.join(', ')}`;
}

function project(rows, select) {
    if (!select || select === '*') return rows;
    if (select.includes('(')) throw new HttpError(400, { code: 'PGRST100', message: 'embedding is not supported by the fake' });
    const columns = select.split(',').map((c) => c.trim());
    return rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null])));
}

function respondRows(req, res, status, rows, select) {
    const out = project(rows, select);
    if ((req.headers.accept ?? '').includes('application/vnd.pgrst.object+json')) {
        if (out.length !== 1) {
            return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
        }
        return send(res, status, out[0]);
    }
    return send(res, status, out);
}

/** Appel d'une fonction SQL publique, arguments nommés typés d'après pg_proc ; undefined si void. */
async function rpcCall(who, name, body, service = false) {
    const { rows } = await pool.query(
        `select p.proargnames as names,
                array(select format_type(t, null) from unnest(p.proargtypes) t) as types,
                format_type(p.prorettype, null) as returns, p.proretset as returns_set
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`,
        [name]
    );
    const fn = rows[0];
    if (!fn) throw new HttpError(404, { code: 'PGRST202', message: `function ${name} not found` });
    const params = [];
    const args = (fn.names ?? [])
        .map((argName, i) => {
            if (!(argName in body)) return null;
            const value = body[argName];
            // Tableau SQL (text[]…) : tableau JS converti par pg ; json/jsonb : texte JSON.
            const sqlArray = fn.types[i].endsWith('[]') && Array.isArray(value);
            params.push(value === null ? null : sqlArray ? value : typeof value === 'object' ? JSON.stringify(value) : String(value));
            return `${ident(argName)} => $${params.length}::${fn.types[i]}`;
        })
        .filter(Boolean);
    const call = `public.${ident(name)}(${args.join(', ')})`;
    if (fn.returns_set) {
        // Fonction qui renvoie des lignes : tableau JSON, comme PostgREST.
        const sql = `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as result from ${call} r`;
        return (await asCaller(who, (client) => client.query(sql, params), service)).rows[0].result;
    }
    if (fn.returns === 'void') {
        await asCaller(who, (client) => client.query(`select ${call}`, params), service);
        return undefined;
    }
    const result = await asCaller(who, (client) => client.query(`select to_jsonb(${call}) as result`, params), service);
    return result.rows[0].result;
}

async function handleRpc(req, res, name, who) {
    const result = await rpcCall(who, name, await readBody(req));
    return result === undefined ? send(res, 204) : send(res, 200, result);
}

// ------------------------------------------------------------------------------------------- Storage
const objectFile = (bucket, path) => join(STORAGE_DIR, bucket, ...path.split('/'));

async function handleStorage(req, res, url) {
    const signed = url.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
    if (req.method === 'GET' && signed) {
        const entry = signedUrls.get(url.searchParams.get('token') ?? '');
        const [, bucket, path] = signed;
        if (!entry || entry.bucket !== bucket || entry.path !== path || entry.expiresAt < Date.now()) {
            return send(res, 400, { statusCode: '400', error: 'InvalidJWT', message: 'invalid or expired signature' });
        }
        const bytes = await readFile(objectFile(bucket, path));
        res.writeHead(200, { 'content-type': contentTypes.get(`${bucket}/${path}`) ?? 'application/octet-stream' });
        return res.end(bytes);
    }

    const upload = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
    if (req.method === 'POST' && upload) {
        const who = caller(req);
        if (!who) return send(res, 401, { statusCode: '401', error: 'Unauthorized', message: 'missing token' });
        const [, bucket, path] = upload;
        const bytes = await readRaw(req);
        const contentType = (req.headers['content-type'] ?? '').split(';')[0];
        const { rows } = await pool.query('select file_size_limit, allowed_mime_types from storage.buckets where id = $1', [bucket]);
        const limits = rows[0];
        if (!limits) return send(res, 404, { statusCode: '404', error: 'Bucket not found', message: 'bucket not found' });
        if (limits.file_size_limit && bytes.length > Number(limits.file_size_limit)) {
            return send(res, 413, { statusCode: '413', error: 'Payload too large', message: 'file too large' });
        }
        if (limits.allowed_mime_types && !limits.allowed_mime_types.includes(contentType)) {
            return send(res, 415, { statusCode: '415', error: 'invalid_mime_type', message: 'mime type not allowed' });
        }
        // Comme l'API Storage : l'objet est enregistré sous l'identité de l'appelant (politique RLS du bucket).
        await asCaller(who, (client) =>
            client.query('insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)', [bucket, path, who.userId])
        );
        await mkdir(dirname(objectFile(bucket, path)), { recursive: true });
        await writeFile(objectFile(bucket, path), bytes);
        contentTypes.set(`${bucket}/${path}`, contentType);
        return send(res, 200, { Key: `${bucket}/${path}`, Id: randomUUID() });
    }
    return send(res, 404, { statusCode: '404', error: 'not_found', message: 'not found' });
}

// -------------------------------------------------------------------------------- fonctions Edge
// Fonction planifiée : appelée par pg_cron avec un secret partagé (ici, par les tests).
const CRON_SECRET = 'test-cron-secret';

async function handleScheduled(req, res) {
    if (!cronSecretMatches(CRON_SECRET, req.headers['x-relais-cron-secret'] ?? null)) return send(res, 401, { error: 'unauthorized' });
    await readRaw(req);
    const response = await handleSendReminders({
        serviceRpc: (fn, args) =>
            rpcCall(null, fn, args, true).catch((error) => {
                throw error instanceof HttpError ? new RpcError(String(error.body.code)) : error;
            }),
        email: { send: async (message) => void emails.push(message) },
        appUrl: 'http://127.0.0.1:4173',
        now: () => new Date()
    });
    return send(res, response.status, response.body);
}

async function handleFunction(req, res, name) {
    if (name === 'send-reminders') return handleScheduled(req, res);
    const handler = HANDLERS[name];
    if (!handler) return send(res, 404, { error: 'not_found' });
    const who = caller(req);
    if (!who) return send(res, 401, { error: 'unauthorized' });
    const body = await readBody(req).catch(() => null);
    const rpc = (fn, args, service) =>
        rpcCall(who, fn, args, service).catch((error) => {
            throw error instanceof HttpError ? new RpcError(String(error.body.code)) : error;
        });
    const ctx = {
        userId: who.userId,
        userRpc: (fn, args) => rpc(fn, args, false),
        serviceRpc: (fn, args) => rpc(fn, args, true),
        storage: {
            download: async (path) => new Uint8Array(await readFile(objectFile('documents', path))),
            remove: async (paths) => {
                for (const path of paths) await rm(objectFile('documents', path), { force: true });
                await pool.query('delete from storage.objects where bucket_id = $1 and name = any($2)', ['documents', paths]);
            },
            signedUrl: async (path, seconds) => {
                const token = randomBytes(16).toString('hex');
                signedUrls.set(token, { bucket: 'documents', path, expiresAt: Date.now() + seconds * 1000 });
                return `http://127.0.0.1:${PORT}/storage/v1/object/sign/documents/${path}?token=${token}`;
            }
        },
        queuedPaths: async (prefix) =>
            (
                await pool.query(
                    `select object_path from public.storage_deletion_queue where bucket_id = 'documents' and object_path like $1`,
                    [`${prefix}%`]
                )
            ).rows.map((row) => row.object_path),
        clearQueuedPaths: async (paths) => {
            await pool.query(`delete from public.storage_deletion_queue where bucket_id = 'documents' and object_path = any($1)`, [paths]);
        },
        recordAiCall: async (row) => {
            await pool.query(
                `insert into public.ai_calls (user_id, care_file_id, purpose, provider, model, status, input_tokens, output_tokens,
                    latency_ms, pseudonymized_counts) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                    row.user_id,
                    row.care_file_id,
                    row.purpose,
                    row.provider,
                    row.model,
                    row.status,
                    row.input_tokens,
                    row.output_tokens,
                    row.latency_ms,
                    JSON.stringify(row.pseudonymized_counts)
                ]
            );
        },
        llm,
        ocr: null,
        email: { send: async (message) => void emails.push(message) },
        appUrl: 'http://127.0.0.1:4173'
    };
    const response = await handler(ctx, body);
    return send(res, response.status, response.body);
}

async function handleRest(req, res, url) {
    const who = caller(req);
    const path = url.pathname.replace('/rest/v1/', '');
    if (path.startsWith('rpc/')) return handleRpc(req, res, path.slice(4), who);

    const table = `public.${ident(path)}`;
    const select = url.searchParams.get('select');
    const params = [];
    const wantsRows = (req.headers.prefer ?? '').includes('return=representation');

    if (req.method === 'GET') {
        const limit = url.searchParams.get('limit');
        const sql = `select coalesce(json_agg(row_to_json(t0)), '[]'::json) as rows from (
            select * from ${table} t0 ${whereClause(url, params, 't0')} ${orderClause(url, 't0')}
            ${limit ? `limit ${Number.parseInt(limit, 10)}` : ''}) t0`;
        const result = await asCaller(who, (client) => client.query(sql, params));
        return respondRows(req, res, 200, result.rows[0].rows, select);
    }

    if (req.method === 'POST') {
        const body = await readBody(req);
        const records = Array.isArray(body) ? body : [body];
        const columns = [...new Set(records.flatMap((r) => Object.keys(r)))].map(ident);
        params.push(JSON.stringify(records));
        const sql = `insert into ${table} (${columns.join(', ')})
            select ${columns.join(', ')} from json_populate_recordset(null::${table}, $1::json) returning *`;
        const result = await asCaller(who, (client) => client.query(sql, params));
        return wantsRows ? respondRows(req, res, 201, result.rows, select) : send(res, 201);
    }

    if (req.method === 'PATCH') {
        const body = await readBody(req);
        const columns = Object.keys(body).map(ident);
        params.push(JSON.stringify(body));
        const sql = `update ${table} as t0 set ${columns.map((c) => `${c} = r.${c}`).join(', ')}
            from json_populate_record(null::${table}, $1::json) r ${whereClause(url, params, 't0')} returning t0.*`;
        const result = await asCaller(who, (client) => client.query(sql, params));
        return wantsRows ? respondRows(req, res, 200, result.rows, select) : send(res, 204);
    }

    if (req.method === 'DELETE') {
        const sql = `delete from ${table} as t0 ${whereClause(url, params, 't0')} returning t0.*`;
        const result = await asCaller(who, (client) => client.query(sql, params));
        return wantsRows ? respondRows(req, res, 200, result.rows, select) : send(res, 204);
    }

    throw new HttpError(405, { code: 'PGRST000', message: 'method not allowed' });
}

// ------------------------------------------------------------------------------------- outils de test
const REFERENCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../supabase/reference');

async function resetData() {
    await pool.query('truncate auth.users cascade');
    await pool.query('truncate public.access_log, public.ai_calls, public.storage_deletion_queue restart identity');
    // Fiches et ressources modifiées par un test d'administration : retour aux données de référence.
    await pool.query('truncate public.programs, public.resources cascade');
    for (const file of ['02_resources.sql', '03_programs.sql']) await pool.query(await readFile(join(REFERENCE_DIR, file), 'utf8'));
    await pool.query('truncate storage.objects');
    await rm(STORAGE_DIR, { recursive: true, force: true });
    signedUrls.clear();
    contentTypes.clear();
    llm.inputs.splice(0);
    emails.splice(0);
    sessions.clear();
    refreshTokens.clear();
    factors.clear();
}

async function storedFiles() {
    const files = await readdir(join(STORAGE_DIR, 'documents'), { recursive: true, withFileTypes: true }).catch(() => []);
    return files
        .filter((f) => f.isFile())
        .map((f) => join(f.parentPath ?? f.path, f.name).slice(join(STORAGE_DIR, 'documents').length + 1))
        .sort();
}

async function state() {
    const q = async (sql) => (await pool.query(sql)).rows;
    const users = await q(
        'select u.id, a.email, u.display_name, u.app_role from public.users u join auth.users a on a.id = u.id order by u.created_at'
    );
    return {
        users: users.map((u) => ({ ...u, factors: factors.get(u.id) ?? [] })),
        consents: await q('select * from public.consents order by granted_at'),
        careFiles: await q('select * from public.care_files order by created_at'),
        members: await q('select * from public.care_file_members order by joined_at'),
        invitations: await q(
            'select id, care_file_id, email, role, access_level, accepted_at, revoked_at from public.care_file_invitations'
        ),
        careRecipients: await q('select * from public.care_recipients'),
        contacts: await q('select * from public.contacts order by created_at'),
        documents: await q('select * from public.documents order by uploaded_at'),
        extractions: await q(
            'select id, document_id, status, method, needs_review, review_reasons, guard_flags, confirmed_data from public.document_extractions order by created_at'
        ),
        timelineEvents: await q('select * from public.timeline_events order by occurred_on'),
        medications: await q('select * from public.medication_mentions order by created_at'),
        storageObjects: (await q(`select name from storage.objects where bucket_id = 'documents' order by name`)).map((r) => r.name),
        storageFiles: await storedFiles(),
        deletionQueue: (await q('select object_path from public.storage_deletion_queue order by id')).map((r) => r.object_path),
        programs: await q(
            'select id, slug, summary, verification_status, verified_on, verified_by, version from public.programs order by sort_order'
        ),
        filePrograms: await q(
            'select p.slug, f.care_file_id, f.match_level, f.status, f.letter_draft, f.requested_at, f.decided_at from public.care_file_programs f join public.programs p on p.id = f.program_id order by p.sort_order'
        ),
        checklist: await q('select label, origin, is_done from public.program_checklist_items order by position, label'),
        explanations: await q('select program_id, program_version from public.program_explanations'),
        resources: await q('select slug, phone, verification_status, verified_by from public.resources order by sort_order'),
        tasks: await q('select title, status, assignee_id, due_on, completed_by, source_document_id from public.tasks order by created_at'),
        appointments: await q('select id, title, starts_at, companion_id from public.appointments order by starts_at'),
        appointmentQuestions: (await q('select question from public.appointment_questions order by position, created_at')).map(
            (r) => r.question
        ),
        journalEntries: await q('select body, author_id from public.journal_entries order by created_at'),
        reminderDeliveries: await q('select user_id, sent_on, task_count, appointment_count from public.reminder_deliveries'),
        checkins: await q('select user_id, week_start, fatigue, overwhelm, isolation from public.caregiver_checkins'),
        supportRequests: await q(
            'select id, requester_id, origin, contact_name, preferred_contact, phone, email, status, assigned_worker_id, notified_at, closed_at from public.support_requests order by created_at'
        ),
        supportNotes: await q('select support_request_id, author_id, body from public.support_request_notes order by created_at'),
        pilotFeedback: await q('select user_id, week_start, hours_saved, satisfaction from public.pilot_feedback'),
        emails: [...emails],
        aiCalls: await q('select * from public.ai_calls order by created_at'),
        llmInputs: [...llm.inputs],
        accessLog: await q('select * from public.access_log order by id')
    };
}

// ----------------------------------------------------------------------------------------- serveur
const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] ?? '*');
    res.setHeader('access-control-expose-headers', 'content-range');
    if (req.method === 'OPTIONS') return send(res, 204);

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    try {
        if (url.pathname === '/__test/health') return send(res, 200, { ok: true });
        if (url.pathname === '/__test/reset' && req.method === 'POST') {
            await resetData();
            return send(res, 204);
        }
        if (url.pathname === '/__test/state') return send(res, 200, await state());
        if (url.pathname === '/__test/storage') {
            const bytes = await readFile(objectFile('documents', url.searchParams.get('path') ?? '')).catch(() => null);
            if (!bytes) return send(res, 404, { message: 'not found' });
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            return res.end(bytes);
        }
        if (url.pathname.startsWith('/storage/v1/')) return await handleStorage(req, res, url);
        if (url.pathname.startsWith('/functions/v1/')) return await handleFunction(req, res, url.pathname.replace('/functions/v1/', ''));
        if (url.pathname.startsWith('/auth/v1/')) return await handleAuth(req, res, url.pathname.replace('/auth/v1', ''));
        if (url.pathname.startsWith('/rest/v1/')) return await handleRest(req, res, url);
        return send(res, 404, { message: 'not found' });
    } catch (error) {
        if (error instanceof HttpError) return send(res, error.status, error.body);
        console.error('[fake-supabase]', error);
        return send(res, 500, { message: 'internal error' });
    }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[fake-supabase] http://127.0.0.1:${PORT} → PostgreSQL`));
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        server.close();
        void pool.end().finally(() => process.exit(0));
    });
}
