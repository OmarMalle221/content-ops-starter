-- FICHIER GÉNÉRÉ par scripts/generate-reference-sql.mjs à partir de tests/support/families.ts, des fiches
-- (src/content/programs.fr.json) et du moteur de règles. Ne pas modifier.
--
-- Deux familles FICTIVES pour les démonstrations locales (faux Supabase) : JAMAIS en production. Les
-- comptes sont créés directement dans auth.users ; tout le reste passe par les fonctions de l'application
-- et la RLS, sous l'identité de chaque personne. Code de connexion du faux Supabase : 123456.
--   Famille A : claire.demo@example.test (aidante principale de Louise, 82 ans, à domicile)
--               marc.demo@example.test (son frère, lecture seule)
--   Famille B : denis.demo@example.test (aidant principal de Roger, 79 ans, en RPA, en attente de CHSLD)
-- Appliqué par : RELAIS_DEMO_SEED=1 bash scripts/test-db.sh --serve node tests/e2e/fake-supabase.mjs

insert into auth.users (id, email) values
    ('de000000-0000-4000-8000-00000000000a', 'claire.demo@example.test'),
    ('de000000-0000-4000-8000-00000000000b', 'marc.demo@example.test'),
    ('de000000-0000-4000-8000-00000000000c', 'denis.demo@example.test');

-- ------------------------------------------------------------------- famille A : Louise, 82 ans
select set_config('request.jwt.claims', '{"sub":"de000000-0000-4000-8000-00000000000a","role":"authenticated","aal":"aal1","email":"claire.demo@example.test"}', true);
set local role authenticated;
update public.users set display_name = 'Claire' where id = auth.uid();
select public.grant_consent('privacy_policy', '2026-10-26');
select public.grant_consent('health_information', '2026-10-26');
select public.create_care_file('Maman') as file_a \gset
select public.record_file_consent(:'file_a', 'care_recipient_data', '2026-10-27', 'care_recipient_signed_form', 'person_consents');
insert into public.care_recipients (care_file_id, first_name, last_name, birth_year, living_setting)
values (:'file_a', 'Louise', 'Tremblay', 1944, 'home');
insert into public.care_needs (care_file_id, autonomy_description, services_in_place, home_adaptation_needs, updated_by)
values (:'file_a', 'Autonome pour se nourrir et s’habiller. A besoin d’aide pour le bain et les courses.',
    '["domestic_help"]', 'Bain difficile d’accès.', auth.uid());
insert into public.contacts (care_file_id, kind, name, organization, phone, created_by)
values (:'file_a', 'clsc', 'Accueil soutien à domicile', 'CLSC fictif du Plateau', '555 010-0001', auth.uid());
insert into public.timeline_events (care_file_id, event_type, occurred_on, title, created_by)
values (:'file_a', 'service_change', '2026-09-08', 'Début du ménage aux deux semaines', auth.uid());
select public.save_benefit_assessment(:'file_a', '{"recipient_age":82,"living_setting":"home","pays_home_support_services":"yes","domestic_help":"yes","severe_prolonged_impairment":"unknown","impairment_dependency":"unknown","caregiver_cohabits":"no","needs_home_adaptation":"yes"}'::jsonb, jsonb_build_array(
        jsonb_build_object('program_id', (select id from public.programs where slug = 'credit-maintien-domicile-aines'), 'match_level', 'likely', 'match_reasons', '[{"label":"La personne a 70 ans ou plus","status":"met"},{"label":"Elle vit chez elle ou en résidence privée pour aînés","status":"met"},{"label":"Elle paie des services qui l’aident à rester chez elle","status":"met"}]'::jsonb),
        jsonb_build_object('program_id', (select id from public.programs where slug = 'pefsad-aide-domestique'), 'match_level', 'likely', 'match_reasons', '[{"label":"Elle vit chez elle ou en résidence privée pour aînés","status":"met"},{"label":"Elle reçoit, ou aimerait recevoir, de l’aide domestique (ménage, repas, courses)","status":"met"}]'::jsonb),
        jsonb_build_object('program_id', (select id from public.programs where slug = 'soutien-domicile-clsc'), 'match_level', 'likely', 'match_reasons', '[{"label":"Elle vit chez elle ou en résidence privée pour aînés","status":"met"}]'::jsonb),
        jsonb_build_object('program_id', (select id from public.programs where slug = 'lappui-info-aidant-repit'), 'match_level', 'likely', 'match_reasons', '[{"label":"Vous aidez un proche","status":"met"}]'::jsonb),
        jsonb_build_object('program_id', (select id from public.programs where slug = 'credit-personne-aidante'), 'match_level', 'possible', 'match_reasons', '[{"label":"La personne a une déficience grave et prolongée (attestation requise)","status":"unknown"},{"label":"La personne a 70 ans ou plus","status":"met"},{"label":"Vous habitez avec elle","status":"not_met"}]'::jsonb),
        jsonb_build_object('program_id', (select id from public.programs where slug = 'montant-canadien-aidant-naturel'), 'match_level', 'possible', 'match_reasons', '[{"label":"La personne dépend de vous à cause d’une déficience physique ou mentale","status":"unknown"}]'::jsonb),
        jsonb_build_object('program_id', (select id from public.programs where slug = 'credit-impot-personnes-handicapees'), 'match_level', 'possible', 'match_reasons', '[{"label":"Déficience grave et prolongée qui limite de façon marquée la vie quotidienne, attestée par un professionnel","status":"unknown"}]'::jsonb),
        jsonb_build_object('program_id', (select id from public.programs where slug = 'programme-adaptation-domicile'), 'match_level', 'possible', 'match_reasons', '[{"label":"Son logement a besoin d’être adapté","status":"met"},{"label":"Elle vit dans son propre logement (pas en résidence ni en CHSLD)","status":"met"},{"label":"Son incapacité est importante et persistante (preuve requise)","status":"unknown"}]'::jsonb)
    ));
