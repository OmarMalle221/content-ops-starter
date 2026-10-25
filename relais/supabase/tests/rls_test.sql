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

select tst.eq('versions de consentement publiées', (select count(*) from public.consent_texts), 5);
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
select tst.eq('anon lit les ressources actives', tst.cnt('select 1 from public.resources'), 4);
select tst.eq('anon lit les versions de consentement', tst.cnt('select 1 from public.consent_texts'), 5);
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
select tst.eq('membre : ressources actives seulement', tst.cnt('select 1 from public.resources'), 4);
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
select tst.eq('admin voit les ressources inactives', tst.cnt('select 1 from public.resources'), 5);
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
select tst.ok('export : format', (:'export'::jsonb ->> 'format') = 'relais-export/1');
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
select tst.ok('export : format et contenu', (:'file_export'::jsonb ->> 'format') = 'relais-dossier/1'
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
\echo 'RLS OK'
