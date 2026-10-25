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
// Lancement : bash scripts/test-db.sh --serve node tests/e2e/fake-supabase.mjs
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';

const PORT = Number(process.env.FAKE_SUPABASE_PORT ?? 54399);
const LOGIN_CODE = '123456';
const TOTP_CODE = '654321';

if (!process.env.DATABASE_URL) {
    console.error('[fake-supabase] DATABASE_URL manquant : lancer via scripts/test-db.sh --serve');
    process.exit(1);
}
// Connexion en superutilisateur : le rôle de l'appelant est fixé par SET LOCAL ROLE dans chaque transaction.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

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

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
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
/** Exécute `work` dans une transaction, sous le rôle et les claims JWT de l'appelant. */
async function asCaller(who, work) {
    const client = await pool.connect();
    try {
        await client.query('begin');
        const claims = who ? { sub: who.userId, email: who.email, role: 'authenticated', aal: who.aal } : { role: 'anon' };
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        await client.query(`set local role ${who ? 'authenticated' : 'anon'}`);
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

async function handleRpc(req, res, name, who) {
    const body = await readBody(req);
    const { rows } = await pool.query(
        `select p.proargnames as names,
                array(select format_type(t, null) from unnest(p.proargtypes) t) as types,
                format_type(p.prorettype, null) as returns
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
            params.push(value === null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value));
            return `${ident(argName)} => $${params.length}::${fn.types[i]}`;
        })
        .filter(Boolean);
    const call = `public.${ident(name)}(${args.join(', ')})`;
    if (fn.returns === 'void') {
        await asCaller(who, (client) => client.query(`select ${call}`, params));
        return send(res, 204);
    }
    const result = await asCaller(who, (client) => client.query(`select to_jsonb(${call}) as result`, params));
    return send(res, 200, result.rows[0].result);
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
async function resetData() {
    await pool.query('truncate auth.users cascade');
    await pool.query('truncate public.access_log, public.ai_calls restart identity');
    sessions.clear();
    refreshTokens.clear();
    factors.clear();
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
