-- =====================================================================================================
-- Relais — étape 3 : documents, extraction IA, chronologie, médicaments tels qu'écrits.
--
-- Tables : documents, document_extractions, medication_mentions, timeline_events,
--          storage_deletion_queue (fichiers à effacer de Storage, réservée aux fonctions serveur).
-- Bucket privé `documents`, chemin « {care_file_id}/{document_id} ». Téléversement direct par l'auteur
-- d'une entrée « pending_upload » ; AUCUNE lecture directe : un téléchargement passe par la fonction
-- serveur `get-document-url`, qui appelle authorize_document_download (accès + journal) puis émet une
-- URL signée de 60 s.
--
-- Cycle d'un document :
--   register_document (pending_upload) → téléversement Storage → complete_document_upload (uploaded)
--   → fonction `extract-document` : start_document_extraction (processing, exige le consentement
--     ai_document_processing) → save_document_extraction (draft_ready) ou fail_document_extraction
--     (failed + code)
--   → confirm_document (confirmed) : rien n'entre au dossier sans la confirmation de l'aidant.
-- Sans lecture automatique (pas de consentement, photo sans OCR, échec), l'aidant saisit lui-même les
-- éléments : confirm_document sans extraction.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------------------------------
create type public.document_status as enum (
    'pending_upload', 'uploaded', 'processing', 'draft_ready', 'confirmed', 'failed'
);
-- Un brouillon rejeté ou remplacé est effacé, pas conservé (minimisation).
create type public.extraction_status as enum ('draft', 'confirmed');
create type public.extraction_method as enum ('ai', 'manual');
create type public.timeline_event_type as enum (
    'hospitalization', 'discharge', 'appointment', 'test', 'living_setting_change', 'service_change', 'other'
);
create type public.timeline_source as enum ('document', 'manual');  -- « appointment » à l'étape 5

-- -----------------------------------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------------------------------
create table public.documents (
    id                    uuid primary key default gen_random_uuid(),
    care_file_id          uuid not null references public.care_files (id) on delete cascade,
    storage_path          text generated always as (care_file_id::text || '/' || id::text) stored unique,
    mime_type             text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
    size_bytes            integer not null check (size_bytes between 1 and 20971520),
    page_count            smallint check (page_count between 1 and 50),
    status                public.document_status not null default 'pending_upload',
    -- Code de la dernière lecture automatique impossible (jamais de texte libre).
    extraction_error      text check (extraction_error in (
        'ai_consent_missing', 'no_text_layer', 'photo_without_ocr', 'too_long', 'unreadable_pdf',
        'refusal', 'invalid_output', 'ai_unavailable')),
    -- Champs confirmés par l'aidant.
    title                 text check (char_length(title) <= 160),
    doc_type              text check (doc_type in (
        'discharge_summary', 'prescription', 'appointment_notice', 'test_result', 'clinic_letter',
        'assessment', 'administrative', 'other')),
    doc_date              date,
    author                text check (char_length(author) <= 160),
    needs_review          boolean not null default false,  -- manuscrit, flou ou partiellement lisible
    uploaded_by           uuid references public.users (id) on delete set null,
    uploaded_at           timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    unique (id, care_file_id),
    check ((status = 'failed') = (extraction_error is not null))
);
create index documents_file on public.documents (care_file_id, uploaded_at desc);
create index documents_uploaded_by on public.documents (uploaded_by);

create table public.document_extractions (
    id             uuid primary key default gen_random_uuid(),
    document_id    uuid not null,
    care_file_id   uuid not null references public.care_files (id) on delete cascade,
    status         public.extraction_status not null default 'draft',
    method         public.extraction_method not null,
    schema_version text not null check (schema_version ~ '^[0-9]+$'),
    draft          jsonb not null check (jsonb_typeof(draft) = 'object'),  -- sortie validée (Zod + garde-fous)
    legibility     text check (legibility in ('clear', 'partial', 'handwritten', 'blurry')),
    needs_review   boolean not null default false,
    review_reasons text[] not null default '{}',
    guard_flags    text[] not null default '{}',
    confirmed_data jsonb check (confirmed_data is null or jsonb_typeof(confirmed_data) = 'object'),
    confirmed_by   uuid references public.users (id) on delete set null,
    confirmed_at   timestamptz,
    created_by     uuid references public.users (id) on delete set null,
    created_at     timestamptz not null default now(),
    foreign key (document_id, care_file_id) references public.documents (id, care_file_id) on delete cascade,
    check ((status = 'confirmed') = (confirmed_at is not null)),
    check (status <> 'confirmed' or confirmed_data is not null),
    check ((method = 'ai') = (legibility is not null))
);
-- Au plus un brouillon ou une confirmation par document.
create unique index document_extractions_one_per_document on public.document_extractions (document_id);
create index document_extractions_document on public.document_extractions (document_id, care_file_id);
create index document_extractions_file on public.document_extractions (care_file_id);
create index document_extractions_confirmed_by on public.document_extractions (confirmed_by);
create index document_extractions_created_by on public.document_extractions (created_by);

