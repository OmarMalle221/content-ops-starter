#!/usr/bin/env node
// Génère supabase/reference/*.sql à partir des sources JSON versionnées dans src/content/, et les familles
// fictives de démonstration (supabase/seed/demo_families.sql).
//   node scripts/generate-reference-sql.mjs          écrit les fichiers
//   node scripts/generate-reference-sql.mjs --check  échoue si les fichiers ne sont pas à jour (CI)
//
// Les fichiers générés sont idempotents : ils s'appliquent après les migrations, en local comme en
// production. Une version de texte de consentement déjà publiée ne peut pas changer de contenu :
// le script SQL échoue si l'empreinte diffère de celle enregistrée.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const consentTexts = JSON.parse(readFileSync(join(root, 'src/content/consent-texts.fr.json'), 'utf8'));
const resources = JSON.parse(readFileSync(join(root, 'src/content/emergency-resources.json'), 'utf8'));
const programs = JSON.parse(readFileSync(join(root, 'src/content/programs.fr.json'), 'utf8'));

/** Empreinte du texte affiché (titre, résumé, sections), indépendante de la mise en forme du JSON. */
export function consentTextSha256(text) {
    const canonical = JSON.stringify({
        title: text.title,
        summary: text.summary,
        sections: text.sections.map((s) => ({ heading: s.heading, text: s.text }))
    });
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

const q = (value) => (value === null || value === undefined ? 'null' : `'${String(value).replaceAll("'", "''")}'`);

const header = (source) => `-- FICHIER GÉNÉRÉ par scripts/generate-reference-sql.mjs à partir de ${source}. Ne pas modifier.\n`;

function consentTextsSql() {
    const rows = Object.entries(consentTexts).map(
        ([type, text]) =>
            `    (${q(type)}::public.consent_type, ${q(text.version)}, ${q(consentTextSha256(text))}, ${q(text.published_on)}::date)`
    );
    return `${header('src/content/consent-texts.fr.json')}
create temporary table _expected_consent_texts (
    consent_type public.consent_type, version text, sha256 text, published_on date
) on commit drop;

insert into _expected_consent_texts values
${rows.join(',\n')};

insert into public.consent_texts (consent_type, version, sha256, published_on)
select consent_type, version, sha256, published_on from _expected_consent_texts
on conflict (consent_type, version) do nothing;

do $$
begin
    if exists (
        select 1 from public.consent_texts t
        join _expected_consent_texts e using (consent_type, version)
        where t.sha256 <> e.sha256
    ) then
        raise exception 'a published consent text changed without a new version';
    end if;
end;
$$;
`;
}

function resourcesSql() {
    const rows = resources.map(
        (r) =>
            `    (${[
                q(r.slug),
                `${q(r.category)}::public.resource_category`,
                q(r.name),
                q(r.organization),
                q(r.phone),
                q(r.sms),
                q(r.url),
                q(r.description),
                q(r.hours),
                q(r.source_url),
                String(r.sort_order)
            ].join(', ')})`
    );
    return `${header('src/content/emergency-resources.json')}
-- Fiches de départ, toutes « à vérifier ». Les modifications faites ensuite par l'admin sont conservées.
insert into public.resources
    (slug, category, name, organization, phone, sms, url, description, hours, source_url, sort_order)
values
${rows.join(',\n')}
on conflict (slug) do nothing;
`;
}

function programsSql() {
    const rows = programs.map(
        (p) =>
            `    (${[
                q(p.slug),
                q(p.name),
                q(p.organization),
                q(p.summary),
                `${q(JSON.stringify(p.criteria))}::jsonb`,
                `${q(JSON.stringify(p.required_documents))}::jsonb`,
                q(p.how_to_apply),
                q(p.official_url),
                q(p.source_label),
                String(p.sort_order)
            ].join(', ')})`
    );
    return `${header('src/content/programs.fr.json')}
-- Fiches de départ du navigateur de droits, toutes « À VÉRIFIER », sans aucun montant (contrôlé par la
-- base). Les modifications faites ensuite par l'admin sont conservées.
insert into public.programs
    (slug, name, organization, summary, criteria, required_documents, how_to_apply, official_url, source_label, sort_order)
values
${rows.join(',\n')}
on conflict (slug) do nothing;
`;
}

// ------------------------------------------------------------------------------- familles fictives
// Les résultats du questionnaire sont calculés ici par le VRAI moteur de règles : la démonstration ne
// peut pas diverger des fiches (npm run check:reference échoue sinon).
const { assessPrograms, factsFromAnswers } = await import('../src/shared/benefits/engine.ts');
const { FAMILY_A, FAMILY_B } = await import('../tests/support/families.ts');

const USERS = {
    claire: { id: 'de000000-0000-4000-8000-00000000000a', email: 'claire.demo@example.test', name: 'Claire' },
    marc: { id: 'de000000-0000-4000-8000-00000000000b', email: 'marc.demo@example.test', name: 'Marc' },
    denis: { id: 'de000000-0000-4000-8000-00000000000c', email: 'denis.demo@example.test', name: 'Denis' }
};

const actAs = (user) =>
    `select set_config('request.jwt.claims', ${q(JSON.stringify({ sub: user.id, role: 'authenticated', aal: 'aal1', email: user.email }))}, true);
set local role authenticated;`;

const welcome = (user, consents) => `${actAs(user)}
update public.users set display_name = ${q(user.name)} where id = auth.uid();
${consents.map((type) => `select public.grant_consent(${q(type)}, ${q(consentTexts[type].version)});`).join('\n')}`;

const programId = (slug) => `(select id from public.programs where slug = ${q(slug)})`;

function assessmentSql(fileVar, answers) {
    const results = assessPrograms(
        programs.map((p) => ({ ...p, id: p.slug })),
        factsFromAnswers(answers)
    ).map(
        (r) =>
            `        jsonb_build_object('program_id', ${programId(r.program.slug)}, 'match_level', ${q(r.assessment.level)}, 'match_reasons', ${q(JSON.stringify(r.assessment.reasons))}::jsonb)`
    );
    return `select public.save_benefit_assessment(:'${fileVar}', ${q(JSON.stringify(answers))}::jsonb, jsonb_build_array(
${results.join(',\n')}
    ));`;
}

const setStatus = (fileVar, slug, status, notes) =>
    `update public.care_file_programs set status = ${q(status)}, notes = ${q(notes)}
    where care_file_id = :'${fileVar}' and program_id = ${programId(slug)};`;

// Dates relatives au jour de la démonstration (heure du Québec).
const TODAY = "(now() at time zone 'America/Toronto')::date";
const dayAt = (days, time) => `((${TODAY} + ${days})::timestamp + interval '${time}') at time zone 'America/Toronto'`;

const fileConsent = (fileVar) =>
    `select public.record_file_consent(:'${fileVar}', 'care_recipient_data', ${q(consentTexts.care_recipient_data.version)}, 'care_recipient_signed_form', 'person_consents');`;

function demoFamiliesSql() {
    const { claire, marc, denis } = USERS;
    return `-- FICHIER GÉNÉRÉ par scripts/generate-reference-sql.mjs à partir de tests/support/families.ts, des fiches
-- (src/content/programs.fr.json) et du moteur de règles. Ne pas modifier.
--
-- Deux familles FICTIVES pour les démonstrations locales (faux Supabase) : JAMAIS en production. Les
-- comptes sont créés directement dans auth.users ; tout le reste passe par les fonctions de l'application
-- et la RLS, sous l'identité de chaque personne. Code de connexion du faux Supabase : 123456.
--   Famille A : ${claire.email} (aidante principale de Louise, 82 ans, à domicile)
--               ${marc.email} (son frère, lecture seule)
--   Famille B : ${denis.email} (aidant principal de Roger, 79 ans, en RPA, en attente de CHSLD)
-- Appliqué par : RELAIS_DEMO_SEED=1 bash scripts/test-db.sh --serve node tests/e2e/fake-supabase.mjs

insert into auth.users (id, email) values
    (${q(claire.id)}, ${q(claire.email)}),
    (${q(marc.id)}, ${q(marc.email)}),
    (${q(denis.id)}, ${q(denis.email)});

-- ------------------------------------------------------------------- famille A : Louise, 82 ans
${welcome(claire, ['privacy_policy', 'health_information'])}
select public.create_care_file('Maman') as file_a \\gset
${fileConsent('file_a')}
insert into public.care_recipients (care_file_id, first_name, last_name, birth_year, living_setting)
values (:'file_a', 'Louise', 'Tremblay', 1944, 'home');
insert into public.care_needs (care_file_id, autonomy_description, services_in_place, home_adaptation_needs, updated_by)
values (:'file_a', 'Autonome pour se nourrir et s’habiller. A besoin d’aide pour le bain et les courses.',
    '["domestic_help"]', 'Bain difficile d’accès.', auth.uid());
insert into public.contacts (care_file_id, kind, name, organization, phone, created_by)
values (:'file_a', 'clsc', 'Accueil soutien à domicile', 'CLSC fictif du Plateau', '555 010-0001', auth.uid());
insert into public.timeline_events (care_file_id, event_type, occurred_on, title, created_by)
values (:'file_a', 'service_change', '2026-09-08', 'Début du ménage aux deux semaines', auth.uid());
${assessmentSql('file_a', FAMILY_A)}
${setStatus('file_a', 'credit-maintien-domicile-aines', 'in_progress', 'Factures du ménage gardées dans la chemise bleue.')}
update public.program_checklist_items set is_done = true
where care_file_id = :'file_a' and label like 'Factures ou reçus%';
insert into public.tasks (care_file_id, title, assignee_id, due_on) values
    (:'file_a', 'Appeler le CLSC pour l’évaluation du soutien à domicile', auth.uid(), ${TODAY} + 1),
    (:'file_a', 'Acheter une barre d’appui pour le bain', null, ${TODAY} + 10);
insert into public.appointments (care_file_id, title, starts_at, ends_at, location, contact_id, companion_id)
select :'file_a', 'Clinique de gériatrie', ${dayAt(3, '10:30')}, ${dayAt(3, '11:30')}, 'Hôpital fictif de Montréal',
    (select id from public.contacts where care_file_id = :'file_a' limit 1), auth.uid();
insert into public.appointment_questions (appointment_id, care_file_id, question, position)
select id, care_file_id, 'Quels exercices peuvent l’aider à garder son équilibre ?', 0
from public.appointments where care_file_id = :'file_a';
insert into public.journal_entries (care_file_id, body)
values (:'file_a', 'Visite de dimanche : Maman était de bonne humeur et a bien mangé.');
select public.create_invitation(:'file_a', ${q(marc.email)}, 'family_member', 'read_only') as invite_a \\gset

${welcome(marc, ['privacy_policy'])}
select public.accept_invitation(:'invite_a');

-- ------------------------------------------------- famille B : Roger, 79 ans, en RPA, attente CHSLD
${welcome(denis, ['privacy_policy', 'health_information'])}
select public.create_care_file('Papa') as file_b \\gset
${fileConsent('file_b')}
insert into public.care_recipients
    (care_file_id, first_name, last_name, birth_year, living_setting, living_setting_since, residence_name, chsld_waitlist, chsld_waitlist_since)
values (:'file_b', 'Roger', 'Gagnon', 1947, 'rpa', '2025-03-01', 'Résidence fictive Les Érables', true, '2026-08-15');
insert into public.care_needs (care_file_id, autonomy_description, services_in_place, updated_by)
values (:'file_b', 'Se déplace avec une marchette. Oublis fréquents ; a besoin d’aide pour ses rendez-vous.',
    '["clsc_home_support"]', auth.uid());
insert into public.contacts (care_file_id, kind, name, organization, phone, created_by)
values (:'file_b', 'social_worker', 'Travailleuse sociale', 'CLSC fictif de Limoilou', '555 010-0002', auth.uid());
insert into public.timeline_events (care_file_id, event_type, occurred_on, title, created_by)
values (:'file_b', 'living_setting_change', '2026-08-15', 'Inscription sur la liste d’attente d’un CHSLD', auth.uid());
${assessmentSql('file_b', FAMILY_B)}
${setStatus('file_b', 'credit-impot-personnes-handicapees', 'in_progress', 'Formulaire T2201 remis au médecin de famille.')}
${setStatus('file_b', 'credit-maintien-domicile-aines', 'obtained', null)}
insert into public.tasks (care_file_id, title, assignee_id, due_on, care_file_program_id)
select :'file_b', 'Remplir la partie A du formulaire T2201', auth.uid(), ${TODAY} + 7, id
from public.care_file_programs where care_file_id = :'file_b' and program_id = ${programId('credit-impot-personnes-handicapees')};
insert into public.appointments (care_file_id, title, starts_at, location, companion_id)
values (:'file_b', 'Visite de la travailleuse sociale', ${dayAt(2, '14:00')}, 'Résidence fictive Les Érables', auth.uid());
insert into public.journal_entries (care_file_id, body)
values (:'file_b', 'Papa a demandé des nouvelles de sa place en CHSLD.');

reset role;
`;
}

const outputs = {
    'supabase/reference/01_consent_texts.sql': consentTextsSql(),
    'supabase/reference/02_resources.sql': resourcesSql(),
    'supabase/reference/03_programs.sql': programsSql(),
    'supabase/seed/demo_families.sql': demoFamiliesSql()
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const check = process.argv.includes('--check');
    let stale = 0;
    for (const [path, content] of Object.entries(outputs)) {
        const full = join(root, path);
        let current = null;
        try {
            current = readFileSync(full, 'utf8');
        } catch {
            current = null;
        }
        if (current === content) continue;
        if (check) {
            console.error(`${path} n'est pas à jour : lancez npm run generate:reference`);
            stale += 1;
        } else {
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, content);
            console.log(`écrit ${path}`);
        }
    }
    process.exit(stale > 0 ? 1 : 0);
}
