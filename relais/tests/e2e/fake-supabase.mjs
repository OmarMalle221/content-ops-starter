#!/usr/bin/env node
// Faux Supabase pour les tests de bout en bout (et les démonstrations locales sans compte Supabase).
// Implémente le sous-ensemble d'Auth (code par courriel, MFA TOTP) et de PostgREST qu'utilise Relais.
// Ce n'est PAS un modèle de sécurité : RLS est testée sur PostgreSQL (supabase/tests/rls_test.sql).
//
//   Code de connexion : 123456     Code TOTP : 654321
//   Adresse commençant par « intervenante » → rôle relais_worker ; par « admin » → rôle admin.
//   POST /__test/reset remet l'état à zéro ; GET /__test/state renvoie l'état (assertions des tests).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.FAKE_SUPABASE_PORT ?? 54399);
export const LOGIN_CODE = '123456';
export const TOTP_CODE = '654321';

const consentTexts = JSON.parse(readFileSync(join(root, 'src/content/consent-texts.fr.json'), 'utf8'));
const seedResources = JSON.parse(readFileSync(join(root, 'src/content/emergency-resources.json'), 'utf8'));

let state;
function reset() {
    state = {
        users: new Map(), // id → { id, email, display_name, app_role, created_at, factors: [] }
        consents: [],
        accessLog: [],
        resources: seedResources.map((r) => ({ id: randomUUID(), verification_status: 'to_verify', is_active: true, ...r })),
        tokens: new Map(), // access token → { userId, aal }
        refreshTokens: new Map() // refresh token → userId
    };
}
reset();

// ------------------------------------------------------------------------------------------- outils
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
}

function authError(res, status, errorCode, msg) {
    send(res, status, { code: status, error_code: errorCode, msg });
}

function pgError(res, status, code, message) {
    send(res, status, { code, message, details: null, hint: null });
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
}

function userJson(user) {
    const now = user.created_at;
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
        factors: user.factors.map((f) => ({
            id: f.id,
            friendly_name: f.friendly_name,
            factor_type: 'totp',
            status: f.status,
            created_at: now,
            updated_at: now
        }))
    };
}

function issueSession(user, aal) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        sub: user.id,
        email: user.email,
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
    state.tokens.set(accessToken, { userId: user.id, aal });
    state.refreshTokens.set(refreshToken, { userId: user.id, aal });
    return {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: now + 3600,
        refresh_token: refreshToken,
        user: userJson(user)
    };
}

function caller(req) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const entry = state.tokens.get(token);
    if (!entry) return null;
    const user = state.users.get(entry.userId);
    return user ? { user, aal: entry.aal } : null;
}

function roleFor(email) {
    if (email.startsWith('intervenante')) return 'relais_worker';
    if (email.startsWith('admin')) return 'admin';
    return 'member';
}

// ---------------------------------------------------------------------------------------- PostgREST
function parseFilters(url) {
    const filters = [];
    for (const [key, raw] of url.searchParams) {
        if (key === 'select' || key === 'order' || key === 'limit') continue;
        const [op, ...rest] = raw.split('.');
        const value = rest.join('.');
        filters.push({ column: key, op, value });
    }
    return filters;
}

function matches(row, { column, op, value }) {
    const cell = row[column];
    switch (op) {
        case 'eq':
            return String(cell) === value;
        case 'is':
            return value === 'null' ? cell === null || cell === undefined : String(cell) === value;
        case 'in':
            return value
                .replace(/^\(|\)$/g, '')
                .split(',')
                .includes(String(cell));
        default:
            throw new Error(`opérateur non géré : ${op}`);
    }
}

function project(row, select) {
    if (!select || select === '*') return row;
    return Object.fromEntries(
        select
            .split(',')
            .map((c) => c.trim())
            .map((c) => [c, row[c] ?? null])
    );
}

function sortRows(rows, order) {
    if (!order) return rows;
    const [column, direction] = order.split('.');
    return [...rows].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (direction === 'desc' ? -1 : 1));
}