-- « Médicaments tels qu'écrits » : jamais interprétés, toujours reliés à leur document source.
create table public.medication_mentions (
    id                   uuid primary key default gen_random_uuid(),
    care_file_id         uuid not null references public.care_files (id) on delete cascade,
    source_document_id   uuid not null,
    name_as_written      text not null check (char_length(btrim(name_as_written)) between 1 and 160),
    dosage_as_written    text check (char_length(dosage_as_written) <= 160),
    frequency_as_written text check (char_length(frequency_as_written) <= 160),
    document_date        date,
    created_by           uuid references public.users (id) on delete set null,
    created_at           timestamptz not null default now(),
    foreign key (source_document_id, care_file_id) references public.documents (id, care_file_id) on delete cascade
);
create index medication_mentions_file on public.medication_mentions (care_file_id);
create index medication_mentions_document on public.medication_mentions (source_document_id, care_file_id);
create index medication_mentions_created_by on public.medication_mentions (created_by);

create table public.timeline_events (
    id                 uuid primary key default gen_random_uuid(),
    care_file_id       uuid not null references public.care_files (id) on delete cascade,
    event_type         public.timeline_event_type not null,
    occurred_on        date not null,
    title              text not null check (char_length(btrim(title)) between 1 and 160),
    description        text check (char_length(description) <= 2000),
    source_type        public.timeline_source not null default 'manual',
    source_document_id uuid,
    created_by         uuid references public.users (id) on delete set null,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    foreign key (source_document_id, care_file_id) references public.documents (id, care_file_id) on delete cascade,
    -- Chaque événement est relié à sa source.
    check ((source_type = 'document') = (source_document_id is not null))
);
create index timeline_events_file_date on public.timeline_events (care_file_id, occurred_on desc);
create index timeline_events_document on public.timeline_events (source_document_id, care_file_id);
create index timeline_events_created_by on public.timeline_events (created_by);

-- Fichiers à effacer de Storage. La base ne peut pas effacer un objet elle-même (seule l'API Storage le
-- fait vraiment) : la suppression d'un document ou d'un dossier inscrit ici ses chemins, que la fonction
-- serveur efface aussitôt ; une tâche planifiée reprend ce qui resterait (voir PROGRESS.md).
create table public.storage_deletion_queue (
    id          bigint generated always as identity primary key,
    bucket_id   text not null,
    object_path text not null,
    enqueued_at timestamptz not null default now(),
    attempts    integer not null default 0,
    unique (bucket_id, object_path)
);

-- -----------------------------------------------------------------------------------------------------
-- Déclencheurs
-- -----------------------------------------------------------------------------------------------------
create trigger documents_touch before update on public.documents
    for each row execute function private.touch_updated_at();
create trigger timeline_events_touch before update on public.timeline_events
    for each row execute function private.touch_updated_at();
create trigger timeline_events_author before insert or update on public.timeline_events
    for each row execute function private.stamp_author();
create trigger medication_mentions_author before insert or update on public.medication_mentions
    for each row execute function private.stamp_author();

-- -----------------------------------------------------------------------------------------------------
-- Fonctions d'accès
-- -----------------------------------------------------------------------------------------------------
-- Politique Storage : seul l'auteur d'une entrée « pending_upload » dépose le fichier, à son chemin exact.
create function private.document_upload_allowed(p_object_name text) returns boolean
language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.documents d
        where d.storage_path = p_object_name
          and d.uploaded_by = auth.uid()
          and d.status = 'pending_upload'
          and private.can_write(d.care_file_id, 'health')
    )
$$;

