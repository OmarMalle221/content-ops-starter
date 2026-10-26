-- =====================================================================================================
-- Relais — tests RLS auto-vérifiants.
-- À lancer sur une base NEUVE après supabase_shim.sql, les migrations et supabase/reference
-- (voir scripts/test-db.sh). Chaque vérification lève une exception en cas d'échec.
-- =====================================================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = warning;

-- -----------------------------------------------------------------------------------------------------
-- Aides de test (security invoker : elles s'exécutent avec les privilèges du rôle courant)
-- -----------------------------------------------------------------------------------------------------
create schema tst;

create function tst.eq(label text, actual bigint, expected bigint) returns void
language plpgsql as $$
begin
    if actual is distinct from expected then
        raise exception 'FAIL: % — expected %, got %', label, expected, actual;
    end if;
end;
$$;

create function tst.ok(label text, cond boolean) returns void
language plpgsql as $$
begin
    if cond is not true then
        raise exception 'FAIL: %', label;
    end if;
end;
$$;

create function tst.cnt(q text) returns bigint
language plpgsql as $$
declare
    n bigint;
begin
    execute 'select count(*) from (' || q || ') s' into n;
    return n;
end;
$$;

-- L'instruction doit être refusée faute de privilège (grant manquant ou WITH CHECK de RLS).
create function tst.denied(label text, q text) returns void
language plpgsql as $$
begin
    begin
        execute q;
    exception when insufficient_privilege then
        return;
    end;
    raise exception 'FAIL: % — statement was allowed: %', label, q;
end;
$$;

-- L'instruction doit échouer (avec un SQLSTATE donné, si précisé).
create function tst.fails(label text, q text, expected_state text default null) returns void
language plpgsql as $$
begin
    begin
        execute q;
    exception when others then
        if expected_state is not null and sqlstate <> expected_state then
            raise exception 'FAIL: % — expected SQLSTATE %, got % (%)', label, expected_state, sqlstate, sqlerrm;
        end if;
        return;
    end;
    raise exception 'FAIL: % — statement succeeded: %', label, q;
end;
$$;

-- Nombre de lignes touchées (0 quand RLS masque les lignes visées).
create function tst.affected(q text) returns bigint
language plpgsql as $$
declare
    n bigint;
begin
    execute q;
    get diagnostics n = row_count;
    return n;
end;
$$;

grant usage on schema tst to anon, authenticated, service_role;
grant execute on all functions in schema tst to anon, authenticated, service_role;

\o
\echo '== structure'
\o /dev/null

select tst.eq('tables publiques sans RLS', (
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), 0);

-- anon : lecture seulement, et seulement des ressources et des versions de consentement.
select tst.eq('privilèges anon hors lectures publiques', (
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v')
      and (has_table_privilege('anon', c.oid, 'INSERT') or has_table_privilege('anon', c.oid, 'UPDATE')
           or has_table_privilege('anon', c.oid, 'DELETE')
           or (has_table_privilege('anon', c.oid, 'SELECT') and c.relname not in ('resources', 'consent_texts')))), 0);

-- authenticated ne peut jamais écrire directement dans les journaux ni les versions de consentement.
select tst.eq('écriture directe dans les journaux', (
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('access_log', 'ai_calls', 'consent_texts')
      and (has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'UPDATE')
           or has_table_privilege('authenticated', c.oid, 'DELETE'))), 0);

