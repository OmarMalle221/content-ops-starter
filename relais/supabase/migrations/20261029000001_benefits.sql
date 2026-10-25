-- =====================================================================================================
-- Relais — étape 4 : navigateur de droits.
--
-- Tables : programs (catalogue géré par l'admin, AUCUN montant), program_explanations et
--          program_letter_templates (sorties IA mises en cache, tirées de la seule fiche),
--          benefit_assessments (réponses au questionnaire), care_file_programs (programmes repérés pour
--          le dossier, avec leur statut), program_checklist_items (pièces à fournir).
-- Le choix des programmes est fait par un moteur de règles en TypeScript, sans IA
-- (src/shared/benefits) ; la base garde les réponses, les résultats et le suivi des demandes.
-- Une fiche (programme ou ressource) modifiée sans nouvelle vérification redevient « à vérifier ».
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------------------------------
create type public.program_status as enum ('to_explore', 'in_progress', 'obtained', 'refused');
create type public.match_level as enum ('likely', 'possible', 'unlikely');

-- -----------------------------------------------------------------------------------------------------
-- Catalogue
-- -----------------------------------------------------------------------------------------------------
-- Règle no 3 : aucun montant, taux ni pourcentage dans une fiche (contrôlé ici, pas seulement à l'écran).
create function private.has_no_amount(p_text text) returns boolean
language sql immutable set search_path = ''
as $$
    select coalesce(p_text, '') !~* '(\$|%|€|\mdollars?\M|\mcents?\M|\mtaux\M)'
$$;

create table public.programs (
    id                  uuid primary key default gen_random_uuid(),
    slug                text not null unique check (slug ~ '^[a-z0-9-]+$'),
    name                text not null check (char_length(btrim(name)) between 1 and 160),
    organization        text not null check (char_length(btrim(organization)) between 1 and 160),
    summary             text not null check (char_length(btrim(summary)) between 1 and 1200),
    criteria            jsonb not null check (jsonb_typeof(criteria) = 'object'),
    required_documents  jsonb not null default '[]' check (jsonb_typeof(required_documents) = 'array'),
    how_to_apply        text check (char_length(how_to_apply) <= 800),
    official_url        text check (official_url ~ '^https://'),
    source_label        text not null check (char_length(btrim(source_label)) between 1 and 200),
    verification_status public.verification_status not null default 'to_verify',
    verified_on         date,
    verified_by         text check (char_length(verified_by) <= 80),
    version             integer not null default 1,
    sort_order          smallint not null default 0,
    is_active           boolean not null default true,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    -- Une fiche vérifiée porte son lien officiel, sa date et l'auteur de la vérification.
    check ((verification_status = 'verified') = (verified_on is not null and verified_by is not null)),
    check (verification_status = 'to_verify' or official_url is not null),
    check (private.has_no_amount(name || ' ' || summary || ' ' || coalesce(how_to_apply, '') || ' '
                                 || required_documents::text || ' ' || criteria::text))
);

-- Explications et modèles de lettre produits par l'IA à partir de la SEULE fiche (aucune donnée
-- personnelle), mis en cache par version de fiche. Écrits par les fonctions serveur seulement.
create table public.program_explanations (
    program_id      uuid not null references public.programs (id) on delete cascade,
    program_version integer not null,
    explanation     jsonb not null check (jsonb_typeof(explanation) = 'object'),
    model           text not null,
    created_at      timestamptz not null default now(),
    primary key (program_id, program_version)
);

create table public.program_letter_templates (
    program_id      uuid not null references public.programs (id) on delete cascade,
    program_version integer not null,
    kind            text not null check (kind in ('information_request', 'application_follow_up')),
    template        text not null check (char_length(template) between 1 and 6000),
    model           text not null,
    created_at      timestamptz not null default now(),
    primary key (program_id, program_version, kind)
);

-- -----------------------------------------------------------------------------------------------------
-- Dossier (zone « benefits »)
-- -----------------------------------------------------------------------------------------------------
create table public.benefit_assessments (
    id           uuid primary key default gen_random_uuid(),
    care_file_id uuid not null references public.care_files (id) on delete cascade,
    answers      jsonb not null check (jsonb_typeof(answers) = 'object'),
    created_by   uuid references public.users (id) on delete set null,
    created_at   timestamptz not null default now(),
    unique (id, care_file_id)
);
create index benefit_assessments_file on public.benefit_assessments (care_file_id, created_at desc);
create index benefit_assessments_created_by on public.benefit_assessments (created_by);

create table public.care_file_programs (
    id            uuid primary key default gen_random_uuid(),
    care_file_id  uuid not null references public.care_files (id) on delete cascade,
    program_id    uuid not null references public.programs (id),  -- une fiche utilisée se désactive, ne s'efface pas
    assessment_id uuid,
    match_level   public.match_level not null,
    match_reasons jsonb not null default '[]' check (jsonb_typeof(match_reasons) = 'array'),
    status        public.program_status not null default 'to_explore',
    notes         text check (char_length(notes) <= 2000),
    letter_draft  text check (char_length(letter_draft) <= 8000),
    -- Mesures du pilote : repéré → demandé → décision.
    identified_at timestamptz not null default now(),
    requested_at  timestamptz,
    decided_at    timestamptz,
    updated_by    uuid references public.users (id) on delete set null,
    updated_at    timestamptz not null default now(),
    unique (care_file_id, program_id),
    unique (id, care_file_id),
    foreign key (assessment_id, care_file_id)
        references public.benefit_assessments (id, care_file_id) on delete set null (assessment_id)
);
create index care_file_programs_program on public.care_file_programs (program_id);
create index care_file_programs_assessment on public.care_file_programs (assessment_id, care_file_id);
create index care_file_programs_updated_by on public.care_file_programs (updated_by);

create table public.program_checklist_items (
    id                   uuid primary key default gen_random_uuid(),
    care_file_program_id uuid not null,
    care_file_id         uuid not null references public.care_files (id) on delete cascade,
    label                text not null check (char_length(btrim(label)) between 1 and 240),
    origin               text not null default 'custom' check (origin in ('program', 'custom')),
    is_done              boolean not null default false,
    done_by              uuid references public.users (id) on delete set null,
    done_at              timestamptz,
    position             smallint not null default 0,
    created_at           timestamptz not null default now(),
    foreign key (care_file_program_id, care_file_id)
        references public.care_file_programs (id, care_file_id) on delete cascade,
    check (is_done = (done_at is not null))
);
create index program_checklist_items_program on public.program_checklist_items (care_file_program_id, care_file_id);
create index program_checklist_items_file on public.program_checklist_items (care_file_id);
create index program_checklist_items_done_by on public.program_checklist_items (done_by);

-- -----------------------------------------------------------------------------------------------------
-- Déclencheurs
-- -----------------------------------------------------------------------------------------------------
-- Fiche modifiée : nouvelle version (le cache IA de l'ancienne ne sert plus) et, sans vérification datée
-- du jour, retour à « à vérifier ».
create function private.program_versioning() returns trigger
language plpgsql set search_path = ''
as $$
begin
    if (new.name, new.organization, new.summary, new.criteria, new.required_documents, new.how_to_apply,
        new.official_url, new.source_label)
       is distinct from
       (old.name, old.organization, old.summary, old.criteria, old.required_documents, old.how_to_apply,
        old.official_url, old.source_label) then
        new.version := old.version + 1;
        -- Une vérification datée d'aujourd'hui couvre les corrections du jour ; sinon, à revérifier.
        if not (new.verification_status = 'verified' and new.verified_on >= (now() at time zone 'America/Toronto')::date) then
            new.verification_status := 'to_verify';
            new.verified_on := null;
            new.verified_by := null;
        end if;
    end if;
    new.updated_at := now();
    return new;
end;
$$;
create trigger programs_versioning before update on public.programs
    for each row execute function private.program_versioning();

-- Même règle pour les ressources (numéros d'urgence, répit, lignes d'aide).
create function private.resource_reverification() returns trigger
language plpgsql set search_path = ''
as $$
begin
    if (new.name, new.organization, new.phone, new.sms, new.url, new.description, new.hours, new.region,
        new.source_url)
       is distinct from
       (old.name, old.organization, old.phone, old.sms, old.url, old.description, old.hours, old.region,
        old.source_url)
       and not (new.verification_status = 'verified' and new.verified_on >= (now() at time zone 'America/Toronto')::date) then
        new.verification_status := 'to_verify';
        new.verified_on := null;
        new.verified_by := null;
    end if;
    new.updated_at := now();
    return new;
end;
$$;
create trigger resources_reverification before update on public.resources
    for each row execute function private.resource_reverification();

-- Statut d'un programme : dates de demande et de décision tenues par la base (mesures du pilote).
create function private.program_status_dates() returns trigger
language plpgsql set search_path = ''
as $$
begin
    if new.status is distinct from old.status then
        if new.status in ('in_progress', 'obtained', 'refused') and new.requested_at is null then
            new.requested_at := now();
        end if;
        new.decided_at := case when new.status in ('obtained', 'refused') then now() end;
    end if;
    new.updated_by := auth.uid();
    new.updated_at := now();
    return new;
end;
$$;
create trigger care_file_programs_status before update on public.care_file_programs
    for each row execute function private.program_status_dates();

create function private.checklist_done() returns trigger
language plpgsql set search_path = ''
as $$
begin
    if tg_op = 'INSERT' then
        new.done_at := case when new.is_done then now() end;
        new.done_by := case when new.is_done then auth.uid() end;
    elsif new.is_done is distinct from old.is_done then
        new.done_at := case when new.is_done then now() end;
        new.done_by := case when new.is_done then auth.uid() end;
    else
        new.done_at := old.done_at;
        new.done_by := old.done_by;
    end if;
    return new;
end;
$$;
create trigger program_checklist_items_done before insert or update on public.program_checklist_items
    for each row execute function private.checklist_done();

create trigger benefit_assessments_author before insert on public.benefit_assessments
    for each row execute function private.stamp_author();

-- -----------------------------------------------------------------------------------------------------
-- RPC
-- -----------------------------------------------------------------------------------------------------
-- Enregistre les réponses et les résultats du moteur de règles. Un programme probable ou possible est
-- ajouté au dossier avec ses pièces à fournir ; un programme déjà au dossier garde son statut.
-- p_results = [{program_id, match_level, match_reasons}]
create function public.save_benefit_assessment(p_care_file_id uuid, p_answers jsonb, p_results jsonb) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
    v_id uuid;
begin
    if not private.can_write(p_care_file_id, 'benefits') then
        raise exception 'no benefits write access to this care file' using errcode = '42501';
    end if;
    if jsonb_typeof(p_results) is distinct from 'array' or jsonb_array_length(p_results) > 100 then
        raise exception 'invalid results' using errcode = '22023';
    end if;
    insert into public.benefit_assessments (care_file_id, answers) values (p_care_file_id, p_answers)
    returning id into v_id;

    with results as (
        select r.program_id, r.match_level, coalesce(r.match_reasons, '[]'::jsonb) as match_reasons
        from jsonb_to_recordset(p_results) as r(program_id uuid, match_level public.match_level, match_reasons jsonb)
        join public.programs p on p.id = r.program_id and p.is_active
    ),
    updated as (
        update public.care_file_programs c
        set match_level = r.match_level, match_reasons = r.match_reasons, assessment_id = v_id
        from results r
        where c.care_file_id = p_care_file_id and c.program_id = r.program_id
        returning c.program_id
    ),
    inserted as (
        insert into public.care_file_programs (care_file_id, program_id, assessment_id, match_level, match_reasons)
        select p_care_file_id, r.program_id, v_id, r.match_level, r.match_reasons
        from results r
        where r.match_level in ('likely', 'possible')
          and r.program_id not in (select program_id from updated)
          and not exists (
              select 1 from public.care_file_programs c
              where c.care_file_id = p_care_file_id and c.program_id = r.program_id)
        returning id, program_id
    )
    insert into public.program_checklist_items (care_file_program_id, care_file_id, label, origin, position)
    select i.id, p_care_file_id, d.label, 'program', (d.ordinality - 1)::smallint
    from inserted i
    join public.programs p on p.id = i.program_id
    cross join lateral jsonb_array_elements_text(p.required_documents) with ordinality as d(label, ordinality);

    return v_id;
end;
$$;

-- Fiche transmise à l'IA (aucune donnée personnelle), avec ce qui est déjà en cache.
create function public.program_for_ai(p_program_id uuid, p_letter_kind text default null) returns jsonb
language sql stable security definer set search_path = ''
as $$
    select jsonb_build_object(
        'id', p.id,
        'version', p.version,
        'name', p.name,
        'organization', p.organization,
        'summary', p.summary,
        'criteria', p.criteria,
        'required_documents', p.required_documents,
        'how_to_apply', p.how_to_apply,
        'source_label', p.source_label,
        'cached_explanation', (
            select e.explanation from public.program_explanations e
            where e.program_id = p.id and e.program_version = p.version),
        'cached_letter', (
            select t.template from public.program_letter_templates t
            where t.program_id = p.id and t.program_version = p.version and t.kind = p_letter_kind)
    )
    from public.programs p
    where p.id = p_program_id and p.is_active and auth.uid() is not null
$$;

create function public.save_program_explanation(
    p_program_id uuid, p_version integer, p_explanation jsonb, p_model text
) returns void
language sql security definer set search_path = ''
as $$
    insert into public.program_explanations (program_id, program_version, explanation, model)
    values (p_program_id, p_version, p_explanation, p_model)
    on conflict do nothing
$$;

create function public.save_program_letter_template(
    p_program_id uuid, p_version integer, p_kind text, p_template text, p_model text
) returns void
language sql security definer set search_path = ''
as $$
    insert into public.program_letter_templates (program_id, program_version, kind, template, model)
    values (p_program_id, p_version, p_kind, p_template, p_model)
    on conflict do nothing
$$;

-- Suppression et export du dossier : étendus au navigateur de droits.
create or replace function public.delete_care_file(p_care_file_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_actor uuid := auth.uid();
    v_counts jsonb;
begin
    if private.member_access(p_care_file_id) is distinct from 'owner' then
        raise exception 'only the primary caregiver can delete a care file' using errcode = '42501';
    end if;
    select jsonb_build_object(
        'members', (select count(*) from public.care_file_members where care_file_id = p_care_file_id),
        'contacts', (select count(*) from public.contacts where care_file_id = p_care_file_id),
        'consents', (select count(*) from public.consents where care_file_id = p_care_file_id),
        'documents', (select count(*) from public.documents where care_file_id = p_care_file_id),
        'extractions', (select count(*) from public.document_extractions where care_file_id = p_care_file_id),
        'medications', (select count(*) from public.medication_mentions where care_file_id = p_care_file_id),
        'timeline_events', (select count(*) from public.timeline_events where care_file_id = p_care_file_id),
        'programs', (select count(*) from public.care_file_programs where care_file_id = p_care_file_id)
    ) into v_counts;

    insert into public.storage_deletion_queue (bucket_id, object_path)
    select 'documents', d.storage_path from public.documents d where d.care_file_id = p_care_file_id
    on conflict do nothing;

    delete from public.care_files where id = p_care_file_id;
    delete from public.access_log where care_file_id = p_care_file_id;
    insert into public.access_log (actor_id, care_file_id, action, target_type, metadata)
    values (v_actor, p_care_file_id, 'care_file_deleted', 'care_files', v_counts);
    return v_counts;
end;
$$;

create or replace function public.export_care_file(p_care_file_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_export jsonb;
begin
    if not private.can_write(p_care_file_id, 'manage') then
        raise exception 'only the primary caregiver can export the care file' using errcode = '42501';
    end if;
    select jsonb_build_object(
        'format', 'relais-dossier/3',
        'exported_at', now(),
        'care_file', (select to_jsonb(f) - 'owner_id' from public.care_files f where f.id = p_care_file_id),
        'care_recipient', (select to_jsonb(r) - 'care_file_id' from public.care_recipients r where r.care_file_id = p_care_file_id),
        'care_needs', (select to_jsonb(n) - 'care_file_id' - 'updated_by' from public.care_needs n where n.care_file_id = p_care_file_id),
        'contacts', coalesce((
            select jsonb_agg(to_jsonb(c) - 'care_file_id' - 'created_by' order by c.created_at)
            from public.contacts c where c.care_file_id = p_care_file_id), '[]'::jsonb),
        'members', coalesce((
            select jsonb_agg(jsonb_build_object(
                'display_name', u.display_name, 'role', m.role, 'access_level', m.access_level, 'joined_at', m.joined_at)
                order by m.joined_at)
            from public.care_file_members m join public.users u on u.id = m.user_id
            where m.care_file_id = p_care_file_id), '[]'::jsonb),
        'consents', coalesce((
            select jsonb_agg(jsonb_build_object(
                'consent_type', c.consent_type, 'text_version', c.text_version, 'granted_by', c.granted_by,
                'legal_basis', c.legal_basis, 'representative_name', c.representative_name,
                'granted_at', c.granted_at, 'revoked_at', c.revoked_at)
                order by c.granted_at)
            from public.consents c where c.care_file_id = p_care_file_id), '[]'::jsonb),
        'documents', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', d.id, 'mime_type', d.mime_type, 'page_count', d.page_count, 'status', d.status,
                'title', d.title, 'doc_type', d.doc_type, 'doc_date', d.doc_date, 'author', d.author,
                'needs_review', d.needs_review, 'uploaded_at', d.uploaded_at,
                'confirmed', (select e.confirmed_data from public.document_extractions e
                              where e.document_id = d.id and e.status = 'confirmed'))
                order by d.uploaded_at)
            from public.documents d where d.care_file_id = p_care_file_id), '[]'::jsonb),
        'medications_as_written', coalesce((
            select jsonb_agg(jsonb_build_object(
                'name_as_written', m.name_as_written, 'dosage_as_written', m.dosage_as_written,
                'frequency_as_written', m.frequency_as_written, 'document_date', m.document_date,
                'source_document_id', m.source_document_id)
                order by m.created_at)
            from public.medication_mentions m where m.care_file_id = p_care_file_id), '[]'::jsonb),
        'timeline_events', coalesce((
            select jsonb_agg(jsonb_build_object(
                'occurred_on', t.occurred_on, 'event_type', t.event_type, 'title', t.title,
                'description', t.description, 'source_type', t.source_type,
                'source_document_id', t.source_document_id)
                order by t.occurred_on, t.created_at)
            from public.timeline_events t where t.care_file_id = p_care_file_id), '[]'::jsonb),
        'benefit_answers', (
            select a.answers from public.benefit_assessments a
            where a.care_file_id = p_care_file_id order by a.created_at desc limit 1),
        'programs', coalesce((
            select jsonb_agg(jsonb_build_object(
                'program', p.name, 'organization', p.organization, 'match_level', c.match_level,
                'status', c.status, 'notes', c.notes, 'letter_draft', c.letter_draft,
                'identified_at', c.identified_at, 'requested_at', c.requested_at, 'decided_at', c.decided_at,
                'checklist', coalesce((
                    select jsonb_agg(jsonb_build_object('label', i.label, 'is_done', i.is_done) order by i.position, i.created_at)
                    from public.program_checklist_items i where i.care_file_program_id = c.id), '[]'::jsonb))
                order by p.sort_order)
            from public.care_file_programs c join public.programs p on p.id = c.program_id
            where c.care_file_id = p_care_file_id), '[]'::jsonb),
        'access_log', coalesce((
            select jsonb_agg(jsonb_build_object(
                'occurred_at', l.occurred_at, 'action', l.action, 'actor', u.display_name, 'target_type', l.target_type)
                order by l.occurred_at)
            from public.access_log l left join public.users u on u.id = l.actor_id
            where l.care_file_id = p_care_file_id), '[]'::jsonb)
    ) into v_export;

    insert into public.access_log (actor_id, care_file_id, action, target_type)
    values (auth.uid(), p_care_file_id, 'export_requested', 'care_files');
    return v_export;