-- Document verrouillé pour une écriture de santé par l'utilisateur courant (sinon 42501).
create function private.lock_document_for_write(p_document_id uuid) returns public.documents
language plpgsql security definer set search_path = ''
as $$
declare
    v_doc public.documents%rowtype;
begin
    select * into v_doc from public.documents where id = p_document_id for update;
    if not found or not private.can_write(v_doc.care_file_id, 'health') then
        raise exception 'document not found or not writable' using errcode = '42501';
    end if;
    return v_doc;
end;
$$;

revoke all on function private.document_upload_allowed(text) from public;
revoke all on function private.lock_document_for_write(uuid) from public;
grant execute on function private.document_upload_allowed(text) to authenticated, service_role;
grant execute on function private.lock_document_for_write(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- RPC appelées par l'application (rôle authenticated)
-- Codes d'erreur propres à Relais : RLA01 = consentement de lecture automatique absent ;
--                                   RLA02 = le document n'est pas dans l'état attendu.
-- -----------------------------------------------------------------------------------------------------
create function public.register_document(p_care_file_id uuid, p_mime_type text, p_size_bytes integer) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
    v_id uuid;
begin
    if not private.can_write(p_care_file_id, 'health') then
        raise exception 'no health write access to this care file' using errcode = '42501';
    end if;
    insert into public.documents (care_file_id, mime_type, size_bytes, uploaded_by)
    values (p_care_file_id, p_mime_type, p_size_bytes, auth.uid())
    returning id into v_id;
    return v_id;
end;
$$;

create function public.complete_document_upload(p_document_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_doc public.documents%rowtype := private.lock_document_for_write(p_document_id);
begin
    if v_doc.status <> 'pending_upload' or v_doc.uploaded_by is distinct from auth.uid() then
        raise exception 'document is not awaiting this upload' using errcode = 'RLA02';
    end if;
    if not exists (
        select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = v_doc.storage_path
    ) then
        raise exception 'file not found in storage' using errcode = 'RLA02';
    end if;
    update public.documents set status = 'uploaded' where id = v_doc.id;
    insert into public.access_log (actor_id, care_file_id, action, target_type, target_id)
    values (auth.uid(), v_doc.care_file_id, 'document_uploaded', 'documents', v_doc.id);
end;
$$;

-- Appelée par la fonction `extract-document` AVEC le jeton de l'utilisateur : vérifie ses droits et le
-- consentement de lecture automatique, puis renvoie de quoi lire le fichier et le dictionnaire de
-- pseudonymisation (noms et adresses connus du dossier). Ce dictionnaire ne quitte pas la fonction.
create function public.start_document_extraction(p_document_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_doc public.documents%rowtype := private.lock_document_for_write(p_document_id);
begin
    if not private.file_consent_active(v_doc.care_file_id, 'ai_document_processing') then
        raise exception 'automatic reading is not authorized for this care file' using errcode = 'RLA01';
    end if;
    if not (v_doc.status in ('uploaded', 'draft_ready', 'failed')
            or (v_doc.status = 'processing' and v_doc.updated_at < now() - interval '2 minutes')) then
        raise exception 'document cannot be read now' using errcode = 'RLA02';
    end if;
    update public.documents set status = 'processing', extraction_error = null where id = v_doc.id;

    return jsonb_build_object(
        'care_file_id', v_doc.care_file_id,
        'storage_path', v_doc.storage_path,
        'mime_type', v_doc.mime_type,
        'persons', coalesce((
            select jsonb_agg(distinct n) from (
                select r.first_name as n from public.care_recipients r where r.care_file_id = v_doc.care_file_id
                union all
                select r.last_name from public.care_recipients r where r.care_file_id = v_doc.care_file_id
                union all
                select u.display_name from public.care_file_members m join public.users u on u.id = m.user_id
                where m.care_file_id = v_doc.care_file_id
                union all
                select c.name from public.contacts c
                where c.care_file_id = v_doc.care_file_id and c.kind not in ('clsc', 'pharmacy', 'residence')
                union all
                select c.representative_name from public.consents c where c.care_file_id = v_doc.care_file_id
            ) names where n is not null and char_length(btrim(n)) >= 2), '[]'::jsonb),
        'addresses', coalesce((
            select jsonb_agg(distinct c.address) from public.contacts c
            where c.care_file_id = v_doc.care_file_id and char_length(btrim(c.address)) >= 5), '[]'::jsonb)
    );
end;
$$;

-- Confirmation par l'aidant : ce qu'il a gardé ou corrigé entre au dossier, relié au document source.
-- p_extraction_id null : saisie à la main, sans lecture automatique.
-- p_confirmed = { document: {title, doc_type, doc_date, author, needs_review}, summary,
--                 medications: [{name, dosage, frequency}], timeline_events: [{event_type, occurred_on,
--                 title, description}], action_items: [{text}] }
create function public.confirm_document(p_document_id uuid, p_extraction_id uuid, p_confirmed jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_doc public.documents%rowtype := private.lock_document_for_write(p_document_id);
    v_meta jsonb := coalesce(p_confirmed -> 'document', '{}'::jsonb);
    v_date date := nullif(v_meta ->> 'doc_date', '')::date;
    v_meds integer;
    v_events integer;
begin
    if v_doc.status in ('pending_upload', 'processing', 'confirmed') then
        raise exception 'document cannot be confirmed now' using errcode = 'RLA02';
    end if;
    if jsonb_typeof(p_confirmed) is distinct from 'object'
       or jsonb_typeof(coalesce(p_confirmed -> 'medications', '[]')) <> 'array'
       or jsonb_typeof(coalesce(p_confirmed -> 'timeline_events', '[]')) <> 'array'
       or jsonb_typeof(coalesce(p_confirmed -> 'action_items', '[]')) <> 'array'
       or jsonb_array_length(coalesce(p_confirmed -> 'medications', '[]')) > 50
       or jsonb_array_length(coalesce(p_confirmed -> 'timeline_events', '[]')) > 50
       or jsonb_array_length(coalesce(p_confirmed -> 'action_items', '[]')) > 50
       or char_length(coalesce(p_confirmed ->> 'summary', '')) > 1200 then
        raise exception 'invalid confirmation payload' using errcode = '22023';
    end if;

    if p_extraction_id is null then
        delete from public.document_extractions where document_id = v_doc.id and status = 'draft';
        insert into public.document_extractions (
            document_id, care_file_id, status, method, schema_version, draft,
            confirmed_data, confirmed_by, confirmed_at, created_by)
        values (v_doc.id, v_doc.care_file_id, 'confirmed', 'manual', '1', '{}'::jsonb,
                p_confirmed, auth.uid(), now(), auth.uid());
    else
        update public.document_extractions
        set status = 'confirmed', confirmed_data = p_confirmed, confirmed_by = auth.uid(), confirmed_at = now()
        where id = p_extraction_id and document_id = v_doc.id and status = 'draft';
        if not found then
            raise exception 'draft not found or already handled' using errcode = 'RLA02';
        end if;
    end if;

    update public.documents set
        status = 'confirmed',
        extraction_error = null,
        title = nullif(btrim(v_meta ->> 'title'), ''),
        doc_type = nullif(v_meta ->> 'doc_type', ''),
        doc_date = v_date,
        author = nullif(btrim(v_meta ->> 'author'), ''),
        needs_review = coalesce((v_meta ->> 'needs_review')::boolean, false)
    where id = v_doc.id;

    insert into public.medication_mentions (
        care_file_id, source_document_id, name_as_written, dosage_as_written, frequency_as_written, document_date)
    select v_doc.care_file_id, v_doc.id, btrim(m.name), nullif(btrim(m.dosage), ''), nullif(btrim(m.frequency), ''), v_date
    from jsonb_to_recordset(coalesce(p_confirmed -> 'medications', '[]')) as m(name text, dosage text, frequency text);
    get diagnostics v_meds = row_count;

    insert into public.timeline_events (
        care_file_id, event_type, occurred_on, title, description, source_type, source_document_id)
    select v_doc.care_file_id, e.event_type::public.timeline_event_type, e.occurred_on::date, btrim(e.title),
           nullif(btrim(e.description), ''), 'document', v_doc.id
    from jsonb_to_recordset(coalesce(p_confirmed -> 'timeline_events', '[]'))
        as e(event_type text, occurred_on text, title text, description text);
    get diagnostics v_events = row_count;

    insert into public.access_log (actor_id, care_file_id, action, target_type, target_id, metadata)
    values (auth.uid(), v_doc.care_file_id, 'extraction_confirmed', 'documents', v_doc.id,
            jsonb_build_object('medications', v_meds, 'timeline_events', v_events,
                               'method', case when p_extraction_id is null then 'manual' else 'ai' end));
end;
$$;

-- Rejet d'un brouillon entier : il est effacé (minimisation) et le document redevient « à lire »
-- (nouvelle lecture ou saisie à la main).
create function public.discard_extraction(p_extraction_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_document_id uuid;
    v_doc public.documents%rowtype;
begin
    select e.document_id into v_document_id from public.document_extractions e
    where e.id = p_extraction_id and e.status = 'draft';
    if not found then
        raise exception 'draft not found or already handled' using errcode = 'RLA02';
    end if;
    v_doc := private.lock_document_for_write(v_document_id);
    delete from public.document_extractions where id = p_extraction_id;
    update public.documents set status = 'uploaded' where id = v_doc.id and status = 'draft_ready';
end;
$$;

-- Suppression d'un document : cascade sur l'extraction, les médicaments et les événements qui en
-- viennent ; le fichier est inscrit pour effacement et la fonction serveur l'efface aussitôt.
create function public.delete_document(p_document_id uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
    v_doc public.documents%rowtype := private.lock_document_for_write(p_document_id);
begin
    insert into public.storage_deletion_queue (bucket_id, object_path)
    values ('documents', v_doc.storage_path) on conflict do nothing;
    delete from public.documents where id = v_doc.id;
    insert into public.access_log (actor_id, care_file_id, action, target_type, target_id)
    values (auth.uid(), v_doc.care_file_id, 'document_deleted', 'documents', v_doc.id);
    return v_doc.storage_path;
end;
$$;

-- Seule voie de lecture d'un fichier : vérifie l'accès, journalise, renvoie le chemin à signer.
create function public.authorize_document_download(p_document_id uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
    v_doc public.documents%rowtype;
begin
    select * into v_doc from public.documents where id = p_document_id;
    if not found or not private.can_read(v_doc.care_file_id, 'health') then
        raise exception 'document not found or not readable' using errcode = '42501';
    end if;
    if v_doc.status = 'pending_upload' then
        raise exception 'file not uploaded yet' using errcode = 'RLA02';
    end if;
    insert into public.access_log (actor_id, care_file_id, action, target_type, target_id)
    values (auth.uid(), v_doc.care_file_id, 'document_viewed', 'documents', v_doc.id);
    return v_doc.storage_path;
end;
$$;

-- -----------------------------------------------------------------------------------------------------
-- RPC réservées aux fonctions serveur (rôle service_role)
-- -----------------------------------------------------------------------------------------------------
create function public.save_document_extraction(
    p_document_id uuid,
    p_actor_id uuid,
    p_draft jsonb,
    p_schema_version text,
    p_legibility text,
    p_needs_review boolean,
    p_review_reasons text[],
    p_guard_flags text[],
    p_page_count integer
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
    v_doc public.documents%rowtype;
    v_id uuid;
begin
    select * into v_doc from public.documents where id = p_document_id for update;
    if not found then
        return null;  -- document supprimé pendant la lecture : rien à garder
    end if;
    if v_doc.status <> 'processing' then
        raise exception 'document is not being read' using errcode = 'RLA02';
    end if;
    delete from public.document_extractions where document_id = v_doc.id and status = 'draft';  -- brouillon remplacé
    insert into public.document_extractions (
        document_id, care_file_id, method, schema_version, draft, legibility, needs_review,
        review_reasons, guard_flags, created_by)
    values (v_doc.id, v_doc.care_file_id, 'ai', p_schema_version, p_draft, p_legibility, p_needs_review,
            coalesce(p_review_reasons, '{}'), coalesce(p_guard_flags, '{}'), p_actor_id)
    returning id into v_id;
    update public.documents
    set status = 'draft_ready', page_count = coalesce(p_page_count, page_count), needs_review = p_needs_review
    where id = v_doc.id;
    return v_id;
end;
$$;

create function public.fail_document_extraction(p_document_id uuid, p_code text, p_page_count integer default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
    update public.documents
    set status = 'failed', extraction_error = p_code, page_count = coalesce(p_page_count, page_count)
    where id = p_document_id and status = 'processing';
end;
$$;

-- -----------------------------------------------------------------------------------------------------
-- Suppression et export du dossier : étendus aux documents
-- -----------------------------------------------------------------------------------------------------
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
        'timeline_events', (select count(*) from public.timeline_events where care_file_id = p_care_file_id)
    ) into v_counts;

    -- Les fichiers sont inscrits pour effacement AVANT la cascade (la fonction serveur les efface ensuite).
    insert into public.storage_deletion_queue (bucket_id, object_path)
    select 'documents', d.storage_path from public.documents d where d.care_file_id = p_care_file_id
    on conflict do nothing;

    delete from public.care_files where id = p_care_file_id;           -- cascade sur les tables liées
    delete from public.access_log where care_file_id = p_care_file_id;  -- y compris les entrées de la cascade
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
        'format', 'relais-dossier/2',
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
        -- Les fichiers eux-mêmes se téléchargent un à un depuis l'application (URL signées journalisées).
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
        'public.register_document(uuid,text,integer)',
        'public.complete_document_upload(uuid)',
        'public.start_document_extraction(uuid)',
        'public.confirm_document(uuid,uuid,jsonb)',
        'public.discard_extraction(uuid)',
        'public.delete_document(uuid)',
        'public.authorize_document_download(uuid)'
    ] loop
        execute format('revoke all on function %s from public, anon', fn);
        execute format('grant execute on function %s to authenticated', fn);
    end loop;
    foreach fn in array array[
        'public.save_document_extraction(uuid,uuid,jsonb,text,text,boolean,text[],text[],integer)',
        'public.fail_document_extraction(uuid,text,integer)'
    ] loop
        execute format('revoke all on function %s from public, anon, authenticated', fn);
        execute format('grant execute on function %s to service_role', fn);
    end loop;
end;
$$;

-- -----------------------------------------------------------------------------------------------------
-- Privilèges
-- -----------------------------------------------------------------------------------------------------
revoke all on public.documents, public.document_extractions, public.medication_mentions,
    public.timeline_events, public.storage_deletion_queue from anon, authenticated;
grant all on public.documents, public.document_extractions, public.medication_mentions,
    public.timeline_events, public.storage_deletion_queue to service_role;

grant select on public.documents, public.document_extractions to authenticated;  -- écritures par RPC
grant select, delete on public.medication_mentions to authenticated;           -- ajout par confirm_document
grant select, insert, delete on public.timeline_events to authenticated;
grant update (event_type, occurred_on, title, description) on public.timeline_events to authenticated;

-- -----------------------------------------------------------------------------------------------------
-- Politiques RLS
-- -----------------------------------------------------------------------------------------------------
alter table public.documents enable row level security;
alter table public.document_extractions enable row level security;
alter table public.medication_mentions enable row level security;
alter table public.timeline_events enable row level security;
alter table public.storage_deletion_queue enable row level security;  -- aucune politique : service_role seulement

create policy documents_select on public.documents for select to authenticated
    using (private.can_read(care_file_id, 'health'));
create policy document_extractions_select on public.document_extractions for select to authenticated
    using (private.can_read(care_file_id, 'health'));

create policy medication_mentions_select on public.medication_mentions for select to authenticated
    using (private.can_read(care_file_id, 'health'));
create policy medication_mentions_delete on public.medication_mentions for delete to authenticated
    using (private.can_write(care_file_id, 'health'));

-- Un ajout direct à la chronologie est toujours « à la main » ; les événements tirés d'un document
-- passent par confirm_document.
create policy timeline_events_select on public.timeline_events for select to authenticated
    using (private.can_read(care_file_id, 'health'));
create policy timeline_events_insert on public.timeline_events for insert to authenticated
    with check (private.can_write(care_file_id, 'health') and source_type = 'manual' and source_document_id is null);
create policy timeline_events_update on public.timeline_events for update to authenticated
    using (private.can_write(care_file_id, 'health')) with check (private.can_write(care_file_id, 'health'));
create policy timeline_events_delete on public.timeline_events for delete to authenticated
    using (private.can_write(care_file_id, 'health'));

-- -----------------------------------------------------------------------------------------------------
-- Storage : bucket privé, limites de taille et de type ; dépôt seulement, aucune lecture directe.
-- -----------------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 20971520, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy relais_documents_upload on storage.objects for insert to authenticated
    with check (bucket_id = 'documents' and private.document_upload_allowed(name));
