#!/usr/bin/env node
// Essai réel des 9 fonctions Edge sous Deno (le vrai `deno-server.ts`, le vrai client Supabase), contre le
// faux Supabase branché sur la base migrée. Vérifie ce que les tests de bout en bout ne touchent pas : le
// démarrage sous Deno, les imports (npm:, src/shared), le jeton de l'utilisateur, la clé serveur, Storage
// (lecture, URL signée, effacement), CORS et le secret des fonctions planifiées.
//
// Sans clé d'IA ni de courriel : les fonctions doivent le dire proprement (« unavailable »,
// « ai_unavailable », « email_not_configured »).
//
// Lancement : npm run test:functions (= bash scripts/test-db.sh --serve node tests/deno/run-functions.mjs)
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildTextPdf } from '../support/pdf.ts';
import { PRESCRIPTION_PAGES } from '../support/documents.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const FAKE_PORT = 54398;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const APP_ORIGIN = 'http://127.0.0.1:4173';
const CRON_SECRET = 'test-cron-secret';
const FUNCTIONS = [
    'extract-document',
    'get-document-url',
    'delete-document',
    'delete-care-file',
    'explain-program',
    'draft-letter',
    'notify-support',
    'send-reminders',
    'purge-storage'
];
const port = (name) => 54410 + FUNCTIONS.indexOf(name);

const children = [];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function stopAll() {
    for (const child of children) child.kill('SIGTERM');
}
process.on('exit', stopAll);

async function waitFor(url, label, init = {}) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        try {
            await fetch(url, init);
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    throw new Error(`${label} ne démarre pas`);
}

function start(command, args, env, label) {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => {
        if (code !== null && code !== 0) console.error(`[${label}] arrêté (code ${code})`);
    });
    children.push(child);
    return child;
}

// ------------------------------------------------------------------------------------------- outils
let passed = 0;
async function check(label, work) {
    await work();
    passed += 1;
    console.log(`✓ ${label}`);
}

