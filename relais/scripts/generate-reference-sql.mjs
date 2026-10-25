#!/usr/bin/env node
// Génère supabase/reference/*.sql à partir des sources JSON versionnées dans src/content/.
//   node scripts/generate-reference-sql.mjs          écrit les fichiers
//   node scripts/generate-reference-sql.mjs --check  échoue si les fichiers ne sont pas à jour (CI)
//
// Les fichiers générés sont idempotents : ils s'appliquent après les migrations, en local comme en
// production. Une version de texte de consentement déjà publiée ne peut pas changer de contenu :
// le script SQL échoue si l'empreinte diffère de celle enregistrée.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const consentTexts = JSON.parse(readFileSync(join(root, 'src/content/consent-texts.fr.json'), 'utf8'));
const resources = JSON.parse(readFileSync(join(root, 'src/content/emergency-resources.json'), 'utf8'));

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

const outputs = {
    'supabase/reference/01_consent_texts.sql': consentTextsSql(),
    'supabase/reference/02_resources.sql': resourcesSql()
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
            writeFileSync(full, content);
            console.log(`écrit ${path}`);
        }
    }
    process.exit(stale > 0 ? 1 : 0);
}