/** Lignes visibles selon une RLS simplifiée (le vrai contrôle est testé sur PostgreSQL). */
function visibleRows(table, who) {
    switch (table) {
        case 'resources':
            return state.resources.filter((r) => r.is_active);
        case 'consent_texts':
            return Object.entries(consentTexts).map(([type, t]) => ({ consent_type: type, version: t.version }));
        case 'users':
            return who ? [state.users.get(who.user.id)] : null;
        case 'consents':
            return who ? state.consents.filter((c) => c.user_id === who.user.id) : null;
        default:
            return undefined;
    }
}

function log(actorId, action, metadata = {}) {
    state.accessLog.push({ id: state.accessLog.length + 1, occurred_at: new Date().toISOString(), actor_id: actorId, action, metadata });
}

const rpc = {
    grant_consent(who, body) {
        const text = consentTexts[body.p_type];
        if (!text) return { status: 400, error: ['22023', 'care-file consents are recorded with the care file'] };
        if (text.version !== body.p_version) return { status: 409, error: ['23503', 'unknown consent text version'] };
        const existing = state.consents.find(
            (c) => c.user_id === who.user.id && c.consent_type === body.p_type && c.revoked_at === null && c.text_version === body.p_version
        );
        if (existing) return { status: 200, body: existing.id };
        for (const c of state.consents) {
            if (c.user_id === who.user.id && c.consent_type === body.p_type && c.revoked_at === null)
                c.revoked_at = new Date().toISOString();
        }
        const row = {
            id: randomUUID(),
            user_id: who.user.id,
            care_file_id: null,
            consent_type: body.p_type,
            text_version: body.p_version,
            granted_at: new Date().toISOString(),
            revoked_at: null
        };
        state.consents.push(row);
        log(who.user.id, 'consent_granted', { type: body.p_type });
        return { status: 200, body: row.id };
    },
    revoke_consent(who, body) {
        const row = state.consents.find((c) => c.id === body.p_consent_id && c.user_id === who.user.id && c.revoked_at === null);
        if (!row) return { status: 403, error: ['42501', 'consent not found or not revocable by this user'] };
        if (row.consent_type === 'privacy_policy') return { status: 400, error: ['22023', 'privacy_policy cannot be revoked'] };
        row.revoked_at = new Date().toISOString();
        log(who.user.id, 'consent_revoked', { type: row.consent_type });
        return { status: 204 };
    },
    export_my_data(who) {
        log(who.user.id, 'export_requested');
        return {
            status: 200,
            body: {
                format: 'relais-export/1',
                exported_at: new Date().toISOString(),
                account: { id: who.user.id, email: who.user.email, display_name: who.user.display_name, app_role: who.user.app_role },
                consents: state.consents.filter((c) => c.user_id === who.user.id),
                access_log: state.accessLog.filter((l) => l.actor_id === who.user.id)
            }
        };
    },
    delete_my_account(who) {
        log(who.user.id, 'account_deleted');
        state.users.delete(who.user.id);
        state.consents = state.consents.filter((c) => c.user_id !== who.user.id);
        return { status: 204 };
    }
};