end;
$$;

do $$
declare
    fn text;
begin
    foreach fn in array array[
        'public.save_benefit_assessment(uuid,jsonb,jsonb)',
        'public.program_for_ai(uuid,text)'
    ] loop
        execute format('revoke all on function %s from public, anon', fn);
        execute format('grant execute on function %s to authenticated', fn);
    end loop;
    foreach fn in array array[
        'public.save_program_explanation(uuid,integer,jsonb,text)',
        'public.save_program_letter_template(uuid,integer,text,text,text)'
    ] loop
        execute format('revoke all on function %s from public, anon, authenticated', fn);
        execute format('grant execute on function %s to service_role', fn);
    end loop;
end;
$$;
revoke all on function private.has_no_amount(text) from public;
grant execute on function private.has_no_amount(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- Privilèges
-- -----------------------------------------------------------------------------------------------------
revoke all on public.programs, public.program_explanations, public.program_letter_templates,
    public.benefit_assessments, public.care_file_programs, public.program_checklist_items from anon, authenticated;
grant all on public.programs, public.program_explanations, public.program_letter_templates,
    public.benefit_assessments, public.care_file_programs, public.program_checklist_items to service_role;

grant select, insert, update, delete on public.programs to authenticated;              -- RLS : admin (MFA) pour écrire
grant select on public.program_explanations, public.program_letter_templates to authenticated;
grant select on public.benefit_assessments to authenticated;                           -- ajout par RPC
grant select on public.care_file_programs to authenticated;                            -- ajout par RPC
grant update (status, notes, letter_draft) on public.care_file_programs to authenticated;
grant select, insert, delete on public.program_checklist_items to authenticated;
grant update (is_done, label, position) on public.program_checklist_items to authenticated;

-- -----------------------------------------------------------------------------------------------------
-- Politiques RLS
-- -----------------------------------------------------------------------------------------------------
alter table public.programs enable row level security;
alter table public.program_explanations enable row level security;
alter table public.program_letter_templates enable row level security;
alter table public.benefit_assessments enable row level security;
alter table public.care_file_programs enable row level security;
alter table public.program_checklist_items enable row level security;

create policy programs_select on public.programs for select to authenticated
    using (is_active or private.is_admin());
create policy programs_admin_insert on public.programs for insert to authenticated with check (private.is_admin());
create policy programs_admin_update on public.programs for update to authenticated
    using (private.is_admin()) with check (private.is_admin());
create policy programs_admin_delete on public.programs for delete to authenticated using (private.is_admin());

create policy program_explanations_select on public.program_explanations for select to authenticated using (true);
create policy program_letter_templates_select on public.program_letter_templates for select to authenticated using (true);

create policy benefit_assessments_select on public.benefit_assessments for select to authenticated
    using (private.can_read(care_file_id, 'benefits'));
create policy care_file_programs_select on public.care_file_programs for select to authenticated
    using (private.can_read(care_file_id, 'benefits'));
create policy care_file_programs_update on public.care_file_programs for update to authenticated
    using (private.can_write(care_file_id, 'benefits')) with check (private.can_write(care_file_id, 'benefits'));

create policy program_checklist_items_select on public.program_checklist_items for select to authenticated
    using (private.can_read(care_file_id, 'benefits'));
create policy program_checklist_items_insert on public.program_checklist_items for insert to authenticated
    with check (private.can_write(care_file_id, 'benefits') and origin = 'custom');
create policy program_checklist_items_update on public.program_checklist_items for update to authenticated
    using (private.can_write(care_file_id, 'benefits')) with check (private.can_write(care_file_id, 'benefits'));
create policy program_checklist_items_delete on public.program_checklist_items for delete to authenticated
    using (private.can_write(care_file_id, 'benefits') and origin = 'custom');