async function json(response) {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

/** Connexion par code (faux Auth) : jeton et identifiant. */
async function signIn(email) {
    await fetch(`${FAKE}/auth/v1/otp`, { method: 'POST', body: JSON.stringify({ email }) });
    const session = await json(
        await fetch(`${FAKE}/auth/v1/verify`, { method: 'POST', body: JSON.stringify({ email, token: '123456', type: 'email' }) })
    );
    return { token: session.access_token, id: session.user.id };
}

/** Appel PostgREST de l'application, avec le jeton de l'utilisateur. */
async function rest(user, path, body, method = 'POST') {
    const response = await fetch(`${FAKE}/rest/v1/${path}`, {
        method,
        headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/json', prefer: 'return=representation' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await json(response);
    if (!response.ok) throw new Error(`${path} : ${response.status} ${JSON.stringify(data)}`);
    return data;
}

async function call(name, body, user, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${port(name)}/`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            origin: APP_ORIGIN,
            ...(user ? { authorization: `Bearer ${user.token}` } : {}),
            ...headers
        },
        body: JSON.stringify(body ?? {})
    });
    return { status: response.status, body: await json(response), headers: response.headers };
}

const scheduled = (name, secret) => call(name, {}, null, { 'x-relais-cron-secret': secret });

async function state() {
    return json(await fetch(`${FAKE}/__test/state`));
}

const version = async (type) =>
    (await pool.query('select version from public.consent_texts where consent_type = $1 order by published_on desc limit 1', [type]))
        .rows[0].version;

/** Dossier avec consentements et un document reçu (comme l'application le fait). */
async function fileWithDocument(user, title) {
    const fileId = await rest(user, 'rpc/create_care_file', { p_title: title });
    await rest(user, 'rpc/record_file_consent', {
        p_care_file_id: fileId,
        p_type: 'care_recipient_data',
        p_version: await version('care_recipient_data'),
        p_granted_by: 'care_recipient_signed_form',
        p_legal_basis: 'person_consents'
    });
    const pdf = buildTextPdf(PRESCRIPTION_PAGES);
    const documentId = await upload(user, fileId, pdf);
    await rest(user, 'rpc/complete_document_upload', { p_document_id: documentId });
    return { fileId, documentId, pdf };
}

/** Enregistre un document et dépose son fichier, sans confirmer la réception. */
async function upload(user, fileId, bytes) {
    const documentId = await rest(user, 'rpc/register_document', {
        p_care_file_id: fileId,
        p_mime_type: 'application/pdf',
        p_size_bytes: bytes.length
    });
    const response = await fetch(`${FAKE}/storage/v1/object/documents/${fileId}/${documentId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/pdf' },
        body: bytes
    });
    assert.equal(response.status, 200, 'dépôt du fichier');
    return documentId;
}

// ------------------------------------------------------------------------------------------ démarrage
async function main() {
    const deno = execFileSync('bash', ['scripts/deno.sh', 'eval', 'console.log(Deno.execPath())'], { cwd: ROOT, encoding: 'utf8' }).trim();
    start(process.execPath, ['tests/e2e/fake-supabase.mjs'], { FAKE_SUPABASE_PORT: String(FAKE_PORT) }, 'fake-supabase');
    await waitFor(`${FAKE}/__test/health`, 'Le faux Supabase');
    await fetch(`${FAKE}/__test/reset`, { method: 'POST' });

    const env = {
        DENO_DIR: process.env.DENO_DIR ?? join(ROOT, '.tmp/deno'),
        NO_COLOR: '1',
        SUPABASE_URL: FAKE,
        SUPABASE_ANON_KEY: 'test-anon-key',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
        RELAIS_APP_ORIGINS: APP_ORIGIN,
        RELAIS_APP_URL: APP_ORIGIN,
        RELAIS_CRON_SECRET: CRON_SECRET
    };
    for (const name of FUNCTIONS) {
        start(
            deno,
            ['run', '--config', 'supabase/functions/deno.local.json', '--allow-net', '--allow-env', `supabase/functions/${name}/index.ts`],
            { ...env, DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port(name)}` },
            name
        );
    }
    for (const name of FUNCTIONS) await waitFor(`http://127.0.0.1:${port(name)}/`, name, { method: 'OPTIONS' });
    console.log(`${FUNCTIONS.length} fonctions démarrées sous Deno`);

    // ------------------------------------------------------------------------------------- scénario
    const claire = await signIn('claire@example.test');
    await rest(claire, 'rpc/grant_consent', { p_type: 'privacy_policy', p_version: await version('privacy_policy') });
    await rest(claire, 'rpc/grant_consent', { p_type: 'health_information', p_version: await version('health_information') });
    const { fileId, documentId, pdf } = await fileWithDocument(claire, 'Papa');

    await check('CORS : origine de l’application acceptée, autre origine ignorée', async () => {
        const allowed = await fetch(`http://127.0.0.1:${port('get-document-url')}/`, {
            method: 'OPTIONS',
            headers: { origin: APP_ORIGIN }
        });
        assert.equal(allowed.status, 204);
        assert.equal(allowed.headers.get('access-control-allow-origin'), APP_ORIGIN);
        const other = await fetch(`http://127.0.0.1:${port('get-document-url')}/`, {
            method: 'OPTIONS',
            headers: { origin: 'https://ailleurs.example' }
        });
        assert.equal(other.headers.get('access-control-allow-origin'), null);
    });

    await check('sans jeton : 401', async () => {
        const response = await call('get-document-url', { document_id: documentId });
        assert.deepEqual([response.status, response.body], [401, { error: 'unauthorized' }]);
    });

    await check('get-document-url : URL signée qui rend le fichier', async () => {
        const response = await call('get-document-url', { document_id: documentId }, claire);
        assert.equal(response.status, 200);
        assert.equal(response.body.expires_in, 60);
        const file = await fetch(response.body.url);
        assert.equal(file.status, 200);
        assert.deepEqual(new Uint8Array(await file.arrayBuffer()), pdf);
    });

    await check('requête invalide : 400', async () => {
        assert.deepEqual((await call('get-document-url', { document_id: 'pas-un-uuid' }, claire)).body, { error: 'bad_request' });
    });

    await check('extract-document : consentement de lecture exigé, puis IA absente signalée', async () => {
        assert.deepEqual(await call('extract-document', { document_id: documentId }, claire).then((r) => [r.status, r.body]), [
            403,
            { error: 'ai_consent_missing' }
        ]);
        await rest(claire, 'rpc/record_file_consent', {
            p_care_file_id: fileId,
            p_type: 'ai_document_processing',
            p_version: await version('ai_document_processing'),
            p_granted_by: 'care_recipient_signed_form',
            p_legal_basis: 'person_consents'
        });
        const response = await call('extract-document', { document_id: documentId }, claire);
        assert.deepEqual([response.status, response.body], [200, { status: 'failed', code: 'ai_unavailable' }]);
    });

    const programId = (await pool.query('select id from public.programs order by sort_order limit 1')).rows[0].id;
    await check('explain-program et draft-letter : sans IA, « unavailable »', async () => {
        assert.deepEqual((await call('explain-program', { program_id: programId }, claire)).body, { status: 'unavailable' });
        assert.deepEqual((await call('draft-letter', { program_id: programId, kind: 'information_request' }, claire)).body, {
            status: 'unavailable'
        });
    });

    await check('notify-support : avis réservé une fois, courriel non configuré', async () => {
        await signIn('intervenante.nadia@example.test');
        const [request] = await rest(claire, 'support_requests', {
            origin: 'button',
            contact_name: 'Claire',
            preferred_contact: 'phone',
            phone: '514 555-0101'
        });
        assert.deepEqual((await call('notify-support', { request_id: request.id }, claire)).body, { status: 'email_not_configured' });
        assert.deepEqual((await call('notify-support', { request_id: request.id }, claire)).body, { status: 'already_notified' });
    });

    await check('delete-document : document et fichier effacés', async () => {
        const response = await call('delete-document', { document_id: documentId }, claire);
        assert.deepEqual(response.body, { deleted: true, storage_cleared: true });
        const after = await state();
        assert.deepEqual([after.documents, after.storageFiles, after.deletionQueue], [[], [], []]);
    });

    await check('delete-care-file : dossier, document et fichier effacés', async () => {
        const second = await fileWithDocument(claire, 'Maman');
        const response = await call('delete-care-file', { care_file_id: second.fileId }, claire);
        assert.equal(response.status, 200);
        assert.equal(response.body.storage_cleared, true);
        assert.equal(response.body.counts.documents, 1);
        const after = await state();
        assert.deepEqual([after.storageFiles, after.storageObjects, after.deletionQueue], [[], [], []]);
    });

    await check('send-reminders : secret exigé ; sans courriel configuré, rien n’est lu', async () => {
        assert.equal((await scheduled('send-reminders', 'mauvais-secret')).status, 401);
        assert.deepEqual(await scheduled('send-reminders', CRON_SECRET).then((r) => [r.status, r.body]), [
            503,
            { error: 'email_not_configured' }
        ]);
    });

    await check('purge-storage : secret exigé ; dépôt abandonné effacé, fichier compris', async () => {
        assert.equal((await scheduled('purge-storage', 'mauvais-secret')).status, 401);
        await upload(claire, fileId, buildTextPdf([['Envoi interrompu']]));
        assert.equal((await state()).storageFiles.length, 1);
        await fetch(`${FAKE}/__test/age-documents`, { method: 'POST', body: JSON.stringify({ hours: 25 }) });
        const response = await scheduled('purge-storage', CRON_SECRET);
        assert.deepEqual([response.status, response.body], [200, { expired_uploads: 1, orphans: 0, removed: 1, failed: 0 }]);
        const after = await state();
        assert.deepEqual([after.documents, after.storageFiles, after.storageObjects, after.deletionQueue], [[], [], [], []]);
    });

    console.log(`\n${passed} vérifications sur les fonctions Edge sous Deno : OK`);
}

main()
    .then(() => {
        stopAll();
        return pool.end();
    })
    .catch(async (error) => {
        console.error(`\nÉCHEC : ${error instanceof Error ? (error.stack ?? error.message) : error}`);
        stopAll();
        await pool.end().catch(() => undefined);
        process.exit(1);
    });