update public.care_file_programs set status = 'in_progress', notes = 'Factures du ménage gardées dans la chemise bleue.'
    where care_file_id = :'file_a' and program_id = (select id from public.programs where slug = 'credit-maintien-domicile-aines');
update public.program_checklist_items set is_done = true
where care_file_id = :'file_a' and label like 'Factures ou reçus%';
select public.create_invitation(:'file_a', 'marc.demo@example.test', 'family_member', 'read_only') as invite_a \gset

select set_config('request.jwt.claims', '{"sub":"de000000-0000-4000-8000-00000000000b","role":"authenticated","aal":"aal1","email":"marc.demo@example.test"}', true);
set local role authenticated;
update public.users set display_name = 'Marc' where id = auth.uid();
select public.grant_consent('privacy_policy', '2026-10-26');
select public.accept_invitation(:'invite_a');

-- ------------------------------------------------- famille B : Roger, 79 ans, en RPA, attente CHSLD
select set_config('request.jwt.claims', '{"sub":"de000000-0000-4000-8000-00000000000c","role":"authenticated","aal":"aal1","email":"denis.demo@example.test"}', true);
set local role authenticated;
update public.users set display_name = 'Denis' where id = auth.uid();
select public.grant_consent('privacy_policy', '2026-10-26');
select public.grant_consent('health_information', '2026-10-26');
select public.create_care_file('Papa') as file_b \gset
select public.record_file_consent(:'file_b', 'care_recipient_data', '2026-10-27', 'care_recipient_signed_form', 'person_consents');
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
select public.save_benefit_assessment(:'file_b', '{"recipient_age":79,"living_setting":"rpa","pays_home_support_services":"yes","domestic_help":"no","severe_prolonged_impairment":"yes","impairment_dependency":"yes","caregiver_cohabits":"no","needs_home_adaptation":"no"}'::jsonb, jsonb_build_array(
        jsonb_build_object('program_id', (select id from public.programs where slug = 'credit-maintien-domicile-aines'), 'match_level', 'likely', 'match_reasons', '[{"label":"La personne a 70 ans ou plus","status":"met"},{"label":"Elle vit chez elle ou en résidence privée pour aînés","status":"met"},{"label":"Elle paie des services qui l’aident à rester chez elle","status":"met"}]'::jsonb),
        jsonb_build_object('program_id', (select id from public.programs where slug = 'credit-personne-aidante'), 'match_level', 'likely', 'match_reasons', '[{"label":"La personne a une déficience grave et prolongée (attestation requise)","status":"met"},{"label":"La personne a 70 ans ou plus","status":"met"},{"label":"Vous habitez avec elle","status":"not_met"}]'::jsonb),
        jsonb_build_object('program_id', (select id from public.programs where slug = 'montant-canadien-aidant-naturel'), 'match_level', 'likely', 'match_reasons', '[{"label":"La personne dépend de vous à cause d’une déficience physique ou mentale","status":"met"}]'::jsonb),
        jsonb_build_object('program_id', (select id from public.programs where slug = 'credit-impot-personnes-handicapees'), 'match_level', 'likely', 'match_reasons', '[{"label":"Déficience grave et prolongée qui limite de façon marquée la vie quotidienne, attestée par un professionnel","status":"met"}]'::jsonb),
        jsonb_build_object('program_id', (select id from public.programs where slug = 'soutien-domicile-clsc'), 'match_level', 'likely', 'match_reasons', '[{"label":"Elle vit chez elle ou en résidence privée pour aînés","status":"met"}]'::jsonb),
        jsonb_build_object('program_id', (select id from public.programs where slug = 'lappui-info-aidant-repit'), 'match_level', 'likely', 'match_reasons', '[{"label":"Vous aidez un proche","status":"met"}]'::jsonb),
        jsonb_build_object('program_id', (select id from public.programs where slug = 'pefsad-aide-domestique'), 'match_level', 'unlikely', 'match_reasons', '[{"label":"Elle vit chez elle ou en résidence privée pour aînés","status":"met"},{"label":"Elle reçoit, ou aimerait recevoir, de l’aide domestique (ménage, repas, courses)","status":"not_met"}]'::jsonb),
        jsonb_build_object('program_id', (select id from public.programs where slug = 'programme-adaptation-domicile'), 'match_level', 'unlikely', 'match_reasons', '[{"label":"Son logement a besoin d’être adapté","status":"not_met"},{"label":"Elle vit dans son propre logement (pas en résidence ni en CHSLD)","status":"not_met"},{"label":"Son incapacité est importante et persistante (preuve requise)","status":"met"}]'::jsonb)
    ));
update public.care_file_programs set status = 'in_progress', notes = 'Formulaire T2201 remis au médecin de famille.'
    where care_file_id = :'file_b' and program_id = (select id from public.programs where slug = 'credit-impot-personnes-handicapees');
update public.care_file_programs set status = 'obtained', notes = null
    where care_file_id = :'file_b' and program_id = (select id from public.programs where slug = 'credit-maintien-domicile-aines');

reset role;