async function handleRest(req, res, url) {
    const who = caller(req);
    const path = url.pathname.replace('/rest/v1/', '');

    if (path.startsWith('rpc/')) {
        const fn = rpc[path.slice(4)];
        if (!fn) return pgError(res, 404, 'PGRST202', 'function not found');
        if (!who) return pgError(res, 401, '42501', 'permission denied');
        const result = fn(who, await readBody(req));
        if (result.error) return pgError(res, result.status, ...result.error);
        return result.status === 204 ? send(res, 204) : send(res, result.status, result.body);
    }

    const rows = visibleRows(path, who);
    if (rows === undefined) return pgError(res, 404, '42P01', 'relation does not exist');
    if (rows === null) return pgError(res, 401, '42501', 'permission denied');
    const filters = parseFilters(url);
    const selected = rows.filter((row) => filters.every((f) => matches(row, f)));

    if (req.method === 'GET') {
        const out = sortRows(selected, url.searchParams.get('order')).map((r) => project(r, url.searchParams.get('select')));
        if ((req.headers.accept ?? '').includes('application/vnd.pgrst.object+json')) {
            if (out.length !== 1) return pgError(res, 406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned');
            return send(res, 200, out[0]);
        }
        return send(res, 200, out);
    }

    if (req.method === 'PATCH' && path === 'users') {
        const body = await readBody(req);
        const allowed = Object.keys(body).every((k) => k === 'display_name');
        if (!allowed) return pgError(res, 401, '42501', 'permission denied');
        const name = String(body.display_name ?? '').trim();
        if (name.length < 1 || name.length > 80) return pgError(res, 400, '23514', 'check constraint');
        for (const row of selected) row.display_name = name;
        return send(res, 204);
    }

    return pgError(res, 405, 'PGRST000', 'method not allowed');
}

// ------------------------------------------------------------------------------------------- Auth
async function handleAuth(req, res, url) {
    const path = url.pathname.replace('/auth/v1', '');

    if (req.method === 'POST' && path === '/otp') {
        const body = await readBody(req);
        const email = String(body.email ?? '').toLowerCase();
        if (![...state.users.values()].some((u) => u.email === email)) {
            const id = randomUUID();
            state.users.set(id, {
                id,
                email,
                display_name: null,
                app_role: roleFor(email),
                created_at: new Date().toISOString(),
                factors: []
            });
        }
        return send(res, 200, {});
    }

    if (req.method === 'POST' && path === '/verify') {
        const body = await readBody(req);
        const user = [...state.users.values()].find((u) => u.email === String(body.email ?? '').toLowerCase());
        if (!user || body.token !== LOGIN_CODE) return authError(res, 403, 'otp_expired', 'Token has expired or is invalid');
        return send(res, 200, issueSession(user, 'aal1'));
    }

    if (req.method === 'POST' && path === '/token') {
        const body = await readBody(req);
        const entry = state.refreshTokens.get(body.refresh_token);
        const user = entry && state.users.get(entry.userId);
        if (!user) return authError(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token');
        return send(res, 200, issueSession(user, entry.aal));
    }

    const who = caller(req);
    if (!who) return authError(res, 401, 'bad_jwt', 'invalid JWT');

    if (req.method === 'GET' && path === '/user') return send(res, 200, userJson(who.user));
    if (req.method === 'POST' && path === '/logout') return send(res, 204);

    if (req.method === 'POST' && path === '/factors') {
        const body = await readBody(req);
        const factor = { id: randomUUID(), friendly_name: body.friendly_name, status: 'unverified' };
        who.user.factors.push(factor);
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
        who.user.factors = who.user.factors.filter((f) => f.id !== factorPath[1]);
        return send(res, 200, { id: factorPath[1] });
    }

    const challenge = path.match(/^\/factors\/([^/]+)\/challenge$/);
    if (req.method === 'POST' && challenge) {
        return send(res, 200, { id: randomUUID(), type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 300 });
    }

    const verify = path.match(/^\/factors\/([^/]+)\/verify$/);
    if (req.method === 'POST' && verify) {
        const body = await readBody(req);
        const factor = who.user.factors.find((f) => f.id === verify[1]);
        if (!factor || body.code !== TOTP_CODE) return authError(res, 422, 'mfa_verification_failed', 'Invalid TOTP code entered');
        factor.status = 'verified';
        return send(res, 200, issueSession(who.user, 'aal2'));
    }

    return authError(res, 404, 'not_found', 'not found');
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
            reset();
            return send(res, 204);
        }
        if (url.pathname === '/__test/state') {
            return send(res, 200, { users: [...state.users.values()], consents: state.consents, accessLog: state.accessLog });
        }
        if (url.pathname.startsWith('/auth/v1/')) return await handleAuth(req, res, url);
        if (url.pathname.startsWith('/rest/v1/')) return await handleRest(req, res, url);
        return send(res, 404, { message: 'not found' });
    } catch (error) {
        console.error('[fake-supabase]', error);
        return send(res, 500, { message: 'internal error' });
    }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[fake-supabase] http://127.0.0.1:${PORT}`));
