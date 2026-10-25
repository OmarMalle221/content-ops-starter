-- =====================================================================================================
-- Relais v0.1 — schéma proposé (PostgreSQL 16 / Supabase, région ca-central-1)
--
-- PROPOSITION à valider. Après le feu vert, ce fichier sera découpé en migrations par étape
-- (supabase/migrations/) et couvert par des tests RLS automatisés (supabase/tests/rls_test.sql).
-- Vérifié : s'applique sans erreur sur PostgreSQL 16 + shim Supabase (rôles, auth.uid(), storage).
--
-- Principes
--   * Tables, colonnes et code en anglais ; commentaires en français.
--   * RLS activée sur toutes les tables exposées. Aucun accès anon, sauf `resources` (écran d'urgence).
--   * Les règles d'accès passent par des fonctions SECURITY DEFINER du schéma `private`
--     (non exposé par l'API), ce qui évite la récursion RLS sur care_file_members.
--   * Matrice d'accès par « zone » de données (data_area), voir private.can_read / private.can_write.
--   * Écritures de santé conditionnées aux consentements actifs (personne aidée + auteur).
--   * Aucun renseignement de santé dans access_log ni ai_calls : identifiants et compteurs seulement.
--   * Le NAM n'est jamais stocké en champ structuré (minimisation).
-- =====================================================================================================

create extension if not exists citext;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------------------------------
create type public.app_role as enum ('member', 'relais_worker', 'admin');
create type public.member_role as enum ('primary_caregiver', 'family_member', 'care_recipient', 'relais_worker');
create type public.access_level as enum ('owner', 'full', 'coordination', 'read_only');
create type public.data_area as enum ('profile', 'coordination', 'health', 'benefits', 'manage');

-- Consentements : 4 portées « utilisateur » + 2 portées « dossier » (données de la personne aidée).
create type public.consent_type as enum (
    'privacy_policy',          -- politique de confidentialité (préalable au compte)
    'health_information',      -- collecte et usage de renseignements de santé (distinct)
    'email_reminders',         -- rappels par courriel
    'pilot_evaluation',        -- usage des réponses pour évaluer le pilote
    'care_recipient_data',     -- dossier : consentement de la personne aidée ou de son représentant
    'ai_document_processing'   -- dossier : envoi de documents pseudonymisés au fournisseur d'IA
);
create type public.consent_grantor as enum (
    'self',                       -- l'utilisateur pour lui-même
    'care_recipient_in_app',      -- la personne aidée, depuis son propre compte
    'care_recipient_signed_form', -- la personne aidée, formulaire signé enregistré par l'aidant
    'legal_representative'        -- mandataire, tuteur ou autre représentant
);
create type public.legal_basis as enum (
    'person_consents', 'homologated_protection_mandate', 'tutorship', 'power_of_attorney', 'other'
);
create type public.living_setting as enum ('home', 'rpa', 'intermediate_resource', 'chsld', 'hospital', 'other');
create type public.contact_kind as enum (
    'clsc', 'social_worker', 'physician', 'pharmacy', 'notary', 'residence', 'home_care', 'other'
);
create type public.document_status as enum (
    'pending_upload', 'uploaded', 'processing', 'draft_ready', 'confirmed', 'discarded', 'failed'
);
create type public.extraction_status as enum ('draft', 'confirmed', 'discarded');
create type public.timeline_event_type as enum (
    'hospitalization', 'discharge', 'appointment', 'living_setting_change', 'service_change', 'other'
);
create type public.timeline_source as enum ('document', 'appointment', 'manual');
create type public.program_status as enum ('to_explore', 'in_progress', 'obtained', 'refused');
create type public.verification_status as enum ('to_verify', 'verified');
create type public.task_status as enum ('todo', 'in_progress', 'done', 'cancelled');
create type public.resource_category as enum (
    'emergency', 'crisis_line', 'psychosocial_line', 'respite', 'caregiver_support', 'elder_abuse', 'info'
);
create type public.support_origin as enum ('button', 'distress_screen', 'checkin');
create type public.support_status as enum ('new', 'assigned', 'in_progress', 'closed');
create type public.ai_purpose as enum ('document_extraction', 'program_explanation', 'letter_draft');
create type public.access_action as enum (
    'file_opened', 'document_uploaded', 'document_viewed', 'document_deleted', 'extraction_viewed',
    'extraction_confirmed', 'prep_sheet_printed', 'member_invited', 'member_joined', 'member_removed',
    'member_access_changed', 'consent_granted', 'consent_revoked', 'export_requested', 'care_file_deleted'
);

-- -----------------------------------------------------------------------------------------------------
-- Utilisateurs et dossiers
-- -----------------------------------------------------------------------------------------------------
create table public.users (
    id           uuid primary key references auth.users (id) on delete cascade,
    display_name text check (char_length(display_name) <= 80),
    app_role     public.app_role not null default 'member',  -- modifiable par service_role seulement
    created_at   timestamptz not null default now()
);

create table public.care_files (
    id         uuid primary key default gen_random_uuid(),
    owner_id   uuid not null references public.users (id),  -- transfert ou suppression avant de supprimer le compte
    title      text not null check (char_length(title) between 1 and 80),  -- ex. « Maman »
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.care_file_members (
    care_file_id uuid not null references public.care_files (id) on delete cascade,
    user_id      uuid not null references public.users (id) on delete cascade,
    role         public.member_role not null,
    access_level public.access_level not null,
    invited_by   uuid references public.users (id) on delete set null,
    joined_at    timestamptz not null default now(),
    primary key (care_file_id, user_id),
    -- L'aidant principal est le seul propriétaire ; la personne aidée est en lecture seule.
    check ((role = 'primary_caregiver') = (access_level = 'owner')),
    check (role <> 'care_recipient' or access_level = 'read_only')
);
create unique index care_file_members_one_owner on public.care_file_members (care_file_id) where access_level = 'owner';
create index care_file_members_user on public.care_file_members (user_id);

create table public.care_file_invitations (
    id           uuid primary key default gen_random_uuid(),
    care_file_id uuid not null references public.care_files (id) on delete cascade,
    email        citext not null,
    role         public.member_role not null check (role <> 'primary_caregiver'),
    access_level public.access_level not null check (access_level <> 'owner'),
    token_hash   text not null unique,  -- SHA-256 du jeton envoyé par courriel ; le jeton n'est jamais stocké
    invited_by   uuid not null references public.users (id) on delete cascade,
    created_at   timestamptz not null default now(),
    expires_at   timestamptz not null default now() + interval '7 days',
    accepted_at  timestamptz,
    accepted_by  uuid references public.users (id) on delete set null,
    revoked_at   timestamptz,
    check (role <> 'care_recipient' or access_level = 'read_only')
);

create table public.consents (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references public.users (id) on delete cascade,  -- qui enregistre
    care_file_id        uuid references public.care_files (id) on delete cascade,     -- null = portée utilisateur
    consent_type        public.consent_type not null,
    granted_by          public.consent_grantor not null default 'self',
    legal_basis         public.legal_basis,
    representative_name text check (char_length(representative_name) <= 120),
    text_version        text not null,   -- version du texte affiché (ex. « health_information@2026-11-01 »)
    text_sha256         text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
    granted_at          timestamptz not null default now(),
    revoked_at          timestamptz,
    revoked_by          uuid references public.users (id) on delete set null,
    check (
        (consent_type in ('care_recipient_data', 'ai_document_processing')) = (care_file_id is not null)
    ),
    check ((care_file_id is null) = (granted_by = 'self')),
    check (consent_type <> 'care_recipient_data' or legal_basis is not null),
    check (granted_by <> 'legal_representative' or representative_name is not null)
);
create unique index consents_active_user on public.consents (user_id, consent_type)
    where care_file_id is null and revoked_at is null;
create unique index consents_active_file on public.consents (care_file_id, consent_type)
    where care_file_id is not null and revoked_at is null;

-- -----------------------------------------------------------------------------------------------------
-- Personne aidée
-- -----------------------------------------------------------------------------------------------------
-- Zone « profile » (tous les membres) : le strict nécessaire pour coordonner.
create table public.care_recipients (
    care_file_id         uuid primary key references public.care_files (id) on delete cascade,
    first_name           text not null check (char_length(first_name) between 1 and 60),
    last_name            text check (char_length(last_name) <= 60),
    birth_year           smallint check (birth_year >= 1900),  -- âge sans date de naissance complète
    living_setting       public.living_setting not null,
    living_setting_since date,
    residence_name       text check (char_length(residence_name) <= 120),
    chsld_waitlist       boolean not null default false,
    chsld_waitlist_since date,
    updated_at           timestamptz not null default now(),
    check (chsld_waitlist or chsld_waitlist_since is null)
);

-- Zone « health » : autonomie décrite par l'aidant, services en place, besoins d'adaptation.
create table public.care_needs (
    care_file_id          uuid primary key references public.care_files (id) on delete cascade,
    autonomy_description  text check (char_length(autonomy_description) <= 4000),
    services_in_place     jsonb not null default '[]' check (jsonb_typeof(services_in_place) = 'array'),
    home_adaptation_needs text check (char_length(home_adaptation_needs) <= 2000),
    updated_by            uuid references public.users (id) on delete set null,
    updated_at            timestamptz not null default now()
);

create table public.contacts (
    id           uuid primary key default gen_random_uuid(),
    care_file_id uuid not null references public.care_files (id) on delete cascade,
    kind         public.contact_kind not null,
    name         text not null check (char_length(name) between 1 and 120),
    organization text check (char_length(organization) <= 120),
    phone        text check (char_length(phone) <= 40),
    email        citext,
    address      text check (char_length(address) <= 240),
    notes        text check (char_length(notes) <= 1000),
    created_by   uuid references public.users (id) on delete set null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique (id, care_file_id)
);
create index contacts_file on public.contacts (care_file_id);

-- -----------------------------------------------------------------------------------------------------
-- Documents, extractions, chronologie
-- -----------------------------------------------------------------------------------------------------
create table public.documents (
    id                uuid primary key default gen_random_uuid(),
    care_file_id      uuid not null references public.care_files (id) on delete cascade,
    storage_path      text not null unique,  -- « {care_file_id}/{id} » dans le bucket privé `documents`
    mime_type         text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
    size_bytes        integer not null check (size_bytes between 1 and 20 * 1024 * 1024),
    page_count        smallint check (page_count between 1 and 50),
    status            public.document_status not null default 'pending_upload',
    -- Champs confirmés par l'aidant (copiés depuis l'extraction confirmée).
    title             text check (char_length(title) <= 160),
    doc_type          text check (char_length(doc_type) <= 60),
    doc_date          date,
    author            text check (char_length(author) <= 160),
    needs_review      boolean not null default false,  -- manuscrit, flou ou partiellement lisible
    uploaded_by       uuid references public.users (id) on delete set null,
    uploaded_at       timestamptz not null default now(),
    unique (id, care_file_id),
    check (storage_path = care_file_id::text || '/' || id::text)
);
create index documents_file on public.documents (care_file_id);

create table public.document_extractions (
    id             uuid primary key default gen_random_uuid(),
    document_id    uuid not null,
    care_file_id   uuid not null references public.care_files (id) on delete cascade,
    status         public.extraction_status not null default 'draft',
    draft          jsonb not null,           -- sortie IA validée par le schéma Zod (version ci-dessous)
    schema_version text not null,
    legibility     text not null check (legibility in ('clear', 'partial', 'handwritten', 'blurry')),
    needs_review   boolean not null default false,
    review_reasons text[] not null default '{}',
    guard_flags    text[] not null default '{}',  -- ex. « advice_language » détecté par le garde-fou
    confirmed_data jsonb,                      -- ce que l'aidant a gardé ou corrigé
    confirmed_by   uuid references public.users (id) on delete set null,
    confirmed_at   timestamptz,
    created_at     timestamptz not null default now(),
    foreign key (document_id, care_file_id) references public.documents (id, care_file_id) on delete cascade,
    check ((status = 'confirmed') = (confirmed_at is not null))
);
create index document_extractions_document on public.document_extractions (document_id);

-- « Médicaments tels qu'écrits » : jamais interprétés, toujours reliés à leur document source.
create table public.medication_mentions (
    id                 uuid primary key default gen_random_uuid(),
    care_file_id       uuid not null references public.care_files (id) on delete cascade,
    source_document_id uuid not null,
    name_as_written    text not null check (char_length(name_as_written) <= 160),
    dosage_as_written  text check (char_length(dosage_as_written) <= 160),
    frequency_as_written text check (char_length(frequency_as_written) <= 160),
    document_date      date,
    created_by         uuid references public.users (id) on delete set null,
    created_at         timestamptz not null default now(),
    foreign key (source_document_id, care_file_id) references public.documents (id, care_file_id) on delete cascade
);
create index medication_mentions_file on public.medication_mentions (care_file_id);

create table public.appointments (
    id                 uuid primary key default gen_random_uuid(),
    care_file_id       uuid not null references public.care_files (id) on delete cascade,
    starts_at          timestamptz not null,
    ends_at            timestamptz,
    location           text check (char_length(location) <= 240),
    contact_id         uuid,
    purpose            text check (char_length(purpose) <= 240),
    companion_id       uuid references public.users (id) on delete set null,  -- qui accompagne
    notes              text check (char_length(notes) <= 2000),
    source_document_id uuid,
    reminder_sent_at   timestamptz,
    created_by         uuid references public.users (id) on delete set null,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    unique (id, care_file_id),
    foreign key (contact_id, care_file_id) references public.contacts (id, care_file_id) on delete set null (contact_id),
    foreign key (source_document_id, care_file_id)
        references public.documents (id, care_file_id) on delete set null (source_document_id),
    check (ends_at is null or ends_at > starts_at)
);
create index appointments_file_start on public.appointments (care_file_id, starts_at);

create table public.appointment_questions (
    id             uuid primary key default gen_random_uuid(),
    appointment_id uuid not null,
    care_file_id   uuid not null references public.care_files (id) on delete cascade,
    question       text not null check (char_length(question) between 1 and 500),
    position       smallint not null default 0,
    created_by     uuid references public.users (id) on delete set null,
    created_at     timestamptz not null default now(),
    foreign key (appointment_id, care_file_id) references public.appointments (id, care_file_id) on delete cascade
);

create table public.timeline_events (
    id                    uuid primary key default gen_random_uuid(),
    care_file_id          uuid not null references public.care_files (id) on delete cascade,
    event_type            public.timeline_event_type not null,
    occurred_on           date not null,
    title                 text not null check (char_length(title) between 1 and 160),
    description           text check (char_length(description) <= 2000),
    source_type           public.timeline_source not null,
    source_document_id    uuid,
    source_appointment_id uuid,
    created_by            uuid references public.users (id) on delete set null,
    created_at            timestamptz not null default now(),
    foreign key (source_document_id, care_file_id) references public.documents (id, care_file_id) on delete cascade,
    foreign key (source_appointment_id, care_file_id)
        references public.appointments (id, care_file_id) on delete cascade,
    -- Chaque événement est relié à sa source.
    check ((source_type = 'document') = (source_document_id is not null)),
    check ((source_type = 'appointment') = (source_appointment_id is not null))
);
create index timeline_events_file_date on public.timeline_events (care_file_id, occurred_on desc);

-- -----------------------------------------------------------------------------------------------------
-- Coordination
-- -----------------------------------------------------------------------------------------------------
create table public.tasks (
    id                   uuid primary key default gen_random_uuid(),
    care_file_id         uuid not null references public.care_files (id) on delete cascade,
    title                text not null check (char_length(title) between 1 and 160),
    details              text check (char_length(details) <= 2000),
    assignee_id          uuid references public.users (id) on delete set null,
    due_on               date,
    status               public.task_status not null default 'todo',
    care_file_program_id uuid,  -- FK ajoutée plus bas (care_file_programs)
    source_document_id   uuid,
    reminder_sent_at     timestamptz,
    completed_at         timestamptz,
    created_by           uuid references public.users (id) on delete set null,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now(),
    foreign key (source_document_id, care_file_id)
        references public.documents (id, care_file_id) on delete set null (source_document_id)
);
create index tasks_file_due on public.tasks (care_file_id, due_on);
create index tasks_assignee on public.tasks (assignee_id) where status in ('todo', 'in_progress');

create table public.journal_entries (
    id           uuid primary key default gen_random_uuid(),
    care_file_id uuid not null references public.care_files (id) on delete cascade,
    author_id    uuid references public.users (id) on delete set null,
    body         text not null check (char_length(body) between 1 and 4000),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create index journal_entries_file on public.journal_entries (care_file_id, created_at desc);

-- -----------------------------------------------------------------------------------------------------
-- Navigateur de droits
-- -----------------------------------------------------------------------------------------------------
-- Catalogue géré par l'admin. Aucun montant. Chaque fiche porte sa source et son état de vérification.
create table public.programs (
    id                  uuid primary key default gen_random_uuid(),
    slug                text not null unique check (slug ~ '^[a-z0-9-]+$'),
    name                text not null,
    organization        text not null,           -- Revenu Québec, RAMQ, ARC, SHQ, CLSC, L'Appui…
    summary             text not null,           -- description factuelle tirée de la source officielle
    criteria            jsonb not null,          -- critères structurés pour le moteur de règles (sans IA)
    required_documents  jsonb not null default '[]' check (jsonb_typeof(required_documents) = 'array'),
    how_to_apply        text,
    official_url        text not null check (official_url ~ '^https://'),
    source_label        text not null,           -- ex. « Revenu Québec — page du crédit »
    verification_status public.verification_status not null default 'to_verify',
    verified_on         date,
    verified_by         text,
    version             integer not null default 1,
    is_active           boolean not null default true,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    check ((verification_status = 'verified') = (verified_on is not null))
);

-- Explications IA mises en cache : produites à partir de la seule fiche (aucune donnée personnelle).
create table public.program_explanations (
    program_id      uuid not null references public.programs (id) on delete cascade,
    program_version integer not null,
    explanation     jsonb not null,
    model           text not null,
    created_at      timestamptz not null default now(),
    primary key (program_id, program_version)
);

create table public.benefit_assessments (
    id           uuid primary key default gen_random_uuid(),
    care_file_id uuid not null references public.care_files (id) on delete cascade,
    answers      jsonb not null,  -- âge, milieu de vie, tranche de revenu, dépenses d'aide, besoins d'adaptation
    created_by   uuid references public.users (id) on delete set null,
    created_at   timestamptz not null default now(),
    unique (id, care_file_id)
);

create table public.care_file_programs (
    id            uuid primary key default gen_random_uuid(),
    care_file_id  uuid not null references public.care_files (id) on delete cascade,
    program_id    uuid not null references public.programs (id),
    assessment_id uuid,
    match_level   text not null check (match_level in ('likely', 'possible', 'unlikely')),
    match_reasons jsonb not null default '[]',
    status        public.program_status not null default 'to_explore',
    assigned_to   uuid references public.users (id) on delete set null,
    notes         text check (char_length(notes) <= 2000),
    letter_draft  text check (char_length(letter_draft) <= 8000),
    identified_at timestamptz not null default now(),  -- mesures du pilote : repéré → demandé → décision
    requested_at  timestamptz,
    decided_at    timestamptz,
    updated_at    timestamptz not null default now(),
    unique (care_file_id, program_id),
    unique (id, care_file_id),
    foreign key (assessment_id, care_file_id)
        references public.benefit_assessments (id, care_file_id) on delete set null (assessment_id)
);

alter table public.tasks
    add constraint tasks_care_file_program_fk
    foreign key (care_file_program_id, care_file_id)
    references public.care_file_programs (id, care_file_id) on delete set null (care_file_program_id);

create table public.program_checklist_items (
    id                   uuid primary key default gen_random_uuid(),
    care_file_program_id uuid not null,
    care_file_id         uuid not null references public.care_files (id) on delete cascade,
    label                text not null check (char_length(label) between 1 and 240),
    origin               text not null default 'program' check (origin in ('program', 'custom')),
    is_done              boolean not null default false,
    document_id          uuid,
    done_by              uuid references public.users (id) on delete set null,
    done_at              timestamptz,
    position             smallint not null default 0,
    foreign key (care_file_program_id, care_file_id)
        references public.care_file_programs (id, care_file_id) on delete cascade,
    foreign key (document_id, care_file_id) references public.documents (id, care_file_id) on delete set null (document_id)
);

-- -----------------------------------------------------------------------------------------------------
-- Ressources, charge de l'aidant, demandes d'intervenante, pilote
-- -----------------------------------------------------------------------------------------------------
-- Seule source des numéros affichés (urgence, répit, lignes d'aide). Jamais de texte généré.
create table public.resources (
    id                  uuid primary key default gen_random_uuid(),
    slug                text not null unique check (slug ~ '^[a-z0-9-]+$'),
    category            public.resource_category not null,
    name                text not null,
    organization        text,
    phone               text,
    sms                 text,
    url                 text check (url is null or url ~ '^https://'),
    description         text,
    hours               text,
    region              text,  -- null = tout le Québec
    verification_status public.verification_status not null default 'to_verify',
    verified_on         date,
    verified_by         text,
    sort_order          smallint not null default 0,
    is_active           boolean not null default true,
    updated_at          timestamptz not null default now(),
    check (phone is not null or sms is not null or url is not null),
    check ((verification_status = 'verified') = (verified_on is not null))
);

-- Bilan hebdomadaire privé : visible par son auteur seulement (pas même par l'aidant principal).
create table public.caregiver_checkins (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references public.users (id) on delete cascade,
    week_start   date not null check (extract(isodow from week_start) = 1),
    fatigue      smallint not null check (fatigue between 1 and 5),
    overwhelm    smallint not null check (overwhelm between 1 and 5),
    isolation    smallint not null check (isolation between 1 and 5),
    score        smallint generated always as (fatigue + overwhelm + isolation) stored,
    comment      text check (char_length(comment) <= 1000),
    created_at   timestamptz not null default now(),
    unique (user_id, week_start)
);

create table public.support_requests (
    id                 uuid primary key default gen_random_uuid(),
    requester_id       uuid not null references public.users (id) on delete cascade,
    care_file_id       uuid references public.care_files (id) on delete set null,
    origin             public.support_origin not null,
    contact_name       text not null check (char_length(contact_name) between 1 and 80),
    preferred_contact  text not null check (preferred_contact in ('phone', 'email')),
    phone              text check (char_length(phone) <= 40),
    preferred_times    text check (char_length(preferred_times) <= 240),
    message            text check (char_length(message) <= 2000),
    status             public.support_status not null default 'new',
    assigned_worker_id uuid references public.users (id) on delete set null,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    closed_at          timestamptz,
    check (preferred_contact <> 'phone' or phone is not null)
);
create index support_requests_status on public.support_requests (status, created_at);

create table public.support_request_notes (
    id                 uuid primary key default gen_random_uuid(),
    support_request_id uuid not null references public.support_requests (id) on delete cascade,
    author_id          uuid references public.users (id) on delete set null,
    body               text not null check (char_length(body) between 1 and 2000),
    created_at         timestamptz not null default now()
);

-- Mesures du pilote (consentement pilot_evaluation requis) : heures gagnées, satisfaction.
create table public.pilot_feedback (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references public.users (id) on delete cascade,
    week_start   date not null check (extract(isodow from week_start) = 1),
    hours_saved  numeric(4, 1) check (hours_saved between 0 and 80),
    satisfaction smallint check (satisfaction between 1 and 5),
    comment      text check (char_length(comment) <= 1000),
    created_at   timestamptz not null default now(),
    unique (user_id, week_start)
);

-- -----------------------------------------------------------------------------------------------------
-- Journaux (sans contenu)
-- -----------------------------------------------------------------------------------------------------
create table public.ai_calls (
    id                   uuid primary key default gen_random_uuid(),
    user_id              uuid references public.users (id) on delete set null,
    care_file_id         uuid references public.care_files (id) on delete set null,
    purpose              public.ai_purpose not null,
    provider             text not null,  -- « anthropic » ou « bedrock »
    model                text not null,
    status               text not null check (status in ('ok', 'refusal', 'schema_error', 'guard_flagged', 'error')),
    input_tokens         integer,
    output_tokens        integer,
    latency_ms           integer,
    pseudonymized_counts jsonb not null default '{}',  -- ex. {"names": 3, "health_card": 1} ; jamais les valeurs
    created_at           timestamptz not null default now()
);

-- Journal des accès : append-only, sans clé étrangère pour survivre aux suppressions.
create table public.access_log (
    id           bigint generated always as identity primary key,
    occurred_at  timestamptz not null default now(),
    actor_id     uuid,
    care_file_id uuid,
    action       public.access_action not null,
    target_type  text,
    target_id    uuid,
    metadata     jsonb not null default '{}'  -- identifiants et compteurs seulement
);
create index access_log_file on public.access_log (care_file_id, occurred_at desc);
create index access_log_actor on public.access_log (actor_id, occurred_at desc);

-- -----------------------------------------------------------------------------------------------------
-- Fonctions d'accès (SECURITY DEFINER, schéma private)
-- -----------------------------------------------------------------------------------------------------
create function private.has_mfa() returns boolean
language sql stable set search_path = ''
as $$ select coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;

create function private.current_app_role() returns public.app_role
language sql stable security definer set search_path = ''
as $$ select coalesce((select u.app_role from public.users u where u.id = auth.uid()), 'member') $$;

-- Intervenantes et admins : rôle global + MFA (aal2) obligatoire.
create function private.is_relais_worker() returns boolean
language sql stable security definer set search_path = ''
as $$ select private.current_app_role() = 'relais_worker' and private.has_mfa() $$;

create function private.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select private.current_app_role() = 'admin' and private.has_mfa() $$;

-- Niveau d'accès de l'utilisateur courant au dossier (null si non-membre).
-- L'admin n'a aucun accès aux dossiers : il n'est jamais membre par défaut.
create function private.member_access(p_care_file_id uuid) returns public.access_level
language sql stable security definer set search_path = ''
as $$
    select m.access_level
    from public.care_file_members m
    where m.care_file_id = p_care_file_id
      and m.user_id = auth.uid()
      and (m.role <> 'relais_worker' or private.is_relais_worker())
$$;

create function private.user_consent_active(p_type public.consent_type) returns boolean
language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.consents c
        where c.user_id = auth.uid() and c.care_file_id is null
          and c.consent_type = p_type and c.revoked_at is null
    )
$$;

create function private.file_consent_active(p_care_file_id uuid, p_type public.consent_type) returns boolean
language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.consents c
        where c.care_file_id = p_care_file_id and c.consent_type = p_type and c.revoked_at is null
    )
$$;

-- Matrice de lecture :
--   profile      : tous les membres
--   coordination : owner, full, coordination, read_only
--   health       : owner, full, read_only
--   benefits     : owner, full, read_only
--   manage       : owner
create function private.can_read(p_care_file_id uuid, p_area public.data_area) returns boolean
language sql stable security definer set search_path = ''
as $$
    select coalesce(
        case private.member_access(p_care_file_id)
            when 'owner' then true
            when 'full' then p_area <> 'manage'
            when 'read_only' then p_area <> 'manage'
            when 'coordination' then p_area in ('profile', 'coordination')
        end,
        false)
$$;

-- Matrice d'écriture :
--   manage       : owner
--   profile, health, benefits : owner, full
--   coordination : owner, full, coordination
-- + consentement actif de la personne aidée (care_recipient_data) pour toute écriture hors « manage »
-- + consentement health_information de l'auteur pour la zone « health ».
create function private.can_write(p_care_file_id uuid, p_area public.data_area) returns boolean
language sql stable security definer set search_path = ''
as $$
    with a as (select private.member_access(p_care_file_id) as lvl)
    select coalesce((
        select case
            when a.lvl is null then false
            when p_area = 'manage' then a.lvl = 'owner'
            else (a.lvl in ('owner', 'full') or (a.lvl = 'coordination' and p_area = 'coordination'))
                 and private.file_consent_active(p_care_file_id, 'care_recipient_data')
                 and (p_area <> 'health' or private.user_consent_active('health_information'))
        end
        from a), false)
$$;

create function private.is_care_recipient_member(p_care_file_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.care_file_members m
        where m.care_file_id = p_care_file_id and m.user_id = auth.uid() and m.role = 'care_recipient'
    )
$$;

create function private.shares_care_file(p_user_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1
        from public.care_file_members me
        join public.care_file_members other on other.care_file_id = me.care_file_id
        where me.user_id = auth.uid() and other.user_id = p_user_id
    )
$$;

create function private.try_uuid(p_text text) returns uuid
language plpgsql immutable set search_path = ''
as $$
begin
    return p_text::uuid;
exception when invalid_text_representation then
    return null;
end;
$$;

revoke all on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- Déclencheurs
-- -----------------------------------------------------------------------------------------------------
create function private.touch_updated_at() returns trigger
language plpgsql set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

do $$
declare
    t text;
begin
    foreach t in array array[
        'care_files', 'care_recipients', 'care_needs', 'contacts', 'appointments', 'tasks',
        'journal_entries', 'programs', 'care_file_programs', 'resources', 'support_requests'
    ] loop
        execute format(
            'create trigger %1$s_touch before update on public.%1$I for each row execute function private.touch_updated_at()',
            t);
    end loop;
end;
$$;

-- Profil applicatif créé avec le compte Auth.
create function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
    insert into public.users (id) values (new.id) on conflict (id) do nothing;
    return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
    for each row execute function private.handle_new_auth_user();

-- Le créateur du dossier en devient l'aidant principal (propriétaire).
create function private.add_owner_membership() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
    insert into public.care_file_members (care_file_id, user_id, role, access_level)
    values (new.id, new.owner_id, 'primary_caregiver', 'owner');
    return new;
end;
$$;
create trigger care_files_add_owner after insert on public.care_files
    for each row execute function private.add_owner_membership();

-- Un membre « intervenante » doit avoir le rôle global relais_worker.
create function private.check_worker_membership() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
    if new.role = 'relais_worker'
       and not exists (select 1 from public.users u where u.id = new.user_id and u.app_role = 'relais_worker') then
        raise exception 'only Relais workers can join a care file as relais_worker' using errcode = '42501';
    end if;
    return new;
end;
$$;
create trigger care_file_members_check_worker before insert or update on public.care_file_members
    for each row execute function private.check_worker_membership();

-- Responsable de tâche et accompagnateur : membres du dossier seulement.
create function private.check_assignee_is_member() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
    v_user uuid;
begin
    if tg_table_name = 'tasks' then
        v_user := new.assignee_id;
    else
        v_user := new.companion_id;
    end if;
    if v_user is not null and not exists (
        select 1 from public.care_file_members m where m.care_file_id = new.care_file_id and m.user_id = v_user
    ) then
        raise exception 'assignee must be a member of the care file' using errcode = '23514';
    end if;
    return new;
end;
$$;
create trigger tasks_check_assignee before insert or update on public.tasks
    for each row execute function private.check_assignee_is_member();
create trigger appointments_check_companion before insert or update on public.appointments
    for each row execute function private.check_assignee_is_member();

-- Journal automatique des changements sensibles (membres, consentements, documents, invitations).
create function private.audit_change() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
    v_action public.access_action;
    v_file uuid;
    v_target uuid;
    v_meta jsonb := '{}';
begin
    case tg_table_name
        when 'care_file_members' then
            v_file := coalesce(new.care_file_id, old.care_file_id);
            v_target := coalesce(new.user_id, old.user_id);
            v_action := case tg_op when 'INSERT' then 'member_joined' when 'DELETE' then 'member_removed'
                                   else 'member_access_changed' end;
            if tg_op = 'UPDATE' then
                if new.access_level is not distinct from old.access_level then return null; end if;
                v_meta := jsonb_build_object('from', old.access_level, 'to', new.access_level);
            end if;
        when 'consents' then
            v_file := coalesce(new.care_file_id, old.care_file_id);
            v_target := coalesce(new.id, old.id);
            if tg_op = 'INSERT' then
                v_action := 'consent_granted';
            elsif tg_op = 'UPDATE' and old.revoked_at is null and new.revoked_at is not null then
                v_action := 'consent_revoked';
            else
                return null;
            end if;
            v_meta := jsonb_build_object('type', coalesce(new.consent_type, old.consent_type));
        when 'documents' then
            v_file := coalesce(new.care_file_id, old.care_file_id);
            v_target := coalesce(new.id, old.id);
            v_action := case tg_op when 'INSERT' then 'document_uploaded' else 'document_deleted' end;
        when 'care_file_invitations' then
            v_file := new.care_file_id;
            v_target := new.id;
            v_action := 'member_invited';
            v_meta := jsonb_build_object('role', new.role, 'access_level', new.access_level);
    end case;

    insert into public.access_log (actor_id, care_file_id, action, target_type, target_id, metadata)
    values (auth.uid(), v_file, v_action, tg_table_name, v_target, v_meta);
    return null;
end;
$$;
create trigger care_file_members_audit after insert or update or delete on public.care_file_members
    for each row execute function private.audit_change();
create trigger consents_audit after insert or update on public.consents
    for each row execute function private.audit_change();
create trigger documents_audit after insert or delete on public.documents
    for each row execute function private.audit_change();
create trigger care_file_invitations_audit after insert on public.care_file_invitations
    for each row execute function private.audit_change();

-- -----------------------------------------------------------------------------------------------------
-- Fonctions appelables (RPC)
-- -----------------------------------------------------------------------------------------------------
-- Crée une invitation et renvoie le jeton en clair (une seule fois) à la fonction qui envoie le courriel.
create function public.create_invitation(
    p_care_file_id uuid, p_email text, p_role public.member_role, p_access_level public.access_level
) returns text
language plpgsql security definer set search_path = ''
as $$
declare
    v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
    if not private.can_write(p_care_file_id, 'manage') then
        raise exception 'only the primary caregiver can invite' using errcode = '42501';
    end if;
    insert into public.care_file_invitations (care_file_id, email, role, access_level, token_hash, invited_by)
    values (p_care_file_id, lower(p_email), p_role, p_access_level,
            encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid());
    return v_token;
end;
$$;

create function public.accept_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
    v_inv public.care_file_invitations%rowtype;
begin
    if auth.uid() is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    select * into v_inv from public.care_file_invitations
    where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    for update;
    if not found or v_inv.accepted_at is not null or v_inv.revoked_at is not null or v_inv.expires_at < now() then
        raise exception 'invitation invalid or expired' using errcode = '22023';
    end if;
    if v_inv.email <> lower(coalesce(auth.jwt() ->> 'email', '')) then
        raise exception 'invitation was sent to another address' using errcode = '42501';
    end if;
    insert into public.care_file_members (care_file_id, user_id, role, access_level, invited_by)
    values (v_inv.care_file_id, auth.uid(), v_inv.role, v_inv.access_level, v_inv.invited_by);
    update public.care_file_invitations set accepted_at = now(), accepted_by = auth.uid() where id = v_inv.id;
    return v_inv.care_file_id;
end;
$$;

-- Révocation : l'utilisateur pour ses consentements ; pour le dossier, le propriétaire ou la personne aidée.
create function public.revoke_consent(p_consent_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
    update public.consents c set revoked_at = now(), revoked_by = auth.uid()
    where c.id = p_consent_id and c.revoked_at is null
      and (
          (c.care_file_id is null and c.user_id = auth.uid())
          or (c.care_file_id is not null and (
                private.member_access(c.care_file_id) = 'owner'
                or private.is_care_recipient_member(c.care_file_id)))
      );
    if not found then
        raise exception 'consent not found or not revocable by this user' using errcode = '42501';
    end if;
end;
$$;

-- Journalisation des lectures déclenchées par l'interface (ouverture du dossier, impression…).
-- Les téléchargements de documents sont journalisés côté serveur (URL signée émise par une fonction).
create function public.log_access(
    p_care_file_id uuid, p_action public.access_action, p_target_type text default null, p_target_id uuid default null
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
    if p_action not in ('file_opened', 'extraction_viewed', 'prep_sheet_printed', 'export_requested') then
        raise exception 'action % cannot be logged by clients', p_action using errcode = '22023';
    end if;
    if not private.can_read(p_care_file_id, 'profile') then
        raise exception 'no access to this care file' using errcode = '42501';
    end if;
    insert into public.access_log (actor_id, care_file_id, action, target_type, target_id)
    values (auth.uid(), p_care_file_id, p_action, p_target_type, p_target_id);
end;
$$;

-- Suppression d'un dossier. Appelée par la fonction serveur `delete-care-file` APRÈS la suppression des
-- fichiers dans Storage (l'API Storage est la seule façon fiable d'effacer les objets).
-- Efface tout par cascade, purge le journal du dossier et n'y laisse que la trace de la suppression.
create function private.purge_care_file(p_care_file_id uuid, p_actor_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_counts jsonb;
begin
    if not exists (
        select 1 from public.care_file_members m
        where m.care_file_id = p_care_file_id and m.user_id = p_actor_id and m.access_level = 'owner'
    ) then
        raise exception 'only the owner can delete a care file' using errcode = '42501';
    end if;

    select jsonb_build_object(
        'documents', (select count(*) from public.documents where care_file_id = p_care_file_id),
        'extractions', (select count(*) from public.document_extractions where care_file_id = p_care_file_id),
        'timeline_events', (select count(*) from public.timeline_events where care_file_id = p_care_file_id),
        'members', (select count(*) from public.care_file_members where care_file_id = p_care_file_id)
    ) into v_counts;

    delete from public.care_files where id = p_care_file_id;          -- cascade sur toutes les tables liées
    delete from public.access_log where care_file_id = p_care_file_id; -- y compris les entrées créées par la cascade
    insert into public.access_log (actor_id, care_file_id, action, target_type, metadata)
    values (p_actor_id, p_care_file_id, 'care_file_deleted', 'care_files', v_counts);
    return v_counts;
end;
$$;
revoke all on function private.purge_care_file(uuid, uuid) from public, authenticated;
grant execute on function private.purge_care_file(uuid, uuid) to service_role;

revoke all on function public.create_invitation(uuid, text, public.member_role, public.access_level) from public, anon;
revoke all on function public.accept_invitation(text) from public, anon;
revoke all on function public.revoke_consent(uuid) from public, anon;
revoke all on function public.log_access(uuid, public.access_action, text, uuid) from public, anon;
grant execute on function public.create_invitation(uuid, text, public.member_role, public.access_level) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.revoke_consent(uuid) to authenticated;
grant execute on function public.log_access(uuid, public.access_action, text, uuid) to authenticated;

-- À l'étape 3 : public.confirm_extraction(extraction_id, confirmed jsonb) crée atomiquement les
-- événements, médicaments, rendez-vous et tâches confirmés par l'aidant, puis journalise.

-- -----------------------------------------------------------------------------------------------------
-- Privilèges (défense en profondeur : rien pour anon, grants explicites pour authenticated)
-- -----------------------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;

grant select on public.resources to anon, authenticated;
grant select on public.programs, public.program_explanations to authenticated;
grant insert, update, delete on public.programs, public.resources to authenticated;  -- RLS : admin seulement

grant select on public.users to authenticated;
grant update (display_name) on public.users to authenticated;

grant select, insert on public.care_files to authenticated;
grant update (title) on public.care_files to authenticated;

grant select, delete on public.care_file_members to authenticated;
grant update (access_level) on public.care_file_members to authenticated;

grant select on public.care_file_invitations to authenticated;
grant update (revoked_at) on public.care_file_invitations to authenticated;

grant select, insert on public.consents to authenticated;

grant select, insert on public.documents to authenticated;
grant select on public.document_extractions to authenticated;

grant select, insert, update, delete on
    public.care_recipients, public.care_needs, public.contacts, public.medication_mentions,
    public.timeline_events, public.tasks, public.appointments, public.appointment_questions,
    public.journal_entries, public.benefit_assessments, public.care_file_programs,
    public.program_checklist_items, public.caregiver_checkins
    to authenticated;

grant select, insert on public.support_requests to authenticated;
grant update (status, assigned_worker_id, closed_at) on public.support_requests to authenticated;
grant select, insert on public.support_request_notes to authenticated;
grant select, insert, update on public.pilot_feedback to authenticated;
grant select on public.access_log, public.ai_calls to authenticated;

-- -----------------------------------------------------------------------------------------------------
-- Politiques RLS
-- -----------------------------------------------------------------------------------------------------
do $$
declare
    t text;
begin
    for t in select tablename from pg_tables where schemaname = 'public' loop
        execute format('alter table public.%I enable row level security', t);
    end loop;
end;
$$;

-- Tables de dossier au CRUD uniforme : (table, zone).
do $$
declare
    r record;
begin
    for r in select * from (values
        ('care_recipients', 'profile'),
        ('care_needs', 'health'),
        ('contacts', 'coordination'),
        ('medication_mentions', 'health'),
        ('timeline_events', 'health'),
        ('tasks', 'coordination'),
        ('appointments', 'coordination'),
        ('appointment_questions', 'coordination'),
        ('benefit_assessments', 'benefits'),
        ('care_file_programs', 'benefits'),
        ('program_checklist_items', 'benefits')
    ) as v(tbl, area) loop
        execute format(
            'create policy %1$s_select on public.%1$I for select to authenticated using (private.can_read(care_file_id, %2$L))',
            r.tbl, r.area);
        execute format(
            'create policy %1$s_insert on public.%1$I for insert to authenticated with check (private.can_write(care_file_id, %2$L))',
            r.tbl, r.area);
        execute format(
            'create policy %1$s_update on public.%1$I for update to authenticated using (private.can_write(care_file_id, %2$L)) with check (private.can_write(care_file_id, %2$L))',
            r.tbl, r.area);
        execute format(
            'create policy %1$s_delete on public.%1$I for delete to authenticated using (private.can_write(care_file_id, %2$L))',
            r.tbl, r.area);
    end loop;
end;
$$;

-- users : soi-même et les personnes avec qui on partage un dossier.
create policy users_select on public.users for select to authenticated
    using (id = (select auth.uid()) or private.shares_care_file(id));
create policy users_update on public.users for update to authenticated
    using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- care_files : création après acceptation de la politique de confidentialité ; suppression par fonction serveur.
create policy care_files_select on public.care_files for select to authenticated
    using (private.can_read(id, 'profile'));
create policy care_files_insert on public.care_files for insert to authenticated
    with check (owner_id = (select auth.uid()) and private.user_consent_active('privacy_policy'));
create policy care_files_update on public.care_files for update to authenticated
    using (private.can_write(id, 'manage')) with check (private.can_write(id, 'manage'));

-- care_file_members : ajout par invitation (RPC) ; le propriétaire gère, un membre peut se retirer.
create policy members_select on public.care_file_members for select to authenticated
    using (private.can_read(care_file_id, 'profile'));
create policy members_update on public.care_file_members for update to authenticated
    using (private.can_write(care_file_id, 'manage') and access_level <> 'owner')
    with check (access_level <> 'owner');
create policy members_delete on public.care_file_members for delete to authenticated
    using (
        (private.can_write(care_file_id, 'manage') and user_id <> (select auth.uid()))
        or (user_id = (select auth.uid()) and access_level <> 'owner')
    );

create policy invitations_select on public.care_file_invitations for select to authenticated
    using (private.can_write(care_file_id, 'manage'));
create policy invitations_update on public.care_file_invitations for update to authenticated
    using (private.can_write(care_file_id, 'manage')) with check (private.can_write(care_file_id, 'manage'));

-- consents : ajout seulement (la révocation passe par revoke_consent).
create policy consents_select on public.consents for select to authenticated
    using (
        (care_file_id is null and user_id = (select auth.uid()))
        or (care_file_id is not null and private.can_read(care_file_id, 'profile'))
    );
create policy consents_insert on public.consents for insert to authenticated
    with check (
        user_id = (select auth.uid())
        and (
            (care_file_id is null and granted_by = 'self')
            or (care_file_id is not null and granted_by <> 'care_recipient_in_app'
                and private.can_write(care_file_id, 'manage'))
            or (care_file_id is not null and granted_by = 'care_recipient_in_app'
                and private.is_care_recipient_member(care_file_id))
        )
    );

-- documents : lecture des métadonnées ; création d'une entrée « pending_upload » par l'auteur.
-- Statuts, champs confirmés et suppression : fonctions serveur seulement.
create policy documents_select on public.documents for select to authenticated
    using (private.can_read(care_file_id, 'health'));
create policy documents_insert on public.documents for insert to authenticated
    with check (
        private.can_write(care_file_id, 'health')
        and uploaded_by = (select auth.uid())
        and status = 'pending_upload'
    );

create policy extractions_select on public.document_extractions for select to authenticated
    using (private.can_read(care_file_id, 'health'));

-- journal de bord : lecture par la coordination ; modification par l'auteur seulement.
create policy journal_select on public.journal_entries for select to authenticated
    using (private.can_read(care_file_id, 'coordination'));
create policy journal_insert on public.journal_entries for insert to authenticated
    with check (private.can_write(care_file_id, 'coordination') and author_id = (select auth.uid()));
create policy journal_update on public.journal_entries for update to authenticated
    using (author_id = (select auth.uid()) and private.can_write(care_file_id, 'coordination'))
    with check (author_id = (select auth.uid()));
create policy journal_delete on public.journal_entries for delete to authenticated
    using (author_id = (select auth.uid()));

-- Catalogue : lecture des fiches actives ; écriture par l'admin (MFA).
create policy programs_select on public.programs for select to authenticated
    using (is_active or private.is_admin());
create policy programs_admin_insert on public.programs for insert to authenticated with check (private.is_admin());
create policy programs_admin_update on public.programs for update to authenticated
    using (private.is_admin()) with check (private.is_admin());
create policy programs_admin_delete on public.programs for delete to authenticated using (private.is_admin());
create policy program_explanations_select on public.program_explanations for select to authenticated using (true);

create policy resources_select_anon on public.resources for select to anon using (is_active);
create policy resources_select on public.resources for select to authenticated
    using (is_active or private.is_admin());
create policy resources_admin_insert on public.resources for insert to authenticated with check (private.is_admin());
create policy resources_admin_update on public.resources for update to authenticated
    using (private.is_admin()) with check (private.is_admin());
create policy resources_admin_delete on public.resources for delete to authenticated using (private.is_admin());

-- Bilan de l'aidant : strictement personnel (pas même visible par l'aidant principal ni les intervenantes).
create policy checkins_own on public.caregiver_checkins for all to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Demandes d'intervenante : le demandeur voit les siennes ; les intervenantes (MFA) voient le tableau.
create policy support_select on public.support_requests for select to authenticated
    using (requester_id = (select auth.uid()) or private.is_relais_worker());
create policy support_insert on public.support_requests for insert to authenticated
    with check (requester_id = (select auth.uid()) and status = 'new' and assigned_worker_id is null);
create policy support_update on public.support_requests for update to authenticated
    using (private.is_relais_worker()) with check (private.is_relais_worker());
create policy support_notes_select on public.support_request_notes for select to authenticated
    using (private.is_relais_worker());
create policy support_notes_insert on public.support_request_notes for insert to authenticated
    with check (private.is_relais_worker() and author_id = (select auth.uid()));

create policy pilot_feedback_own on public.pilot_feedback for all to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()) and private.user_consent_active('pilot_evaluation'));
create policy pilot_feedback_admin on public.pilot_feedback for select to authenticated
    using (private.is_admin());

-- Journaux : le propriétaire voit le journal de son dossier ; chacun voit ses propres actions.
create policy access_log_select on public.access_log for select to authenticated
    using (actor_id = (select auth.uid()) or private.can_read(care_file_id, 'manage'));
create policy ai_calls_admin on public.ai_calls for select to authenticated using (private.is_admin());

-- -----------------------------------------------------------------------------------------------------
-- Storage : bucket privé `documents`, chemin « {care_file_id}/{document_id} »
-- Téléversement direct autorisé ; AUCUNE lecture directe : les téléchargements passent par une fonction
-- serveur qui vérifie l'accès, émet une URL signée de 60 s et journalise « document_viewed ».
-- -----------------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('documents', 'documents', false);

create policy documents_upload on storage.objects for insert to authenticated
    with check (
        bucket_id = 'documents'
        and private.can_write(private.try_uuid((storage.foldername(name))[1]), 'health')
        and exists (
            select 1 from public.documents d
            where d.storage_path = name and d.uploaded_by = (select auth.uid()) and d.status = 'pending_upload'
        )
    );
