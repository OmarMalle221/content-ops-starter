-- =====================================================================================================
-- Relais — vérification des familles fictives de démonstration (supabase/seed/demo_families.sql).
-- Lancé par scripts/test-db.sh après rls_test.sql : la graine passe par les fonctions et la RLS réelles,
-- et le résultat correspond au moteur de règles.
-- =====================================================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = warning;

create function pg_temp.check(label text, cond boolean) returns void
language plpgsql as $$
begin
    if cond is not true then
        raise exception 'FAIL (démo): %', label;
    end if;
end;
$$;

select c.id as file_a from public.care_files c join public.care_recipients r on r.care_file_id = c.id
where r.first_name = 'Louise' and c.owner_id = 'de000000-0000-4000-8000-00000000000a' \gset
select c.id as file_b from public.care_files c join public.care_recipients r on r.care_file_id = c.id
where r.first_name = 'Roger' and c.owner_id = 'de000000-0000-4000-8000-00000000000c' \gset

select pg_temp.check('trois comptes nommés',
    (select count(*) from public.users where id::text like 'de000000-%' and display_name in ('Claire', 'Marc', 'Denis')) = 3);
select pg_temp.check('Marc, membre en lecture seule du dossier de Louise',
    exists (select 1 from public.care_file_members where care_file_id = :'file_a'
            and user_id = 'de000000-0000-4000-8000-00000000000b' and access_level = 'read_only'));
select pg_temp.check('consentement de chaque personne aidée',
    (select count(*) from public.consents where care_file_id in (:'file_a', :'file_b')
     and consent_type = 'care_recipient_data' and revoked_at is null) = 2);
select pg_temp.check('Roger : RPA, en attente de CHSLD',
    exists (select 1 from public.care_recipients where care_file_id = :'file_b' and living_setting = 'rpa' and chsld_waitlist));

-- Démarches du dossier : seulement les programmes probables ou possibles (famille A : 8 ; famille B : 6).
select pg_temp.check('famille A : 8 programmes, 4 probables',
    (select count(*) from public.care_file_programs where care_file_id = :'file_a') = 8
    and (select count(*) from public.care_file_programs where care_file_id = :'file_a' and match_level = 'likely') = 4);
select pg_temp.check('famille B : 6 programmes probables, PEFSAD et adaptation exclus',
    (select count(*) from public.care_file_programs where care_file_id = :'file_b' and match_level = 'likely') = 6
    and not exists (select 1 from public.care_file_programs f join public.programs p on p.id = f.program_id
                    where f.care_file_id = :'file_b' and p.slug in ('pefsad-aide-domestique', 'programme-adaptation-domicile')));
select pg_temp.check('statuts et dates posés par les déclencheurs',
    exists (select 1 from public.care_file_programs f join public.programs p on p.id = f.program_id
            where f.care_file_id = :'file_a' and p.slug = 'credit-maintien-domicile-aines'
              and f.status = 'in_progress' and f.requested_at is not null)
    and exists (select 1 from public.care_file_programs f join public.programs p on p.id = f.program_id
                where f.care_file_id = :'file_b' and p.slug = 'credit-maintien-domicile-aines'
                  and f.status = 'obtained' and f.decided_at is not null));
select pg_temp.check('pièce cochée dans la liste de la famille A',
    exists (select 1 from public.program_checklist_items where care_file_id = :'file_a' and is_done and done_at is not null));

-- Marc lit les démarches mais ne peut rien modifier (RLS).
select set_config('request.jwt.claims',
    '{"sub":"de000000-0000-4000-8000-00000000000b","role":"authenticated","aal":"aal1","email":"marc.demo@example.test"}', true);
set local role authenticated;
select pg_temp.check('Marc voit les 8 démarches', (select count(*) from public.care_file_programs) = 8);
with changed as (update public.care_file_programs set status = 'refused' returning 1)
select pg_temp.check('Marc ne peut pas changer un statut', (select count(*) from changed) = 0);
select pg_temp.check('Marc ne voit pas le dossier de Roger', (select count(*) from public.care_recipients where care_file_id = :'file_b') = 0);
reset role;

\o
\echo 'DÉMO OK'
