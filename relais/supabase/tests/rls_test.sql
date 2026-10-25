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

select tst.eq('versions de consentement publiées', (select count(*) from public.consent_texts), 4);
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
select tst.eq('anon lit les versions de consentement', tst.cnt('select 1 from public.consent_texts'), 4);
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
\echo 'RLS OK'