select tst.ok('consents : aucune écriture directe',
    not has_table_privilege('authenticated', 'public.consents', 'INSERT')
    and not has_table_privilege('authenticated', 'public.consents', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.consents', 'DELETE'));
select tst.eq('dossiers : aucune insertion directe (RPC seulement)', (
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('care_files', 'care_file_members', 'care_file_invitations')
      and has_table_privilege('authenticated', c.oid, 'INSERT')), 0);
select tst.ok('dossiers : propriétaire non modifiable',
    not has_column_privilege('authenticated', 'public.care_files', 'owner_id', 'UPDATE'));
select tst.ok('users : app_role non modifiable par authenticated',
    not has_column_privilege('authenticated', 'public.users', 'app_role', 'UPDATE'));

-- Chaque clé étrangère est couverte par un index.
select tst.eq('clés étrangères sans index', (
    select count(*)
    from pg_constraint con
    join pg_namespace n on n.oid = con.connamespace
    where con.contype = 'f' and n.nspname = 'public'
      and not exists (
          select 1 from pg_index i
          where i.indrelid = con.conrelid
            and (i.indkey::int2[])[0:cardinality(con.conkey) - 1] @> con.conkey
            and (i.indkey::int2[])[0:cardinality(con.conkey) - 1] <@ con.conkey)), 0);

-- Fonctions SECURITY DEFINER : search_path figé.
select tst.eq('fonctions SECURITY DEFINER sans search_path', (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')), 0);

select tst.ok('RPC non exécutables par anon',
    not has_function_privilege('anon', 'public.export_my_data()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.delete_my_account()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.revoke_consent(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.grant_consent(public.consent_type,text)', 'EXECUTE'));

\o
\echo '== données de référence'
\o /dev/null

select tst.eq('versions de consentement publiées', (select count(*) from public.consent_texts), 7);
select tst.ok('ressources d''urgence présentes',
    exists (select 1 from public.resources where slug = 'urgence-911' and category = 'emergency' and phone = '911')
    and exists (select 1 from public.resources where slug = 'ligne-9-8-8' and category = 'crisis_line'));
select tst.eq('ressources de départ marquées à vérifier', (
    select count(*) from public.resources where verification_status <> 'to_verify'), 0);

\o
\echo '== jeu d''essai'
\o /dev/null

begin;
-- A et B : membres ; W : intervenante ; X : admin. Le profil public.users est créé par déclencheur.
insert into auth.users (id, email) values
    ('a0000000-0000-4000-8000-00000000000a', 'aidante.a@example.test'),
    ('b0000000-0000-4000-8000-00000000000b', 'aidant.b@example.test'),
    ('f0000000-0000-4000-8000-00000000000f', 'intervenante.w@example.test'),
    ('90000000-0000-4000-8000-000000000009', 'admin.x@example.test');
update public.users set app_role = 'relais_worker' where id = 'f0000000-0000-4000-8000-00000000000f';
update public.users set app_role = 'admin' where id = '90000000-0000-4000-8000-000000000009';
insert into public.resources (slug, category, name, phone, is_active)
    values ('ancienne-ligne', 'info', 'Ancienne ligne', '5550000', false);
insert into public.ai_calls (user_id, purpose, provider, model, status)
    values ('a0000000-0000-4000-8000-00000000000a', 'document_extraction', 'anthropic', 'claude-sonnet-5-5', 'ok');
commit;

select tst.eq('profils créés par le déclencheur', (select count(*) from public.users), 4);

\o
\echo '== anon'
\o /dev/null

begin;
set local role anon;
select tst.eq('anon lit les ressources actives', tst.cnt('select 1 from public.resources'), 7);
select tst.eq('anon lit les versions de consentement', tst.cnt('select 1 from public.consent_texts'), 7);
select tst.denied('anon ne lit pas users', 'select 1 from public.users');
select tst.denied('anon ne lit pas consents', 'select 1 from public.consents');
select tst.denied('anon ne lit pas access_log', 'select 1 from public.access_log');
select tst.denied('anon n''exporte rien', 'select public.export_my_data()');
rollback;

\o
\echo '== profil'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('A ne voit que son profil', tst.cnt('select 1 from public.users'), 1);
select tst.eq('A change son nom', tst.affected($$update public.users set display_name = 'Louise' where id = auth.uid()$$), 1);
select tst.eq('A ne change pas le nom de B', tst.affected($$update public.users set display_name = 'X' where id = 'b0000000-0000-4000-8000-00000000000b'$$), 0);
select tst.denied('A ne peut pas se donner un rôle', $$update public.users set app_role = 'admin' where id = auth.uid()$$);
select tst.fails('nom vide refusé', $$update public.users set display_name = '  ' where id = auth.uid()$$, '23514');
select tst.denied('A ne crée pas de profil', $$insert into public.users (id) values (gen_random_uuid())$$);
commit;

\o
\echo '== consentements'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select public.grant_consent('privacy_policy', '2026-10-26');
select public.grant_consent('health_information', '2026-10-26');
select public.grant_consent('email_reminders', '2026-10-26');
select tst.ok('consentement santé actif', private.user_consent_active('health_information'));
select tst.ok('consentement évaluation non accordé', not private.user_consent_active('pilot_evaluation'));
select tst.eq('accord idempotent pour une même version',
    tst.cnt($$select public.grant_consent('privacy_policy', '2026-10-26') union select public.grant_consent('privacy_policy', '2026-10-26')$$), 1);
select tst.eq('une seule ligne par accord', tst.cnt('select 1 from public.consents'), 3);
select tst.fails('version inconnue refusée', $$select public.grant_consent('pilot_evaluation', '2020-01-01')$$, '23503');
select tst.fails('consentement de dossier refusé ici', $$select public.grant_consent('care_recipient_data', '2026-10-26')$$, '22023');
select tst.denied('pas d''insertion directe', $$insert into public.consents (user_id, consent_type, text_version) values (auth.uid(), 'pilot_evaluation', '2026-10-26')$$);
select tst.denied('pas de modification directe', $$update public.consents set revoked_at = now()$$);
select tst.denied('pas de suppression directe', $$delete from public.consents$$);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-00000000000b","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select public.grant_consent('privacy_policy', '2026-10-26');
select tst.eq('B ne voit que ses consentements', tst.cnt('select 1 from public.consents'), 1);
select tst.fails('B ne retire pas le consentement de A', $$
    select public.revoke_consent((select id from public.consents where consent_type = 'health_information' limit 1))$$, '42501');
commit;

-- Retrait par A (lecture du consentement en superutilisateur pour obtenir son identifiant).
select id as health_consent_id from public.consents
where user_id = 'a0000000-0000-4000-8000-00000000000a' and consent_type = 'health_information' \gset
select id as privacy_consent_id from public.consents
where user_id = 'a0000000-0000-4000-8000-00000000000a' and consent_type = 'privacy_policy' \gset

begin;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select public.revoke_consent(:'health_consent_id');
select tst.ok('consentement santé retiré', not private.user_consent_active('health_information'));
select tst.fails('retrait déjà fait refusé', format('select public.revoke_consent(%L)', :'health_consent_id'), '42501');
select tst.fails('politique de confidentialité non retirable', format('select public.revoke_consent(%L)', :'privacy_consent_id'), '22023');
select public.grant_consent('health_information', '2026-10-26');
select tst.ok('consentement santé accordé de nouveau', private.user_consent_active('health_information'));
select tst.eq('historique conservé', tst.cnt($$select 1 from public.consents where consent_type = 'health_information'$$), 2);
commit;

-- Nouvelle version de la politique : l'accord précédent est clos, le nouveau est actif.
insert into public.consent_texts (consent_type, version, sha256, published_on)
    values ('privacy_policy', '2026-12-01', repeat('a', 64), '2026-12-01');
begin;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select public.grant_consent('privacy_policy', '2026-12-01');
select tst.eq('renouvellement : une seule version active', tst.cnt($$
    select 1 from public.consents where consent_type = 'privacy_policy' and revoked_at is null and text_version = '2026-12-01'$$), 1);
select tst.eq('renouvellement : ancienne version close', tst.cnt($$
    select 1 from public.consents where consent_type = 'privacy_policy' and revoked_at is not null and text_version = '2026-10-26'$$), 1);
commit;
delete from public.consent_texts where version = '2026-12-01' and not exists (
    select 1 from public.consents where text_version = '2026-12-01');

\o
\echo '== journal des accès'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('A voit ses accords et retraits', tst.cnt($$select 1 from public.access_log where action in ('consent_granted', 'consent_revoked')$$), 7);
select tst.eq('A ne voit pas le journal de B', tst.cnt($$select 1 from public.access_log where actor_id <> auth.uid()$$), 0);
select tst.ok('le journal ne contient que le type de consentement', (
    select bool_and(metadata ?& array['type'] and not metadata ? 'text') from public.access_log));
select tst.denied('A n''écrit pas dans le journal', $$insert into public.access_log (action) values ('file_opened')$$);
select tst.denied('A n''efface pas le journal', $$delete from public.access_log$$);
rollback;

\o
\echo '== ressources et rôles'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select tst.eq('membre : ressources actives seulement', tst.cnt('select 1 from public.resources'), 7);
select tst.denied('membre : pas d''ajout de ressource', $$insert into public.resources (slug, category, name, phone) values ('x', 'info', 'X', '1')$$);
select tst.eq('membre : pas de modification de ressource', tst.affected($$update public.resources set name = 'X'$$), 0);
select tst.eq('membre : aucun appel IA visible', tst.cnt('select 1 from public.ai_calls'), 0);
rollback;

begin;
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000009","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select tst.ok('admin sans MFA : pas admin', not private.is_admin());
select tst.denied('admin sans MFA : pas d''ajout', $$insert into public.resources (slug, category, name, phone) values ('x', 'info', 'X', '1')$$);
select tst.eq('admin sans MFA : aucun appel IA visible', tst.cnt('select 1 from public.ai_calls'), 0);
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000009","role":"authenticated","aal":"aal2"}', true);
select tst.ok('admin avec MFA', private.is_admin());
select tst.eq('admin voit les ressources inactives', tst.cnt('select 1 from public.resources'), 8);
insert into public.resources (slug, category, name, phone) values ('repit-test', 'respite', 'Répit test', '5551234');
select tst.fails('ressource vérifiée sans date refusée', $$update public.resources set verification_status = 'verified' where slug = 'repit-test'$$, '23514');
select tst.eq('admin vérifie une ressource', tst.affected($$update public.resources set verification_status = 'verified', verified_on = current_date, verified_by = 'TS' where slug = 'repit-test'$$), 1);
select tst.eq('admin voit les métadonnées IA', tst.cnt('select 1 from public.ai_calls'), 1);
rollback;

begin;
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-00000000000f","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select tst.ok('intervenante sans MFA : pas intervenante', not private.is_relais_worker());
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-00000000000f","role":"authenticated","aal":"aal2"}', true);
select tst.ok('intervenante avec MFA', private.is_relais_worker());
select tst.ok('intervenante n''est pas admin', not private.is_admin());
rollback;

\o
\echo '== export et suppression du compte'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select public.export_my_data() as export \gset
select tst.ok('export : format', (:'export'::jsonb ->> 'format') = 'relais-export/2');
select tst.ok('export : courriel du compte', (:'export'::jsonb #>> '{account,email}') = 'aidante.a@example.test');
-- politique (2 versions), courriels, santé retiré puis accordé de nouveau = 5 lignes.
select tst.eq('export : consentements de A seulement', jsonb_array_length(:'export'::jsonb -> 'consents'), 5);
select tst.eq('export journalisé', tst.cnt($$select 1 from public.access_log where action = 'export_requested'$$), 1);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select public.delete_my_account();
commit;

select tst.eq('compte Auth supprimé', (select count(*) from auth.users where id = 'a0000000-0000-4000-8000-00000000000a'), 0);
select tst.eq('profil supprimé', (select count(*) from public.users where id = 'a0000000-0000-4000-8000-00000000000a'), 0);
select tst.eq('consentements supprimés', (select count(*) from public.consents where user_id = 'a0000000-0000-4000-8000-00000000000a'), 0);
select tst.eq('trace de la suppression', (select count(*) from public.access_log
    where actor_id = 'a0000000-0000-4000-8000-00000000000a' and action = 'account_deleted'), 1);
select tst.eq('appel IA anonymisé', (select count(*) from public.ai_calls where user_id is null), 1);
select tst.eq('B intact', (select count(*) from public.consents where user_id = 'b0000000-0000-4000-8000-00000000000b'), 1);

\o
\echo '== étape 2 : jeu d''essai des dossiers'
\o /dev/null

-- C : aidante principale ; D : accès complet ; E : coordination ; G : lecture seule ;
-- H : la personne aidée ; F : intervenante (déjà créée) ; X : admin ; O : personne extérieure.
insert into auth.users (id, email) values
    ('c0000000-0000-4000-8000-00000000000c', 'claire@example.test'),
    ('d0000000-0000-4000-8000-00000000000d', 'denis@example.test'),
    ('e0000000-0000-4000-8000-00000000000e', 'emma@example.test'),
    ('70000000-0000-4000-8000-000000000007', 'gilles@example.test'),
    ('80000000-0000-4000-8000-000000000008', 'helene@example.test'),
    ('60000000-0000-4000-8000-000000000006', 'olivier@example.test');
update public.users set display_name = 'Claire' where id = 'c0000000-0000-4000-8000-00000000000c';
update public.users set display_name = 'Denis' where id = 'd0000000-0000-4000-8000-00000000000d';

\o
\echo '== étape 2 : création du dossier et consentement de la personne aidée'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.fails('dossier refusé sans politique acceptée', $$select public.create_care_file('Maman')$$, '42501');
select public.grant_consent('privacy_policy', '2026-10-26');
select public.grant_consent('health_information', '2026-10-26');
select public.create_care_file('  Maman ') as file_id \gset
select tst.eq('C devient propriétaire', tst.cnt($$select 1 from public.care_file_members where role = 'primary_caregiver' and access_level = 'owner'$$), 1);
select tst.ok('titre nettoyé', (select title = 'Maman' from public.care_files));
select tst.denied('pas d''insertion directe de dossier', $$insert into public.care_files (owner_id, title) values (auth.uid(), 'X')$$);
select tst.denied('profil refusé sans consentement de la personne aidée',
    format($$insert into public.care_recipients (care_file_id, first_name, living_setting) values (%L, 'Louise', 'home')$$, :'file_id'));
select tst.fails('mauvais fondement : formulaire signé + tutelle',
    format($$select public.record_file_consent(%L, 'care_recipient_data', '2026-10-27', 'care_recipient_signed_form', 'tutorship')$$, :'file_id'), '22023');
select tst.fails('représentant sans nom',
    format($$select public.record_file_consent(%L, 'care_recipient_data', '2026-10-27', 'legal_representative', 'tutorship', '  ')$$, :'file_id'), '22023');
select tst.fails('l''aidante ne consent pas « dans l''application » à la place de la personne',
    format($$select public.record_file_consent(%L, 'care_recipient_data', '2026-10-27', 'care_recipient_in_app', 'person_consents')$$, :'file_id'), '42501');
select tst.fails('version inconnue', format($$select public.record_file_consent(%L, 'care_recipient_data', '2020-01-01', 'care_recipient_signed_form', 'person_consents')$$, :'file_id'), '23503');
-- Inviter est permis avant le consentement (la personne aidée peut ainsi consentir elle-même).
select public.create_invitation(:'file_id', 'Denis@Example.test', 'family_member', 'full') as tok_d \gset
select public.create_invitation(:'file_id', 'emma@example.test', 'family_member', 'coordination') as tok_e \gset
select public.create_invitation(:'file_id', 'gilles@example.test', 'family_member', 'read_only') as tok_g \gset
select public.create_invitation(:'file_id', 'helene@example.test', 'care_recipient', 'read_only') as tok_h \gset
select public.create_invitation(:'file_id', 'intervenante.w@example.test', 'relais_worker', 'read_only') as tok_f \gset
select public.create_invitation(:'file_id', 'olivier@example.test', 'relais_worker', 'read_only') as tok_o \gset
select tst.fails('personne aidée en accès complet refusée',
    format($$select public.create_invitation(%L, 'x@example.test', 'care_recipient', 'full')$$, :'file_id'), '23514');
select tst.fails('second propriétaire refusé',
    format($$select public.create_invitation(%L, 'x@example.test', 'primary_caregiver', 'owner')$$, :'file_id'), '23514');
select tst.fails('inviter une personne déjà membre',
    format($$select public.create_invitation(%L, 'claire@example.test', 'family_member', 'full')$$, :'file_id'), '23505');
select tst.eq('C voit ses invitations en attente', tst.cnt('select 1 from public.care_file_invitations'), 6);
select public.record_file_consent(:'file_id', 'care_recipient_data', '2026-10-27', 'care_recipient_signed_form', 'person_consents') as consent_id \gset
select tst.eq('consentement idempotent', tst.cnt(format($$
    select 1 from (select public.record_file_consent(%L, 'care_recipient_data', '2026-10-27', 'care_recipient_signed_form', 'person_consents') as id) s
    where s.id = %L$$, :'file_id', :'consent_id')), 1);
insert into public.care_recipients (care_file_id, first_name, living_setting, birth_year, chsld_waitlist)
    values (:'file_id', 'Louise', 'home', 1944, false);
insert into public.care_needs (care_file_id, autonomy_description, services_in_place, updated_by)
    values (:'file_id', 'Aide pour le bain', '["clsc_home_support"]', 'd0000000-0000-4000-8000-00000000000d');
select tst.ok('auteur imposé par la base', (select updated_by = auth.uid() from public.care_needs));
insert into public.contacts (care_file_id, kind, name, phone, created_by)
    values (:'file_id', 'pharmacy', 'Pharmacie du coin', '514 555-0101', 'd0000000-0000-4000-8000-00000000000d');
select tst.ok('créateur du contact imposé', (select created_by = auth.uid() from public.contacts));
select tst.fails('liste d''attente sans date incohérente', format($$update public.care_recipients set chsld_waitlist = false, chsld_waitlist_since = '2026-01-01' where care_file_id = %L$$, :'file_id'), '23514');
commit;

\o
\echo '== étape 2 : invitations'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-8000-00000000000e","role":"authenticated","email":"emma@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.fails('invitation adressée à quelqu''un d''autre', format('select public.accept_invitation(%L)', :'tok_d'), '42501');
select tst.fails('jeton inconnu', $$select public.accept_invitation('pas-un-jeton')$$, '22023');
select tst.eq('E ne voit rien avant d''accepter', tst.cnt('select 1 from public.care_files'), 0);
select public.accept_invitation(:'tok_e');
select tst.fails('invitation déjà utilisée', format('select public.accept_invitation(%L)', :'tok_e'), '22023');
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-00000000000d","role":"authenticated","email":"denis@example.test","aal":"aal1"}', true);
set local role authenticated;
select public.accept_invitation(:'tok_d');
commit;
begin;
select set_config('request.jwt.claims', '{"sub":"70000000-0000-4000-8000-000000000007","role":"authenticated","email":"gilles@example.test","aal":"aal1"}', true);
set local role authenticated;
select public.accept_invitation(:'tok_g');
commit;
begin;
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-000000000008","role":"authenticated","email":"helene@example.test","aal":"aal1"}', true);
set local role authenticated;
select public.accept_invitation(:'tok_h');
commit;
begin;
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-00000000000f","role":"authenticated","email":"intervenante.w@example.test","aal":"aal1"}', true);
set local role authenticated;
select public.accept_invitation(:'tok_f');
commit;
begin;
select set_config('request.jwt.claims', '{"sub":"60000000-0000-4000-8000-000000000006","role":"authenticated","email":"olivier@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.fails('une personne qui n''est pas intervenante ne rejoint pas comme intervenante', format('select public.accept_invitation(%L)', :'tok_o'), '42501');
commit;

-- Invitation expirée, puis invitation remplacée par une nouvelle pour la même adresse.
begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select public.create_invitation(:'file_id', 'olivier@example.test', 'family_member', 'read_only') as tok_o2 \gset
select tst.eq('l''ancienne invitation est remplacée', tst.cnt($$select 1 from public.care_file_invitations where email = 'olivier@example.test' and revoked_at is null and accepted_at is null$$), 1);
commit;
update public.care_file_invitations set expires_at = now() - interval '1 minute' where email = 'olivier@example.test' and revoked_at is null;
begin;
select set_config('request.jwt.claims', '{"sub":"60000000-0000-4000-8000-000000000006","role":"authenticated","email":"olivier@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.fails('invitation expirée', format('select public.accept_invitation(%L)', :'tok_o2'), '22023');
select tst.fails('ancienne invitation remplacée', format('select public.accept_invitation(%L)', :'tok_o'), '22023');
commit;

\o
\echo '== étape 2 : lecture et écriture par niveau d''accès'
\o /dev/null

-- D : accès complet (sans consentement santé au départ).
begin;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-00000000000d","role":"authenticated","email":"denis@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('D lit le profil', tst.cnt('select 1 from public.care_recipients'), 1);
select tst.eq('D lit la santé', tst.cnt('select 1 from public.care_needs'), 1);
select tst.eq('D lit les contacts', tst.cnt('select 1 from public.contacts'), 1);
select tst.eq('D voit les autres membres', tst.cnt('select 1 from public.care_file_members'), 6);
select tst.eq('D voit le nom de Claire', tst.cnt($$select 1 from public.users where display_name = 'Claire'$$), 1);
select tst.eq('D modifie le profil', tst.affected(format($$update public.care_recipients set residence_name = 'Les Jardins' where care_file_id = %L$$, :'file_id')), 1);
select tst.eq('D ne modifie pas la santé sans son consentement santé', tst.affected($$update public.care_needs set home_adaptation_needs = 'Barres d''appui'$$), 0);
select public.grant_consent('privacy_policy', '2026-10-26');
select public.grant_consent('health_information', '2026-10-26');
select tst.eq('D modifie la santé avec son consentement santé', tst.affected($$update public.care_needs set home_adaptation_needs = 'Barres d''appui'$$), 1);
select tst.eq('D ne voit pas les invitations', tst.cnt('select 1 from public.care_file_invitations'), 0);
select tst.fails('D n''invite pas', format($$select public.create_invitation(%L, 'x@example.test', 'family_member', 'full')$$, :'file_id'), '42501');
select tst.eq('D ne change pas les niveaux', tst.affected($$update public.care_file_members set access_level = 'read_only' where role = 'family_member'$$), 0);
select tst.eq('D ne renomme pas le dossier', tst.affected($$update public.care_files set title = 'X'$$), 0);
select tst.eq('D ne voit pas le journal du dossier', tst.cnt($$select 1 from public.access_log where actor_id <> auth.uid()$$), 0);
select tst.fails('D n''exporte pas le dossier', format('select public.export_care_file(%L)', :'file_id'), '42501');
select tst.fails('D ne supprime pas le dossier', format('select public.delete_care_file(%L)', :'file_id'), '42501');
commit;

-- E : coordination.
begin;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-8000-00000000000e","role":"authenticated","email":"emma@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('E lit le profil', tst.cnt('select 1 from public.care_recipients'), 1);
select tst.eq('E ne lit pas la santé', tst.cnt('select 1 from public.care_needs'), 0);
select tst.eq('E lit les contacts', tst.cnt('select 1 from public.contacts'), 1);
insert into public.contacts (care_file_id, kind, name) values (:'file_id', 'clsc', 'CLSC du quartier');
select tst.eq('E ne modifie pas le profil', tst.affected($$update public.care_recipients set first_name = 'X'$$), 0);
select tst.denied('E n''écrit pas la santé', format($$insert into public.care_needs (care_file_id) values (%L) on conflict do nothing$$, :'file_id'));
select public.log_access(:'file_id', 'file_opened', 'care_files', :'file_id');
select tst.fails('action de journal réservée au serveur', format($$select public.log_access(%L, 'care_file_deleted')$$, :'file_id'), '22023');
commit;

-- G : lecture seule.
begin;
select set_config('request.jwt.claims', '{"sub":"70000000-0000-4000-8000-000000000007","role":"authenticated","email":"gilles@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('G lit la santé', tst.cnt('select 1 from public.care_needs'), 1);
select tst.denied('G n''ajoute pas de contact', format($$insert into public.contacts (care_file_id, kind, name) values (%L, 'other', 'X')$$, :'file_id'));
select tst.eq('G ne modifie rien', tst.affected($$update public.contacts set name = 'X'$$), 0);
commit;

-- F : intervenante, seulement avec la MFA.
begin;
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-00000000000f","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('intervenante sans MFA : rien', tst.cnt('select 1 from public.care_files') + tst.cnt('select 1 from public.care_needs'), 0);
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-00000000000f","role":"authenticated","aal":"aal2"}', true);
select tst.eq('intervenante avec MFA : dossier confié lisible', tst.cnt('select 1 from public.care_needs'), 1);
select tst.eq('intervenante en lecture seule : aucune écriture', tst.affected($$update public.contacts set name = 'X'$$), 0);
commit;

-- X : admin avec MFA ; O : personne extérieure.
begin;
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000009","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select tst.eq('admin : aucun dossier', tst.cnt('select 1 from public.care_files') + tst.cnt('select 1 from public.care_recipients')
    + tst.cnt('select 1 from public.contacts') + tst.cnt('select 1 from public.care_file_members'), 0);
select tst.eq('admin : pas de journal de dossier', tst.cnt('select 1 from public.access_log where care_file_id is not null'), 0);
commit;
begin;
select set_config('request.jwt.claims', '{"sub":"60000000-0000-4000-8000-000000000006","role":"authenticated","email":"olivier@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('extérieur : rien', tst.cnt('select 1 from public.care_files') + tst.cnt('select 1 from public.care_needs')
    + tst.cnt('select 1 from public.consents where care_file_id is not null') + tst.cnt($$select 1 from public.users where display_name is not null$$), 0);
select tst.fails('extérieur : pas de journalisation', format($$select public.log_access(%L, 'file_opened')$$, :'file_id'), '42501');
select tst.fails('extérieur : pas d''export', format('select public.export_care_file(%L)', :'file_id'), '42501');
commit;

\o
\echo '== étape 2 : consentement de la personne aidée'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-000000000008","role":"authenticated","email":"helene@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('la personne aidée lit son dossier', tst.cnt('select 1 from public.care_needs'), 1);
select tst.eq('la personne aidée voit son consentement', tst.cnt('select 1 from public.consents where care_file_id is not null and revoked_at is null'), 1);
select public.record_file_consent(:'file_id', 'care_recipient_data', '2026-10-27', 'care_recipient_in_app', 'person_consents');
select tst.eq('son accord remplace le formulaire', tst.cnt($$select 1 from public.consents where care_file_id is not null and revoked_at is null and granted_by = 'care_recipient_in_app'$$), 1);
select public.revoke_consent((select id from public.consents where care_file_id is not null and revoked_at is null));
select tst.ok('consentement retiré par la personne aidée', not private.file_consent_active(:'file_id', 'care_recipient_data'));
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.denied('plus aucun ajout après le retrait', format($$insert into public.contacts (care_file_id, kind, name) values (%L, 'other', 'X')$$, :'file_id'));
select tst.eq('les lectures restent possibles (export, suppression)', tst.cnt('select 1 from public.contacts'), 2);
select tst.fails('l''aidante ne rétablit pas par formulaire un retrait de la personne',
    format($$select public.record_file_consent(%L, 'care_recipient_data', '2026-10-27', 'care_recipient_signed_form', 'person_consents')$$, :'file_id'), '42501');
select public.record_file_consent(:'file_id', 'care_recipient_data', '2026-10-27', 'legal_representative', 'homologated_protection_mandate', 'Me Tremblay (mandataire)');
select tst.ok('un représentant légal peut consentir', private.file_consent_active(:'file_id', 'care_recipient_data'));
commit;

\o
\echo '== étape 2 : gestion des membres et journal du dossier'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('C change le niveau de E', tst.affected($$update public.care_file_members set access_level = 'full' where user_id = 'e0000000-0000-4000-8000-00000000000e'$$), 1);
select tst.denied('aucun second propriétaire', $$update public.care_file_members set access_level = 'owner' where user_id = 'e0000000-0000-4000-8000-00000000000e'$$);
select tst.fails('la personne aidée reste en lecture seule', $$update public.care_file_members set access_level = 'full' where user_id = '80000000-0000-4000-8000-000000000008'$$, '23514');
select tst.eq('C ne se retire pas son propre rôle', tst.affected($$update public.care_file_members set access_level = 'full' where user_id = auth.uid()$$), 0);
select tst.eq('C retire G', tst.affected($$delete from public.care_file_members where user_id = '70000000-0000-4000-8000-000000000007'$$), 1);
select tst.eq('C ne quitte pas son propre dossier', tst.affected($$delete from public.care_file_members where user_id = auth.uid()$$), 0);
select tst.ok('journal : arrivées, changement de niveau, retrait', (
    select count(*) filter (where action = 'member_joined') = 6
       and count(*) filter (where action = 'member_access_changed') = 1
       and count(*) filter (where action = 'member_removed') = 1
       and count(*) filter (where action = 'file_opened') = 1
    from public.access_log where care_file_id = :'file_id'));
select tst.fails('suppression du compte refusée tant qu''elle est propriétaire', 'select public.delete_my_account()', '55006');
select public.export_care_file(:'file_id') as file_export \gset
select tst.ok('export : format et contenu', (:'file_export'::jsonb ->> 'format') = 'relais-dossier/4'
    and (:'file_export'::jsonb #>> '{care_recipient,first_name}') = 'Louise'
    and jsonb_array_length(:'file_export'::jsonb -> 'contacts') = 2
    and jsonb_array_length(:'file_export'::jsonb -> 'members') = 5);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-00000000000d","role":"authenticated","email":"denis@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('D quitte le dossier', tst.affected('delete from public.care_file_members where user_id = auth.uid()'), 1);
select tst.eq('D ne voit plus rien', tst.cnt('select 1 from public.care_files'), 0);
commit;

\o
\echo '== étape 2 : suppression du dossier'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select public.delete_care_file(:'file_id');
commit;

select tst.eq('tout est effacé', (
    (select count(*) from public.care_files where id = :'file_id')
    + (select count(*) from public.care_recipients where care_file_id = :'file_id')
    + (select count(*) from public.care_needs where care_file_id = :'file_id')
    + (select count(*) from public.contacts where care_file_id = :'file_id')
    + (select count(*) from public.care_file_members where care_file_id = :'file_id')
    + (select count(*) from public.care_file_invitations where care_file_id = :'file_id')
    + (select count(*) from public.consents where care_file_id = :'file_id')), 0);
select tst.eq('le journal ne garde que la trace de la suppression', (
    select count(*) from public.access_log where care_file_id = :'file_id'), 1);
select tst.ok('trace : acteur et nombres seulement', (
    select action = 'care_file_deleted' and actor_id = 'c0000000-0000-4000-8000-00000000000c'
       and metadata ? 'contacts' and not metadata ? 'first_name'
    from public.access_log where care_file_id = :'file_id'));
select tst.eq('les consentements personnels restent', (
    select count(*) from public.consents where user_id = 'c0000000-0000-4000-8000-00000000000c' and care_file_id is null), 2);

\o
\echo '== étape 3 : structure des documents'
\o /dev/null

select tst.eq('documents et extractions : écritures par RPC seulement', (
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('documents', 'document_extractions')
      and (has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'UPDATE')
           or has_table_privilege('authenticated', c.oid, 'DELETE'))), 0);
select tst.ok('médicaments : aucun ajout direct', not has_table_privilege('authenticated', 'public.medication_mentions', 'INSERT'));
select tst.ok('file d''effacement Storage : invisible aux utilisateurs',
    not has_table_privilege('authenticated', 'public.storage_deletion_queue', 'SELECT'));
select tst.ok('chronologie : source non modifiable',
    not has_column_privilege('authenticated', 'public.timeline_events', 'source_document_id', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.timeline_events', 'source_type', 'UPDATE'));
select tst.ok('fonctions serveur réservées au rôle service',
    not has_function_privilege('authenticated', 'public.save_document_extraction(uuid,uuid,jsonb,text,text,boolean,text[],text[],integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.fail_document_extraction(uuid,text,integer)', 'EXECUTE'));
select tst.ok('bucket privé avec limites', (
    select not public and file_size_limit = 20971520 and allowed_mime_types @> array['application/pdf']
    from storage.buckets where id = 'documents'));

\o
\echo '== étape 3 : jeu d''essai (dossier « Papa »)'
\o /dev/null

\set file2 'f2000000-0000-4000-8000-000000000002'
-- C : aidante principale ; D : accès complet ; E : coordination ; G : lecture seule ; H : personne aidée ;
-- F : intervenante (lecture seule) ; O : personne extérieure.
insert into public.care_files (id, owner_id, title) values (:'file2', 'c0000000-0000-4000-8000-00000000000c', 'Papa');
insert into public.care_file_members (care_file_id, user_id, role, access_level) values
    (:'file2', 'd0000000-0000-4000-8000-00000000000d', 'family_member', 'full'),
    (:'file2', 'e0000000-0000-4000-8000-00000000000e', 'family_member', 'coordination'),
    (:'file2', '70000000-0000-4000-8000-000000000007', 'family_member', 'read_only'),
    (:'file2', '80000000-0000-4000-8000-000000000008', 'care_recipient', 'read_only'),
    (:'file2', 'f0000000-0000-4000-8000-00000000000f', 'relais_worker', 'read_only');
insert into public.consents (user_id, care_file_id, consent_type, text_version, granted_by, legal_basis)
    values ('c0000000-0000-4000-8000-00000000000c', :'file2', 'care_recipient_data', '2026-10-27',
            'care_recipient_signed_form', 'person_consents');
insert into public.care_recipients (care_file_id, first_name, last_name, living_setting)
    values (:'file2', 'Roger', 'Gagnon', 'rpa');
insert into public.contacts (care_file_id, kind, name, address) values
    (:'file2', 'physician', 'Dre Isabelle Fortin', '1200, rue Sherbrooke Est, Montréal'),
    (:'file2', 'pharmacy', 'Pharmacie du coin', null);

\o
\echo '== étape 3 : téléversement et lecture automatique'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.fails('type de fichier refusé', format($$select public.register_document(%L, 'text/html', 100)$$, :'file2'), '23514');
select tst.fails('fichier trop gros refusé', format($$select public.register_document(%L, 'application/pdf', 30000000)$$, :'file2'), '23514');
select public.register_document(:'file2', 'application/pdf', 120000) as doc1 \gset
select tst.ok('chemin imposé par la base', (select storage_path = :'file2' || '/' || :'doc1' from public.documents where id = :'doc1'));
select tst.fails('confirmation impossible avant le téléversement', format($$select public.complete_document_upload(%L)$$, :'doc1'), 'RLA02');
select tst.denied('dépôt refusé hors du chemin prévu',
    format($$insert into storage.objects (bucket_id, name, owner) values ('documents', %L, auth.uid())$$, :'file2' || '/' || gen_random_uuid()));
select tst.denied('dépôt refusé dans un autre bucket',
    format($$insert into storage.objects (bucket_id, name, owner) values ('avatars', %L, auth.uid())$$, :'file2' || '/' || :'doc1'));
insert into storage.objects (bucket_id, name, owner) values ('documents', :'file2' || '/' || :'doc1', auth.uid());
select public.complete_document_upload(:'doc1');
select tst.ok('document téléversé', (select status = 'uploaded' from public.documents where id = :'doc1'));
select tst.denied('aucun second dépôt une fois le document reçu',
    format($$insert into storage.objects (bucket_id, name, owner) values ('documents', %L, auth.uid())$$, :'file2' || '/' || :'doc1' || 'x'));
select tst.eq('aucune lecture directe du fichier', tst.cnt('select 1 from storage.objects'), 0);
select tst.eq('aucun effacement direct du fichier', tst.affected('delete from storage.objects'), 0);
select tst.fails('lecture automatique refusée sans consentement', format($$select public.start_document_extraction(%L)$$, :'doc1'), 'RLA01');
select public.record_file_consent(:'file2', 'ai_document_processing', '2026-10-28', 'care_recipient_signed_form', 'person_consents');
select public.start_document_extraction(:'doc1') as started \gset
select tst.ok('dictionnaire : personne aidée, médecin et adresse ; pas les organismes',
    (:'started'::jsonb -> 'persons') ?& array['Roger', 'Gagnon', 'Dre Isabelle Fortin', 'Claire']
    and not ((:'started'::jsonb -> 'persons') ? 'Pharmacie du coin')
    and (:'started'::jsonb -> 'addresses') ? '1200, rue Sherbrooke Est, Montréal'
    and (:'started'::jsonb ->> 'storage_path') = :'file2' || '/' || :'doc1');
select tst.ok('document en lecture', (select status = 'processing' from public.documents where id = :'doc1'));
select tst.fails('pas de double lecture simultanée', format($$select public.start_document_extraction(%L)$$, :'doc1'), 'RLA02');
select tst.fails('écriture du brouillon réservée au serveur',
    format($$select public.save_document_extraction(%L, auth.uid(), '{}', '1', 'clear', false, '{}', '{}', 1)$$, :'doc1'), '42501');
select tst.denied('pas d''ajout direct de document', format($$insert into public.documents (care_file_id, mime_type, size_bytes) values (%L, 'application/pdf', 1)$$, :'file2'));
select tst.denied('pas de modification directe de document', $$update public.documents set title = 'X'$$);
select tst.denied('pas de médicament ajouté directement',
    format($$insert into public.medication_mentions (care_file_id, source_document_id, name_as_written) values (%L, %L, 'X')$$, :'file2', :'doc1'));
commit;

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select public.save_document_extraction(:'doc1', 'c0000000-0000-4000-8000-00000000000c',
    '{"schema_version":"1","plain_summary":"Résumé de départ."}', '1', 'clear', false, '{}', '{}', 3) as extraction1 \gset
select tst.ok('brouillon prêt', (select status = 'draft_ready' and page_count = 3 from public.documents where id = :'doc1'));
select tst.ok('document supprimé pendant la lecture : rien n''est gardé',
    public.save_document_extraction(gen_random_uuid(), null, '{}', '1', 'clear', false, '{}', '{}', 1) is null);
commit;

\o
\echo '== étape 3 : accès par niveau'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-8000-00000000000e","role":"authenticated","email":"emma@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('coordination : aucun document visible', tst.cnt('select 1 from public.documents'), 0);
select tst.eq('coordination : aucune extraction visible', tst.cnt('select 1 from public.document_extractions'), 0);
select tst.fails('coordination : pas d''ajout de document', format($$select public.register_document(%L, 'application/pdf', 10)$$, :'file2'), '42501');
select tst.fails('coordination : pas de téléchargement', format($$select public.authorize_document_download(%L)$$, :'doc1'), '42501');
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"70000000-0000-4000-8000-000000000007","role":"authenticated","email":"gilles@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('lecture seule : voit le document', tst.cnt('select 1 from public.documents'), 1);
select tst.eq('lecture seule : voit le brouillon', tst.cnt('select 1 from public.document_extractions'), 1);
select tst.ok('lecture seule : peut télécharger', public.authorize_document_download(:'doc1') = :'file2' || '/' || :'doc1');
select tst.fails('lecture seule : ne confirme pas', format($$select public.confirm_document(%L, %L, '{}')$$, :'doc1', :'extraction1'), '42501');
select tst.fails('lecture seule : ne supprime pas', format($$select public.delete_document(%L)$$, :'doc1'), '42501');
select tst.fails('lecture seule : n''ajoute pas', format($$select public.register_document(%L, 'application/pdf', 10)$$, :'file2'), '42501');
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-00000000000f","role":"authenticated","email":"intervenante.w@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('intervenante sans MFA : aucun document', tst.cnt('select 1 from public.documents'), 0);
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-00000000000f","role":"authenticated","email":"intervenante.w@example.test","aal":"aal2"}', true);
select tst.eq('intervenante avec MFA, dossier confié : voit le document', tst.cnt('select 1 from public.documents'), 1);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"60000000-0000-4000-8000-000000000006","role":"authenticated","email":"olivier@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('personne extérieure : aucun document', tst.cnt('select 1 from public.documents'), 0);
select tst.fails('personne extérieure : pas de téléchargement', format($$select public.authorize_document_download(%L)$$, :'doc1'), '42501');
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-000000000008","role":"authenticated","email":"helene@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('personne aidée : voit son document', tst.cnt('select 1 from public.documents'), 1);
select tst.fails('personne aidée : ne confirme pas', format($$select public.confirm_document(%L, %L, '{}')$$, :'doc1', :'extraction1'), '42501');
commit;

\o
\echo '== étape 3 : confirmation, saisie à la main, rejet, échec'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-00000000000d","role":"authenticated","email":"denis@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.fails('confirmation : contenu invalide refusé',
    format($$select public.confirm_document(%L, %L, '{"medications": {}}')$$, :'doc1', :'extraction1'), '22023');
select tst.fails('confirmation : médicament sans nom refusé',
    format($$select public.confirm_document(%L, %L, '{"medications": [{"name": " "}]}')$$, :'doc1', :'extraction1'), '23514');
select public.confirm_document(:'doc1', :'extraction1', $json${
    "document": {"title": "Résumé de départ", "doc_type": "discharge_summary", "doc_date": "2026-10-03",
                 "author": "Dre Isabelle Fortin, gériatre", "needs_review": false},
    "summary": "Résumé de départ de l'hôpital.",
    "medications": [{"name": "Metformine", "dosage": "500 mg", "frequency": "2 fois par jour"},
                    {"name": "Ramipril", "dosage": "5 mg", "frequency": null}],
    "timeline_events": [{"event_type": "discharge", "occurred_on": "2026-10-03", "title": "Retour à la résidence", "description": null}],
    "action_items": [{"text": "Prise de sang dans 2 semaines"}]
}$json$::jsonb);
select tst.ok('document confirmé avec ses champs', (
    select status = 'confirmed' and title = 'Résumé de départ' and doc_type = 'discharge_summary'
       and doc_date = '2026-10-03' and author = 'Dre Isabelle Fortin, gériatre'
    from public.documents where id = :'doc1'));
select tst.ok('extraction confirmée par D', (
    select status = 'confirmed' and confirmed_by = auth.uid() and confirmed_data ? 'action_items'
    from public.document_extractions where id = :'extraction1'));
select tst.eq('médicaments tels qu''écrits, reliés au document', tst.cnt(format($$
    select 1 from public.medication_mentions where source_document_id = %L and document_date = '2026-10-03' and created_by = auth.uid()$$, :'doc1')), 2);
select tst.eq('événement relié à sa source', tst.cnt(format($$
    select 1 from public.timeline_events where source_type = 'document' and source_document_id = %L$$, :'doc1')), 1);
select tst.fails('pas de seconde confirmation', format($$select public.confirm_document(%L, %L, '{}')$$, :'doc1', :'extraction1'), 'RLA02');
insert into public.timeline_events (care_file_id, event_type, occurred_on, title)
    values (:'file2', 'living_setting_change', '2026-09-01', 'Arrivée en résidence');
select tst.denied('un ajout direct est toujours « à la main »',
    format($$insert into public.timeline_events (care_file_id, event_type, occurred_on, title, source_type, source_document_id)
             values (%L, 'other', '2026-09-02', 'X', 'document', %L)$$, :'file2', :'doc1'));
select tst.eq('D corrige un titre', tst.affected($$update public.timeline_events set title = 'Arrivée à la résidence' where source_type = 'manual'$$), 1);
select tst.denied('la source d''un événement ne change pas', format($$update public.timeline_events set source_document_id = %L$$, :'doc1'));
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
-- Photo saisie à la main (sans lecture automatique).
select public.register_document(:'file2', 'image/jpeg', 50000) as doc2 \gset
insert into storage.objects (bucket_id, name, owner) values ('documents', :'file2' || '/' || :'doc2', auth.uid());
select public.complete_document_upload(:'doc2');
select public.confirm_document(:'doc2', null, $json${
    "document": {"title": "Ordonnance", "doc_type": "prescription", "doc_date": "2026-10-10", "author": null, "needs_review": true},
    "summary": null, "medications": [{"name": "Atorvastatine", "dosage": "20 mg", "frequency": "le soir"}],
    "timeline_events": [{"event_type": "appointment", "occurred_on": "2026-11-12", "title": "Rendez-vous en gériatrie", "description": "Hôpital, 10 h"}],
    "action_items": []
}$json$::jsonb);
select tst.ok('saisie à la main enregistrée', (
    select e.method = 'manual' and e.status = 'confirmed' and d.needs_review
    from public.document_extractions e join public.documents d on d.id = e.document_id where d.id = :'doc2'));
-- Brouillon rejeté, puis échec de lecture.
select public.register_document(:'file2', 'application/pdf', 9000) as doc3 \gset
insert into storage.objects (bucket_id, name, owner) values ('documents', :'file2' || '/' || :'doc3', auth.uid());
select public.complete_document_upload(:'doc3');
select public.start_document_extraction(:'doc3');
commit;

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select public.save_document_extraction(:'doc3', 'c0000000-0000-4000-8000-00000000000c', '{}', '1', 'handwritten', true,
    '{handwriting}', '{advice_language}', 1) as extraction3 \gset
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select public.discard_extraction(:'extraction3');
select tst.ok('brouillon rejeté : effacé, document à relire', (
    select d.status = 'uploaded' from public.documents d where d.id = :'doc3')
    and not exists (select 1 from public.document_extractions where document_id = :'doc3'));
select public.start_document_extraction(:'doc3');
commit;

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select tst.fails('code d''échec inconnu refusé', format($$select public.fail_document_extraction(%L, 'boom')$$, :'doc3'), '23514');
select public.fail_document_extraction(:'doc3', 'no_text_layer', 2);
select tst.ok('échec noté par un code', (select status = 'failed' and extraction_error = 'no_text_layer' from public.documents where id = :'doc3'));
commit;

-- La personne aidée retire la lecture automatique : plus aucune nouvelle lecture.
begin;
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-000000000008","role":"authenticated","email":"helene@example.test","aal":"aal1"}', true);
set local role authenticated;
select public.revoke_consent((select id from public.consents
    where care_file_id = :'file2' and consent_type = 'ai_document_processing' and revoked_at is null));
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.fails('lecture automatique refusée après le retrait', format($$select public.start_document_extraction(%L)$$, :'doc3'), 'RLA01');
select tst.ok('journal : dépôts, consultation, confirmations', (
    select count(*) filter (where action = 'document_uploaded') = 3
       and count(*) filter (where action = 'document_viewed') = 1
       and count(*) filter (where action = 'extraction_confirmed') = 2
    from public.access_log where care_file_id = :'file2'));
select tst.ok('journal : aucun contenu', not exists (
    select 1 from public.access_log where care_file_id = :'file2' and metadata::text ~* 'metformine|gériatre|roger'));
commit;

\o
\echo '== étape 3 : suppression d''un document, export et suppression du dossier'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.ok('suppression du document : chemin à effacer', public.delete_document(:'doc2') = :'file2' || '/' || :'doc2');
select tst.eq('ses médicaments et événements partent avec lui', (
    (select count(*) from public.medication_mentions where source_document_id = :'doc2')
    + (select count(*) from public.timeline_events where source_document_id = :'doc2')
    + (select count(*) from public.document_extractions where document_id = :'doc2')), 0);
select public.export_care_file(:'file2') as export2 \gset
select tst.ok('export : documents, médicaments et chronologie', (:'export2'::jsonb ->> 'format') = 'relais-dossier/4'
    and jsonb_array_length(:'export2'::jsonb -> 'documents') = 2
    and jsonb_array_length(:'export2'::jsonb -> 'medications_as_written') = 2
    and jsonb_array_length(:'export2'::jsonb -> 'timeline_events') = 2
    and (:'export2'::jsonb #>> '{documents,0,confirmed,summary}') = 'Résumé de départ de l''hôpital.');
select public.delete_care_file(:'file2') as deleted2 \gset
select tst.ok('nombres de la suppression', (:'deleted2'::jsonb ->> 'documents')::int = 2
    and (:'deleted2'::jsonb ->> 'medications')::int = 2);
commit;

select tst.eq('dossier « Papa » entièrement effacé', (
    (select count(*) from public.documents where care_file_id = :'file2')
    + (select count(*) from public.document_extractions where care_file_id = :'file2')
    + (select count(*) from public.medication_mentions where care_file_id = :'file2')
    + (select count(*) from public.timeline_events where care_file_id = :'file2')
    + (select count(*) from public.consents where care_file_id = :'file2')), 0);
select tst.eq('tous les fichiers du dossier sont à effacer de Storage', (
    select count(*) from public.storage_deletion_queue where object_path like :'file2' || '/%'), 3);
select tst.ok('le journal ne garde que la trace', (
    select count(*) = 1 and bool_and(action = 'care_file_deleted') from public.access_log where care_file_id = :'file2'));

\o
\echo '== étape 4 : catalogue des programmes'
\o /dev/null

select tst.eq('8 fiches de départ, toutes à vérifier', (select count(*) from public.programs where verification_status = 'to_verify'), 8);
select tst.eq('aucun montant ni pourcentage dans les fiches', (
    select count(*) from public.programs
    where (name || summary || coalesce(how_to_apply, '') || required_documents::text) ~ '(\$|%|dollar)'), 0);
select tst.ok('cache IA : écriture réservée au serveur',
    not has_function_privilege('authenticated', 'public.save_program_explanation(uuid,integer,jsonb,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.save_program_letter_template(uuid,integer,text,text,text)', 'EXECUTE')
    and not has_table_privilege('authenticated', 'public.program_explanations', 'INSERT'));
select tst.ok('programmes du dossier : ajout par RPC, niveau de correspondance non modifiable',
    not has_table_privilege('authenticated', 'public.care_file_programs', 'INSERT')
    and not has_column_privilege('authenticated', 'public.care_file_programs', 'match_level', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.care_file_programs', 'requested_at', 'UPDATE'));

begin;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('membre : fiches actives visibles', tst.cnt('select 1 from public.programs'), 8);
select tst.denied('membre : pas d''ajout de fiche',
    $$insert into public.programs (slug, name, organization, summary, criteria, source_label) values ('x', 'X', 'X', 'X', '{}', 'X')$$);
select tst.eq('membre : pas de modification de fiche', tst.affected($$update public.programs set name = 'X'$$), 0);
select tst.ok('fiche pour l''IA : aucune donnée personnelle, version incluse', (
    select (j ? 'version') and not (j ? 'care_file_id') and (j ->> 'cached_explanation') is null
    from (select public.program_for_ai((select id from public.programs where slug = 'credit-impot-personnes-handicapees')) as j) s));
rollback;

begin;
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000009","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select tst.denied('admin sans MFA : pas d''ajout de fiche',
    $$insert into public.programs (slug, name, organization, summary, criteria, source_label) values ('x', 'X', 'X', 'X', '{}', 'X')$$);
rollback;

begin;
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000009","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
insert into public.programs (slug, name, organization, summary, criteria, source_label)
    values ('programme-test', 'Programme test', 'Organisme', 'Résumé factuel.', '{"all": []}', 'Organisme — page du programme');
select tst.fails('montant refusé', $$update public.programs set summary = 'Jusqu''à 1 494 $ par année.' where slug = 'programme-test'$$, '23514');
select tst.fails('pourcentage refusé', $$update public.programs set summary = '39 % des dépenses.' where slug = 'programme-test'$$, '23514');
select tst.fails('montant refusé dans les pièces à fournir',
    $$update public.programs set required_documents = '["Reçus de plus de 100 dollars"]' where slug = 'programme-test'$$, '23514');
select tst.fails('fiche vérifiée sans lien officiel refusée',
    $$update public.programs set verification_status = 'verified', verified_on = current_date - 2, verified_by = 'AB' where slug = 'programme-test'$$, '23514');
update public.programs set official_url = 'https://example.org/programme' where slug = 'programme-test';
update public.programs set verification_status = 'verified', verified_on = current_date - 2, verified_by = 'AB'
    where slug = 'programme-test';
select tst.ok('fiche vérifiée avec lien, date et auteur ; nouvelle version', (
    select verification_status = 'verified' and version = 2 from public.programs where slug = 'programme-test'));
update public.programs set summary = 'Résumé modifié.' where slug = 'programme-test';
select tst.ok('modifiée sans nouvelle vérification : redevient à vérifier', (
    select verification_status = 'to_verify' and verified_on is null and verified_by is null and version = 3
    from public.programs where slug = 'programme-test'));
update public.programs set is_active = false where slug = 'programme-test';
select tst.ok('désactivation : même version', (select version = 3 from public.programs where slug = 'programme-test'));
update public.programs set summary = 'Résumé corrigé.', official_url = 'https://example.org/programme',
    verification_status = 'verified', verified_on = current_date, verified_by = 'CD' where slug = 'programme-test';
update public.programs set how_to_apply = 'Par téléphone.' where slug = 'programme-test';
select tst.ok('une vérification datée du jour couvre les corrections du jour', (
    select verification_status = 'verified' and verified_by = 'CD' and version = 5 from public.programs where slug = 'programme-test'));
update public.resources set verification_status = 'verified', verified_on = current_date - 2, verified_by = 'TS' where slug = 'info-aidant';
update public.resources set phone = '1 855 000-0000' where slug = 'info-aidant';
select tst.ok('ressource modifiée sans nouvelle vérification : redevient à vérifier', (
    select verification_status = 'to_verify' and verified_on is null from public.resources where slug = 'info-aidant'));
rollback;

\o
\echo '== étape 4 : programmes du dossier (« Grand-maman »)'
\o /dev/null

\set file3 'f3000000-0000-4000-8000-000000000003'
insert into public.care_files (id, owner_id, title) values (:'file3', 'c0000000-0000-4000-8000-00000000000c', 'Grand-maman');
insert into public.care_file_members (care_file_id, user_id, role, access_level) values
    (:'file3', 'd0000000-0000-4000-8000-00000000000d', 'family_member', 'full'),
    (:'file3', 'e0000000-0000-4000-8000-00000000000e', 'family_member', 'coordination'),
    (:'file3', '70000000-0000-4000-8000-000000000007', 'family_member', 'read_only');
insert into public.consents (user_id, care_file_id, consent_type, text_version, granted_by, legal_basis)
    values ('c0000000-0000-4000-8000-00000000000c', :'file3', 'care_recipient_data', '2026-10-27',
            'care_recipient_signed_form', 'person_consents');
select id as p_maintien from public.programs where slug = 'credit-maintien-domicile-aines' \gset
select id as p_ciph from public.programs where slug = 'credit-impot-personnes-handicapees' \gset
select id as p_pad from public.programs where slug = 'programme-adaptation-domicile' \gset

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select public.save_benefit_assessment(:'file3', '{"recipient_age": 82, "living_setting": "home"}', format($$[
    {"program_id": %s, "match_level": "likely", "match_reasons": [{"label": "70 ans ou plus", "status": "met"}]},
    {"program_id": %s, "match_level": "possible", "match_reasons": []},
    {"program_id": %s, "match_level": "unlikely", "match_reasons": []}]$$,
    to_jsonb(:'p_maintien'::text), to_jsonb(:'p_ciph'::text), to_jsonb(:'p_pad'::text))::jsonb) as assessment1 \gset
select tst.eq('probables et possibles ajoutés au dossier, pas les peu probables', tst.cnt('select 1 from public.care_file_programs'), 2);
select tst.eq('pièces à fournir reprises des fiches', tst.cnt($$select 1 from public.program_checklist_items where origin = 'program'$$), 3);
select tst.ok('auteur de l''évaluation imposé', (select created_by = auth.uid() from public.benefit_assessments));
select tst.denied('pas d''ajout direct d''un programme au dossier',
    format($$insert into public.care_file_programs (care_file_id, program_id, match_level) values (%L, %L, 'likely')$$, :'file3', :'p_pad'));
select tst.denied('le niveau de correspondance ne se modifie pas à la main', $$update public.care_file_programs set match_level = 'likely'$$);
update public.care_file_programs set status = 'in_progress' where program_id = :'p_maintien';
select tst.ok('demande en cours : date de demande notée', (
    select requested_at is not null and decided_at is null and updated_by = auth.uid()
    from public.care_file_programs where program_id = :'p_maintien'));
update public.care_file_programs set status = 'obtained' where program_id = :'p_maintien';
select tst.ok('obtenu : date de décision notée', (
    select decided_at is not null from public.care_file_programs where program_id = :'p_maintien'));
-- Nouvelle évaluation : le CIPH devient peu probable (gardé, statut conservé), le PAD probable (ajouté).
select public.save_benefit_assessment(:'file3', '{"recipient_age": 82}', format($$[
    {"program_id": %s, "match_level": "likely", "match_reasons": []},
    {"program_id": %s, "match_level": "unlikely", "match_reasons": []},
    {"program_id": %s, "match_level": "likely", "match_reasons": []}]$$,
    to_jsonb(:'p_maintien'::text), to_jsonb(:'p_ciph'::text), to_jsonb(:'p_pad'::text))::jsonb);
select tst.ok('réévaluation : statuts conservés, niveaux mis à jour', (
    select count(*) = 3
       and bool_and(case program_id when :'p_maintien' then status = 'obtained' else status = 'to_explore' end)
       and bool_or(program_id = :'p_ciph' and match_level = 'unlikely')
    from public.care_file_programs));
select tst.eq('pièces du nouveau programme ajoutées une seule fois', tst.cnt('select 1 from public.program_checklist_items'), 5);
update public.program_checklist_items set is_done = true where position = 0 and origin = 'program';
select tst.ok('pièce cochée : qui et quand', (
    select bool_and(done_by = auth.uid() and done_at is not null) from public.program_checklist_items where is_done));
insert into public.program_checklist_items (care_file_program_id, care_file_id, label)
    select id, care_file_id, 'Photocopie du bail' from public.care_file_programs where program_id = :'p_pad';
select tst.denied('pas d''ajout d''une pièce « officielle » à la main',
    format($$insert into public.program_checklist_items (care_file_program_id, care_file_id, label, origin)
             select id, care_file_id, 'X', 'program' from public.care_file_programs where program_id = %L$$, :'p_pad'));
select tst.eq('une pièce tirée de la fiche ne se supprime pas', tst.affected($$delete from public.program_checklist_items where origin = 'program'$$), 0);
select tst.eq('une pièce ajoutée à la main se supprime', tst.affected($$delete from public.program_checklist_items where origin = 'custom'$$), 1);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-8000-00000000000e","role":"authenticated","email":"emma@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('coordination : droits invisibles', tst.cnt('select 1 from public.care_file_programs')
    + tst.cnt('select 1 from public.benefit_assessments') + tst.cnt('select 1 from public.program_checklist_items'), 0);
select tst.fails('coordination : pas d''évaluation', format($$select public.save_benefit_assessment(%L, '{}', '[]')$$, :'file3'), '42501');
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"70000000-0000-4000-8000-000000000007","role":"authenticated","email":"gilles@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('lecture seule : voit les programmes', tst.cnt('select 1 from public.care_file_programs'), 3);
select tst.eq('lecture seule : ne change pas un statut', tst.affected($$update public.care_file_programs set status = 'refused'$$), 0);
select tst.fails('lecture seule : pas d''évaluation', format($$select public.save_benefit_assessment(%L, '{}', '[]')$$, :'file3'), '42501');
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-00000000000d","role":"authenticated","email":"denis@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('accès complet : note sur un programme', tst.affected(format($$update public.care_file_programs set notes = 'Appeler mardi' where program_id = %L$$, :'p_pad')), 1);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"60000000-0000-4000-8000-000000000006","role":"authenticated","email":"olivier@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('personne extérieure : rien', tst.cnt('select 1 from public.care_file_programs'), 0);
commit;

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select public.save_program_explanation(:'p_ciph', 1, '{"plain_explanation": "Explication."}', 'simulated');
select public.save_program_explanation(:'p_ciph', 1, '{"plain_explanation": "Autre."}', 'simulated');
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.ok('explication en cache pour la version de la fiche (la première gardée)', (
    select (public.program_for_ai(:'p_ciph') #>> '{cached_explanation,plain_explanation}') = 'Explication.'));
select public.export_care_file(:'file3') as export3 \gset
select tst.ok('export : réponses et programmes', (:'export3'::jsonb ->> 'format') = 'relais-dossier/4'
    and jsonb_array_length(:'export3'::jsonb -> 'programs') = 3
    and (:'export3'::jsonb #>> '{benefit_answers,recipient_age}') = '82');
select public.delete_care_file(:'file3') as deleted3 \gset
select tst.ok('suppression : nombre de programmes noté', (:'deleted3'::jsonb ->> 'programs')::int = 3);
commit;

select tst.eq('dossier « Grand-maman » entièrement effacé', (
    (select count(*) from public.care_file_programs where care_file_id = :'file3')
    + (select count(*) from public.benefit_assessments where care_file_id = :'file3')
    + (select count(*) from public.program_checklist_items where care_file_id = :'file3')), 0);
select tst.eq('les fiches du catalogue restent', (select count(*) from public.programs), 8);

\o
\echo '== étape 5 : structure de la coordination'
\o /dev/null

select tst.ok('rappels : la fonction ne renvoie que des nombres et l''adresse',
    pg_get_function_result('public.reminders_due(date)'::regprocedure)
    = 'TABLE(user_id uuid, email text, task_count integer, appointment_count integer)');
select tst.ok('rappels : fonctions réservées au serveur',
    not has_function_privilege('authenticated', 'public.reminders_due(date)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.record_reminder_sent(uuid,date,integer,integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.reminders_due(date)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.reminders_due(date)', 'EXECUTE'));
select tst.ok('auteurs et dates de fin non modifiables',
    not has_column_privilege('authenticated', 'public.tasks', 'created_by', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.tasks', 'completed_by', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.tasks', 'care_file_id', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.journal_entries', 'author_id', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.appointments', 'created_by', 'UPDATE'));
select tst.ok('rappels envoyés : aucune écriture par les membres',
    not has_table_privilege('authenticated', 'public.reminder_deliveries', 'INSERT')
    and not has_table_privilege('authenticated', 'public.reminder_deliveries', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.reminder_deliveries', 'DELETE'));

\o
\echo '== étape 5 : tâches, agenda, questions et carnet (« Papi »)'
\o /dev/null

-- C : aidante principale ; D : accès complet ; E : coordination ; G : lecture seule ; O : extérieure.
\set file4 'f4000000-0000-4000-8000-000000000004'
insert into public.care_files (id, owner_id, title) values (:'file4', 'c0000000-0000-4000-8000-00000000000c', 'Papi');
insert into public.care_file_members (care_file_id, user_id, role, access_level) values
    (:'file4', 'd0000000-0000-4000-8000-00000000000d', 'family_member', 'full'),
    (:'file4', 'e0000000-0000-4000-8000-00000000000e', 'family_member', 'coordination'),
    (:'file4', '70000000-0000-4000-8000-000000000007', 'family_member', 'read_only');
insert into public.consents (user_id, care_file_id, consent_type, text_version, granted_by, legal_basis)
    values ('c0000000-0000-4000-8000-00000000000c', :'file4', 'care_recipient_data', '2026-10-27',
            'care_recipient_signed_form', 'person_consents');
select (now() at time zone 'America/Toronto')::date as today \gset

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
insert into public.tasks (care_file_id, title, assignee_id, due_on, created_by) values
    (:'file4', 'Appeler la pharmacie', 'e0000000-0000-4000-8000-00000000000e', :'today', 'd0000000-0000-4000-8000-00000000000d'),
    (:'file4', 'Remplir le formulaire du CLSC', 'd0000000-0000-4000-8000-00000000000d', :'today'::date + 5, null),
    (:'file4', 'Acheter des bas de contention', null, null, null);
select tst.ok('auteur d''une tâche imposé', (select bool_and(created_by = auth.uid()) from public.tasks));
select tst.fails('responsable hors du dossier refusé', format($$insert into public.tasks (care_file_id, title, assignee_id)
    values (%L, 'X', '60000000-0000-4000-8000-000000000006')$$, :'file4'), '23514');
update public.tasks set status = 'done' where title = 'Acheter des bas de contention';
select tst.ok('tâche faite : qui et quand', (
    select completed_at is not null and completed_by = auth.uid() from public.tasks where title = 'Acheter des bas de contention'));
update public.tasks set status = 'todo' where title = 'Acheter des bas de contention';
select tst.ok('tâche rouverte : date de fin effacée', (
    select completed_at is null and completed_by is null from public.tasks where title = 'Acheter des bas de contention'));
insert into public.tasks (care_file_id, title, status, completed_at, completed_by)
    values (:'file4', 'Antidatée', 'done', '2020-01-01', 'd0000000-0000-4000-8000-00000000000d');
select tst.ok('date de fin et auteur non falsifiables', (
    select completed_at > now() - interval '1 minute' and completed_by = auth.uid() from public.tasks where title = 'Antidatée'));
delete from public.tasks where title = 'Antidatée';

insert into public.appointments (care_file_id, title, starts_at, companion_id) values
    (:'file4', 'Clinique de gériatrie', (:'today'::date + 1)::timestamp at time zone 'America/Toronto' + interval '10 hours',
     'e0000000-0000-4000-8000-00000000000e'),
    (:'file4', 'Prise de sang', (:'today'::date + 3)::timestamp at time zone 'America/Toronto' + interval '8 hours', null),
    (:'file4', 'Visite de l''ergothérapeute', :'today'::timestamp at time zone 'America/Toronto' + interval '15 hours', null);
select tst.fails('accompagnateur hors du dossier refusé', format($$insert into public.appointments (care_file_id, title, starts_at, companion_id)
    values (%L, 'X', now(), '60000000-0000-4000-8000-000000000006')$$, :'file4'), '23514');
select tst.fails('fin avant le début refusée', format($$insert into public.appointments (care_file_id, title, starts_at, ends_at)
    values (%L, 'X', now(), now() - interval '1 hour')$$, :'file4'), '23514');
select id as appt1 from public.appointments where title = 'Clinique de gériatrie' \gset
insert into public.appointment_questions (appointment_id, care_file_id, question, position) values
    (:'appt1', :'file4', 'Faut-il refaire une prise de sang ?', 0),
    (:'appt1', :'file4', 'Quels signes doivent nous inquiéter ?', 1);
insert into public.journal_entries (care_file_id, body, author_id)
    values (:'file4', 'Papa a bien dormi.', 'd0000000-0000-4000-8000-00000000000d');
select tst.ok('auteur d''une note du carnet imposé', (select author_id = auth.uid() from public.journal_entries));
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-8000-00000000000e","role":"authenticated","email":"emma@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('coordination : voit les tâches et l''agenda', tst.cnt('select 1 from public.tasks') + tst.cnt('select 1 from public.appointments'), 6);
select tst.eq('coordination : ne voit ni les questions ni le carnet',
    tst.cnt('select 1 from public.appointment_questions') + tst.cnt('select 1 from public.journal_entries'), 0);
insert into public.tasks (care_file_id, title) values (:'file4', 'Conduire Papa à la clinique');
select tst.eq('coordination : coche une tâche', tst.affected($$update public.tasks set status = 'done' where title = 'Appeler la pharmacie'$$), 1);
update public.tasks set status = 'todo' where title = 'Appeler la pharmacie';
select tst.denied('coordination : pas de note au carnet', format($$insert into public.journal_entries (care_file_id, body) values (%L, 'X')$$, :'file4'));
select tst.denied('coordination : pas de question médicale', format($$insert into public.appointment_questions (appointment_id, care_file_id, question)
    values (%L, %L, 'X')$$, :'appt1', :'file4'));
select tst.denied('coordination : pas de tâche liée à un document qu''elle ne voit pas',
    format($$insert into public.tasks (care_file_id, title, source_document_id) values (%L, 'X', gen_random_uuid())$$, :'file4'));
select tst.denied('coordination : pas de tâche liée à une démarche qu''elle ne voit pas',
    format($$insert into public.tasks (care_file_id, title, care_file_program_id) values (%L, 'X', gen_random_uuid())$$, :'file4'));
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"70000000-0000-4000-8000-000000000007","role":"authenticated","email":"gilles@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('lecture seule : voit tout, carnet et questions compris', tst.cnt('select 1 from public.tasks')
    + tst.cnt('select 1 from public.appointments') + tst.cnt('select 1 from public.appointment_questions')
    + tst.cnt('select 1 from public.journal_entries'), 10);
select tst.eq('lecture seule : ne coche rien', tst.affected($$update public.tasks set status = 'done'$$), 0);
select tst.eq('lecture seule : ne supprime rien', tst.affected($$delete from public.appointments$$), 0);
select tst.denied('lecture seule : pas de tâche', format($$insert into public.tasks (care_file_id, title) values (%L, 'X')$$, :'file4'));
select tst.denied('lecture seule : pas de note', format($$insert into public.journal_entries (care_file_id, body) values (%L, 'X')$$, :'file4'));
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-00000000000d","role":"authenticated","email":"denis@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('carnet : la note d''un autre ne se modifie pas', tst.affected($$update public.journal_entries set body = 'X'$$), 0);
select tst.eq('carnet : la note d''un autre ne se supprime pas', tst.affected($$delete from public.journal_entries$$), 0);
insert into public.journal_entries (care_file_id, body) values (:'file4', 'Visite de 14 h : bonne humeur.');
select tst.eq('carnet : sa propre note se modifie', tst.affected($$update public.journal_entries set body = 'Visite de 14 h.' where author_id = auth.uid()$$), 1);
select tst.ok('carnet : date de création conservée', (select created_at <= updated_at from public.journal_entries where author_id = auth.uid()));
select tst.denied('carnet : auteur non modifiable', $$update public.journal_entries set author_id = auth.uid()$$);
select tst.eq('accès complet : ajoute une question', tst.affected(format($$insert into public.appointment_questions (appointment_id, care_file_id, question)
    values (%L, %L, 'Peut-il conduire ?')$$, :'appt1', :'file4')), 1);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"60000000-0000-4000-8000-000000000006","role":"authenticated","email":"olivier@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('personne extérieure : rien', tst.cnt('select 1 from public.tasks') + tst.cnt('select 1 from public.appointments')
    + tst.cnt('select 1 from public.appointment_questions') + tst.cnt('select 1 from public.journal_entries'), 0);
select tst.denied('personne extérieure : pas de tâche', format($$insert into public.tasks (care_file_id, title) values (%L, 'X')$$, :'file4'));
commit;

\o
\echo '== étape 5 : rappels quotidiens'
\o /dev/null

-- C et E acceptent les rappels ; D n'a rien accepté.
insert into public.consents (user_id, consent_type, text_version) values
    ('c0000000-0000-4000-8000-00000000000c', 'email_reminders', '2026-10-26'),
    ('e0000000-0000-4000-8000-00000000000e', 'email_reminders', '2026-10-26');

begin;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-8000-00000000000e","role":"authenticated","email":"emma@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.fails('membre : pas d''accès aux rappels', format($$select * from public.reminders_due(%L)$$, :'today'), '42501');
commit;

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
-- E : 1 tâche due aujourd'hui et 1 rendez-vous demain qu'elle accompagne. C : la visite d'aujourd'hui, sans
-- accompagnateur (aidante principale). La prise de sang (dans 3 jours) ne compte pas.
select tst.ok('rappels : nombres par personne', (
    select jsonb_object_agg(email, jsonb_build_array(task_count, appointment_count))
    from public.reminders_due(:'today'))
    = '{"emma@example.test": [1, 1], "claire@example.test": [0, 1]}'::jsonb);
select public.record_reminder_sent('e0000000-0000-4000-8000-00000000000e', :'today', 1, 1);
select public.record_reminder_sent('e0000000-0000-4000-8000-00000000000e', :'today', 1, 1);
select tst.eq('rappels : un seul courriel par jour', tst.cnt(format('select 1 from public.reminders_due(%L)', :'today')), 1);
select tst.eq('rappels : le lendemain, de nouveau', tst.cnt(format($$select 1 from public.reminders_due(%L) where email = 'emma@example.test'$$,
    :'today'::date + 1)), 1);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-8000-00000000000e","role":"authenticated","email":"emma@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('rappels reçus : visibles par la personne', tst.cnt('select 1 from public.reminder_deliveries'), 1);
select tst.ok('rappels reçus : dans l''export personnel', jsonb_array_length(public.export_my_data() -> 'reminder_emails') = 1);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('rappels reçus : rien de ceux des autres', tst.cnt('select 1 from public.reminder_deliveries'), 0);
-- E quitte le dossier : ses tâches et ses accompagnements sont libérés.
delete from public.care_file_members where care_file_id = :'file4' and user_id = 'e0000000-0000-4000-8000-00000000000e';
select tst.ok('membre retiré : plus responsable ni accompagnatrice', (
    select count(*) = 0 from public.tasks where assignee_id = 'e0000000-0000-4000-8000-00000000000e')
    and (select count(*) = 0 from public.appointments where companion_id = 'e0000000-0000-4000-8000-00000000000e'));
select tst.eq('membre retiré : les tâches restent', tst.cnt('select 1 from public.tasks'), 4);

select public.export_care_file(:'file4') as export4 \gset
select tst.ok('export : tâches, agenda avec questions, carnet', (:'export4'::jsonb ->> 'format') = 'relais-dossier/4'
    and jsonb_array_length(:'export4'::jsonb -> 'tasks') = 4
    and jsonb_array_length(:'export4'::jsonb -> 'appointments') = 3
    and jsonb_array_length(:'export4'::jsonb #> '{appointments,1,questions}') = 3
    and jsonb_array_length(:'export4'::jsonb -> 'journal_entries') = 2);
select public.delete_care_file(:'file4') as deleted4 \gset
select tst.ok('suppression : tâches, rendez-vous et notes comptés', (:'deleted4'::jsonb ->> 'tasks')::int = 4
    and (:'deleted4'::jsonb ->> 'appointments')::int = 3 and (:'deleted4'::jsonb ->> 'journal_entries')::int = 2);
commit;

select tst.eq('dossier « Papi » entièrement effacé', (
    (select count(*) from public.tasks where care_file_id = :'file4')
    + (select count(*) from public.appointments where care_file_id = :'file4')
    + (select count(*) from public.appointment_questions where care_file_id = :'file4')
    + (select count(*) from public.journal_entries where care_file_id = :'file4')), 0);

\o
\echo '== étape 6 : structure'
\o /dev/null

select tst.ok('bilan, évaluation et notes internes : rien pour anon',
    not has_table_privilege('anon', 'public.caregiver_checkins', 'SELECT')
    and not has_table_privilege('anon', 'public.pilot_feedback', 'SELECT')
    and not has_table_privilege('anon', 'public.support_request_notes', 'SELECT'));
select tst.ok('demande : état, intervenante et dates jamais écrits par le demandeur',
    not has_column_privilege('authenticated', 'public.support_requests', 'status', 'INSERT')
    and not has_column_privilege('authenticated', 'public.support_requests', 'requester_id', 'INSERT')
    and not has_column_privilege('authenticated', 'public.support_requests', 'email', 'INSERT')
    and not has_column_privilege('authenticated', 'public.support_requests', 'notified_at', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.support_requests', 'message', 'UPDATE'));
select tst.ok('avis aux intervenantes : réservé au serveur',
    not has_function_privilege('authenticated', 'public.claim_support_notification(uuid,uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.claim_support_notification(uuid,uuid)', 'EXECUTE'));

\o
\echo '== étape 6 : bilan de la semaine (privé)'
\o /dev/null

\set file5 'f5000000-0000-4000-8000-000000000005'
insert into public.care_files (id, owner_id, title) values (:'file5', 'c0000000-0000-4000-8000-00000000000c', 'Tante');
insert into public.care_file_members (care_file_id, user_id, role, access_level) values
    (:'file5', 'd0000000-0000-4000-8000-00000000000d', 'family_member', 'full'),
    (:'file5', 'f0000000-0000-4000-8000-00000000000f', 'relais_worker', 'read_only');
insert into public.consents (user_id, care_file_id, consent_type, text_version, granted_by, legal_basis)
    values ('c0000000-0000-4000-8000-00000000000c', :'file5', 'care_recipient_data', '2026-10-27',
            'care_recipient_signed_form', 'person_consents');
select date_trunc('week', (now() at time zone 'America/Toronto'))::date as monday \gset

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.denied('bilan gardé seulement avec son consentement',
    format($$insert into public.caregiver_checkins (week_start, fatigue, overwhelm, isolation) values (%L, 4, 4, 3)$$, :'monday'));
select public.grant_consent('caregiver_checkin', '2026-10-31');
insert into public.caregiver_checkins (user_id, week_start, fatigue, overwhelm, isolation)
    values ('d0000000-0000-4000-8000-00000000000d', :'monday', 5, 4, 3);
select tst.ok('bilan au nom de son auteur', (select user_id = auth.uid() from public.caregiver_checkins));
select tst.fails('semaine commençant un lundi', format($$insert into public.caregiver_checkins (week_start, fatigue, overwhelm, isolation)
    values (%L, 1, 1, 1)$$, :'monday'::date + 1), '23514');
select tst.fails('réponses de 1 à 5', format($$update public.caregiver_checkins set fatigue = 6$$), '23514');
update public.caregiver_checkins set fatigue = 4;
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-00000000000d","role":"authenticated","email":"denis@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('bilan invisible à la famille', tst.cnt('select 1 from public.caregiver_checkins'), 0);
select tst.eq('bilan non modifiable par la famille', tst.affected('update public.caregiver_checkins set fatigue = 1'), 0);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-00000000000f","role":"authenticated","email":"intervenante.w@example.test","aal":"aal2"}', true);
set local role authenticated;
select tst.eq('bilan invisible aux intervenantes', tst.cnt('select 1 from public.caregiver_checkins'), 0);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000009","role":"authenticated","email":"admin.x@example.test","aal":"aal2"}', true);
set local role authenticated;
select tst.eq('bilan invisible à l''admin', tst.cnt('select 1 from public.caregiver_checkins'), 0);
select tst.ok('mesures du pilote sans le bilan', position('fatigue' in public.pilot_metrics()::text) = 0
    and position('isolation' in public.pilot_metrics()::text) = 0);
commit;

-- Nouvelle version du texte : le bilan gardé reste. Retrait : il est effacé.
insert into public.consent_texts (consent_type, version, sha256, published_on)
    values ('caregiver_checkin', '2026-12-01', repeat('a', 64), '2026-12-01');
begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select public.grant_consent('caregiver_checkin', '2026-12-01');
commit;
select tst.eq('nouvelle version acceptée : bilan conservé', (select count(*) from public.caregiver_checkins), 1);
begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select public.revoke_consent((select id from public.consents where consent_type = 'caregiver_checkin' and revoked_at is null));
commit;
select tst.eq('consentement retiré : bilan effacé', (select count(*) from public.caregiver_checkins), 0);
delete from public.consents where consent_type = 'caregiver_checkin';
delete from public.consent_texts where consent_type = 'caregiver_checkin' and version = '2026-12-01';

\o
\echo '== étape 6 : demandes d''intervenante'
\o /dev/null

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
insert into public.support_requests (care_file_id, origin, contact_name, preferred_contact, phone, preferred_times, message)
    values (:'file5', 'button', ' Claire ', 'phone', '514 555-0101', 'En soirée', 'Je suis épuisée.');
insert into public.support_requests (origin, contact_name, preferred_contact)
    values ('distress_screen', 'Claire', 'email');
select tst.ok('demandes au nom de la personne, état « nouvelle »', (
    select bool_and(requester_id = auth.uid() and status = 'new' and assigned_worker_id is null) and count(*) = 2
    from public.support_requests));
select tst.ok('adresse du compte copiée seulement si choisie', (
    select bool_and(case preferred_contact when 'email' then email = 'claire@example.test' else email is null end)
    from public.support_requests));
select tst.ok('nom nettoyé', (select bool_and(contact_name = 'Claire') from public.support_requests));
select tst.denied('pas d''état choisi par le demandeur', $$insert into public.support_requests (origin, contact_name, preferred_contact, status)
    values ('button', 'X', 'email', 'assigned')$$);
select tst.fails('téléphone exigé pour un rappel', $$insert into public.support_requests (origin, contact_name, preferred_contact)
    values ('button', 'X', 'phone')$$, '23514');
select tst.denied('dossier d''une autre famille refusé', $$insert into public.support_requests (care_file_id, origin, contact_name, preferred_contact)
    values (gen_random_uuid(), 'button', 'X', 'email')$$);
select tst.eq('le demandeur ne change pas l''état', tst.affected($$update public.support_requests set status = 'closed'$$), 0);
commit;
select id as req_phone from public.support_requests where preferred_contact = 'phone' \gset
select id as req_email from public.support_requests where preferred_contact = 'email' \gset

begin;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-00000000000d","role":"authenticated","email":"denis@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('famille : demandes d''une autre personne invisibles', tst.cnt('select 1 from public.support_requests'), 0);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-00000000000f","role":"authenticated","email":"intervenante.w@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('intervenante sans MFA : rien', tst.cnt('select 1 from public.support_requests'), 0);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000009","role":"authenticated","email":"admin.x@example.test","aal":"aal2"}', true);
set local role authenticated;
select tst.eq('admin : pas le tableau des intervenantes', tst.cnt('select 1 from public.support_requests'), 0);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-00000000000f","role":"authenticated","email":"intervenante.w@example.test","aal":"aal2"}', true);
set local role authenticated;
select tst.eq('intervenante (MFA) : tableau complet', tst.cnt('select 1 from public.support_requests'), 2);
select tst.fails('une demande ne se confie pas à quelqu''un d''autre', format($$update public.support_requests
    set assigned_worker_id = '90000000-0000-4000-8000-000000000009', status = 'assigned' where id = %L$$, :'req_phone'), '42501');
update public.support_requests set status = 'assigned' where id = :'req_phone';
select tst.ok('prise en charge : intervenante et date notées', (
    select assigned_worker_id = auth.uid() and assigned_at is not null from public.support_requests where id = :'req_phone'));
insert into public.support_request_notes (support_request_id, body, author_id)
    values (:'req_phone', 'Rappel fait, rencontre prévue jeudi.', 'c0000000-0000-4000-8000-00000000000c');
select tst.ok('note interne signée par l''intervenante', (select author_id = auth.uid() from public.support_request_notes));
select tst.fails('pas de retour à « nouvelle »', format($$update public.support_requests set status = 'new' where id = %L$$, :'req_phone'), '22023');
update public.support_requests set status = 'closed' where id = :'req_phone';
select tst.ok('fermeture : qui et quand', (
    select closed_at is not null and closed_by = auth.uid() from public.support_requests where id = :'req_phone'));
select tst.denied('intervenante : le message du demandeur ne se modifie pas', format($$update public.support_requests set message = 'X' where id = %L$$, :'req_phone'));
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('notes internes invisibles au demandeur', tst.cnt('select 1 from public.support_request_notes'), 0);
select tst.denied('le demandeur n''écrit pas de note', format($$insert into public.support_request_notes (support_request_id, body) values (%L, 'X')$$, :'req_phone'));
select public.cancel_support_request(:'req_email');
select tst.ok('le demandeur retire sa demande', (
    select status = 'closed' and closed_by = auth.uid() from public.support_requests where id = :'req_email'));
select tst.fails('demande déjà fermée', format('select public.cancel_support_request(%L)', :'req_email'), '22023');
select tst.ok('export personnel : demandes sans notes internes', (
    select jsonb_array_length(e -> 'support_requests') = 2 and position('Rappel fait' in e::text) = 0
    from (select public.export_my_data() as e) x));
commit;

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select tst.ok('avis : une seule fois, adresses des intervenantes, sans contenu', (
    select n ->> 'origin' = 'button' and n -> 'emails' = '["intervenante.w@example.test"]'::jsonb
       and position('épuisée' in n::text) = 0 and position('Claire' in n::text) = 0
    from (select public.claim_support_notification(:'req_phone', 'c0000000-0000-4000-8000-00000000000c') as n) x));
select tst.ok('avis : pas deux fois', public.claim_support_notification(:'req_phone', 'c0000000-0000-4000-8000-00000000000c') is null);
select tst.ok('avis : seulement pour le demandeur', public.claim_support_notification(:'req_email', 'd0000000-0000-4000-8000-00000000000d') is null);
commit;

\o
\echo '== étape 6 : évaluation du pilote'
\o /dev/null

-- E possède un dossier sans avoir accepté l'évaluation : ses programmes ne sont pas comptés.
\set file6 'f6000000-0000-4000-8000-000000000006'
insert into public.care_files (id, owner_id, title) values (:'file6', 'e0000000-0000-4000-8000-00000000000e', 'Oncle');
select id as p_one from public.programs order by sort_order limit 1 \gset
select id as p_two from public.programs order by sort_order offset 1 limit 1 \gset
insert into public.care_file_programs (care_file_id, program_id, match_level, identified_at) values
    (:'file5', :'p_one', 'likely', now() - interval '10 days'),
    (:'file5', :'p_two', 'possible', now() - interval '10 days'),
    (:'file6', :'p_one', 'likely', now());
update public.care_file_programs set status = 'in_progress' where care_file_id = :'file5' and program_id = :'p_one';
update public.care_file_programs set requested_at = identified_at + interval '4 days' where care_file_id = :'file5' and program_id = :'p_one';

begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.denied('évaluation seulement avec son consentement',
    format($$insert into public.pilot_feedback (week_start, hours_saved, satisfaction) values (%L, 2, 4)$$, :'monday'));
select public.grant_consent('pilot_evaluation', '2026-10-26');
insert into public.pilot_feedback (week_start, hours_saved, satisfaction) values (:'monday', 2.5, 4);
select tst.fails('heures par demi-heure', format($$update public.pilot_feedback set hours_saved = 2.3$$), '23514');
select tst.fails('au moins une réponse', format($$insert into public.pilot_feedback (week_start) values (%L)$$, :'monday'::date - 7), '23514');
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000009","role":"authenticated","email":"admin.x@example.test","aal":"aal2"}', true);
set local role authenticated;
select tst.eq('admin : aucune réponse individuelle', tst.cnt('select 1 from public.pilot_feedback'), 0);
select tst.ok('moins de 3 répondants : moyennes masquées', (
    select (m #>> '{feedback,suppressed}')::boolean and (m #> '{feedback,hours_saved_avg}') is null
    from (select public.pilot_metrics() as m) x));
select tst.ok('programmes comptés seulement chez qui a accepté l''évaluation', (
    select (m #>> '{programs,identified}')::int = 2 and (m #>> '{programs,requested}')::int = 1
       and (m #>> '{programs,median_days_to_request}')::numeric = 4
    from (select public.pilot_metrics() as m) x));
select tst.ok('demandes : nombres et délai de prise en charge', (
    select (m #>> '{support,total}')::int = 2 and (m #>> '{support,closed}')::int = 2
       and (m #>> '{support,from_distress_screen}')::int = 1 and (m #> '{support,median_hours_to_assignment}') is not null
    from (select public.pilot_metrics() as m) x));
commit;

-- Deux autres répondants : les moyennes apparaissent.
insert into public.consents (user_id, consent_type, text_version) values
    ('d0000000-0000-4000-8000-00000000000d', 'pilot_evaluation', '2026-10-26'),
    ('70000000-0000-4000-8000-000000000007', 'pilot_evaluation', '2026-10-26');
begin;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-00000000000d","role":"authenticated","email":"denis@example.test","aal":"aal1"}', true);
set local role authenticated;
insert into public.pilot_feedback (week_start, hours_saved, satisfaction) values (:'monday', 1, 5);
select tst.eq('évaluation : chacun voit seulement la sienne', tst.cnt('select 1 from public.pilot_feedback'), 1);
commit;
begin;
select set_config('request.jwt.claims', '{"sub":"70000000-0000-4000-8000-000000000007","role":"authenticated","email":"gilles@example.test","aal":"aal1"}', true);
set local role authenticated;
insert into public.pilot_feedback (week_start, hours_saved, satisfaction) values (:'monday', 3, 3);
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000009","role":"authenticated","email":"admin.x@example.test","aal":"aal2"}', true);
set local role authenticated;
select tst.ok('3 répondants : moyennes regroupées', (
    select not (m #>> '{feedback,suppressed}')::boolean and (m #>> '{feedback,hours_saved_avg}')::numeric = 2.2
       and (m #>> '{feedback,satisfaction_avg}')::numeric = 4.0 and (m #>> '{feedback,satisfaction,5}')::int = 1
    from (select public.pilot_metrics() as m) x));
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000009","role":"authenticated","email":"admin.x@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.fails('admin sans MFA : pas de mesures', 'select public.pilot_metrics()', '42501');
commit;
begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.fails('membre : pas de mesures', 'select public.pilot_metrics()', '42501');
commit;

begin;
select set_config('request.jwt.claims', '{"sub":"70000000-0000-4000-8000-000000000007","role":"authenticated","email":"gilles@example.test","aal":"aal1"}', true);
set local role authenticated;
select public.revoke_consent((select id from public.consents where consent_type = 'pilot_evaluation' and user_id = auth.uid()));
commit;
select tst.eq('évaluation retirée : réponses effacées', (select count(*) from public.pilot_feedback), 2);

\o
\echo '== purge planifiée de Storage'
\o /dev/null

\set file7 'f7000000-0000-4000-8000-000000000007'
\set doc_old '7d000000-0000-4000-8000-000000000001'
\set doc_new '7d000000-0000-4000-8000-000000000002'
\set doc_kept '7d000000-0000-4000-8000-000000000003'
insert into public.care_files (id, owner_id, title) values (:'file7', 'c0000000-0000-4000-8000-00000000000c', 'Tante');
insert into public.care_file_members (care_file_id, user_id, role, access_level) values
    (:'file7', 'd0000000-0000-4000-8000-00000000000d', 'family_member', 'full');
-- Dépôt abandonné depuis 25 h (fichier partiel déposé), dépôt en cours depuis 2 h, document reçu il y a 30 jours ;
-- un fichier orphelin ancien et un récent.
insert into public.documents (id, care_file_id, mime_type, size_bytes, uploaded_by, uploaded_at, status) values
    (:'doc_old', :'file7', 'application/pdf', 10, 'd0000000-0000-4000-8000-00000000000d', now() - interval '25 hours', 'pending_upload'),
    (:'doc_new', :'file7', 'application/pdf', 10, 'd0000000-0000-4000-8000-00000000000d', now() - interval '2 hours', 'pending_upload'),
    (:'doc_kept', :'file7', 'application/pdf', 10, 'd0000000-0000-4000-8000-00000000000d', now() - interval '30 days', 'uploaded');
insert into storage.objects (bucket_id, name, created_at) values
    ('documents', :'file7' || '/' || :'doc_old', now() - interval '25 hours'),
    ('documents', :'file7' || '/' || :'doc_kept', now() - interval '30 days'),
    ('documents', :'file7' || '/orphelin-ancien', now() - interval '3 days'),
    ('documents', :'file7' || '/orphelin-recent', now() - interval '1 hour');
select count(*) as queue_before from public.storage_deletion_queue \gset

select tst.ok('purge : rôle service seulement', not has_function_privilege('authenticated', 'public.storage_purge_prepare()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.storage_purge_prepare()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.storage_purge_claim(integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.storage_purge_done(bigint[])', 'EXECUTE')
    and has_function_privilege('service_role', 'public.storage_purge_prepare()', 'EXECUTE')
    and has_function_privilege('service_role', 'public.storage_purge_claim(integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.storage_purge_done(bigint[])', 'EXECUTE'));
begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.fails('membre : pas de préparation de purge', 'select public.storage_purge_prepare()', '42501');
select tst.fails('membre : pas de réservation de fichiers', 'select * from public.storage_purge_claim(10)', '42501');
select tst.fails('membre : pas de retrait de la file', 'select public.storage_purge_done(array[1]::bigint[])', '42501');
commit;

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select public.storage_purge_prepare() as prep \gset
commit;
select tst.ok('un dépôt abandonné et un orphelin ancien', :'prep'::jsonb = '{"expired_uploads": 1, "orphans": 1}'::jsonb);
select tst.ok('dépôt abandonné supprimé ; dépôt en cours et document reçu gardés',
    (select array_agg(id order by id) from public.documents where care_file_id = :'file7') = array[:'doc_new', :'doc_kept']::uuid[]);
select tst.eq('à effacer : le fichier partiel et l''orphelin ancien, rien d''autre', (
    select count(*) from public.storage_deletion_queue
    where object_path in (:'file7' || '/' || :'doc_old', :'file7' || '/orphelin-ancien')), 2);
select tst.eq('aucune autre inscription', (select count(*) from public.storage_deletion_queue), :'queue_before'::bigint + 2);
select tst.ok('journal du dossier : effacé par Relais (sans auteur)', (
    select count(*) = 1 and bool_and(actor_id is null and target_type = 'documents' and target_id = :'doc_old')
    from public.access_log where care_file_id = :'file7' and action = 'upload_expired'));
begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","email":"claire@example.test","aal":"aal1"}', true);
set local role authenticated;
select tst.eq('l''aidante principale voit l''effacement dans son journal',
    tst.cnt($$select 1 from public.access_log where action = 'upload_expired'$$), 1);
commit;

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select count(*) as first_batch from public.storage_purge_claim(2) \gset
select count(*) as second_batch from public.storage_purge_claim(1) \gset
commit;
select tst.eq('réservation par lot', :first_batch, 2);
select tst.eq('les moins essayés d''abord', (
    select count(*) from public.storage_deletion_queue where attempts = 1), 3);
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select count(*) as claimed_all, array_agg(id) as claimed_ids, array_agg(object_path) as claimed_paths
from public.storage_purge_claim(1000) \gset
commit;
select tst.eq('tout est repris', :claimed_all, :'queue_before'::bigint + 2);
-- L'API Storage efface les objets (ici, à la main) ; la fin du lot retire les inscriptions.
delete from storage.objects where bucket_id = 'documents' and name = any(:'claimed_paths'::text[]);
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select public.storage_purge_done(:'claimed_ids'::bigint[]) as done_count \gset
select public.storage_purge_prepare() as prep2 \gset
commit;
select tst.eq('inscriptions retirées', :done_count, :claimed_all);
select tst.ok('deuxième passage : rien de neuf', :'prep2'::jsonb = '{"expired_uploads": 0, "orphans": 0}'::jsonb
    and not exists (select 1 from public.storage_deletion_queue));
select tst.ok('fichiers vivants et orphelin récent intacts', (
    select array_agg(name order by name) from storage.objects where name like :'file7' || '/%')
    = array[:'file7' || '/' || :'doc_kept', :'file7' || '/orphelin-recent']);

\o
\echo 'RLS OK'
