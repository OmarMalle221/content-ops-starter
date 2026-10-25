-- =====================================================================================================
-- Relais — étape 1 : socle, comptes et consentements.
--
-- Tables : users, consent_texts, consents, resources, access_log, ai_calls.
-- Les tables de dossier (care_files…) arrivent à l'étape 2 ; les clés étrangères vers care_files
-- (consents.care_file_id, ai_calls.care_file_id, access_log reste sans clé) y seront ajoutées.
--
-- Principes : RLS partout, aucun privilège pour anon sauf la lecture des ressources et des versions
-- de consentement, règles d'accès dans le schéma `private` (non exposé par l'API), aucune donnée de
-- santé ni texte libre dans access_log et ai_calls.
-- =====================================================================================================

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------------------------------
create type public.app_role as enum ('member', 'relais_worker', 'admin');

create type public.consent_type as enum (
    'privacy_policy',          -- politique de confidentialité (préalable à tout usage)
    'health_information',      -- collecte et usage de renseignements de santé (distinct)
    'email_reminders',         -- rappels par courriel
    'pilot_evaluation',        -- usage des réponses pour évaluer le pilote
    'care_recipient_data',     -- dossier : consentement de la personne aidée ou de son représentant (étape 2)
    'ai_document_processing'   -- dossier : traitement des documents par l'IA (étape 3)
);
create type public.consent_grantor as enum (
    'self', 'care_recipient_in_app', 'care_recipient_signed_form', 'legal_representative'
);
create type public.legal_basis as enum (
    'person_consents', 'homologated_protection_mandate', 'tutorship', 'power_of_attorney', 'other'
);
create type public.verification_status as enum ('to_verify', 'verified');
create type public.resource_category as enum (
    'emergency', 'crisis_line', 'psychosocial_line', 'health_line', 'respite', 'caregiver_support',
    'elder_abuse', 'info'
);
create type public.ai_purpose as enum ('document_extraction', 'program_explanation', 'letter_draft');
create type public.access_action as enum (
    'file_opened', 'document_uploaded', 'document_viewed', 'document_deleted', 'extraction_viewed',
    'extraction_confirmed', 'prep_sheet_printed', 'member_invited', 'member_joined', 'member_removed',
    'member_access_changed', 'consent_granted', 'consent_revoked', 'export_requested', 'care_file_deleted',
    'account_deleted'
);

-- -----------------------------------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------------------------------
create table public.users (
    id           uuid primary key references auth.users (id) on delete cascade,
    display_name text check (char_length(btrim(display_name)) between 1 and 80),
    app_role     public.app_role not null default 'member',  -- modifiable par service_role seulement
    created_at   timestamptz not null default now()
);

-- Versions publiées des textes de consentement. Le texte lui-même est versionné dans le dépôt
-- (src/content/consent-texts.fr.json) ; la base garde son empreinte SHA-256 comme preuve.
create table public.consent_texts (
    consent_type public.consent_type not null,
    version      text not null check (version ~ '^\d{4}-\d{2}-\d{2}(\.\d+)?$'),
    sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
    published_on date not null,
    primary key (consent_type, version)
);

create table public.consents (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references public.users (id) on delete cascade,  -- qui enregistre
    care_file_id        uuid,  -- null = portée utilisateur ; clé étrangère ajoutée à l'étape 2
    consent_type        public.consent_type not null,
    text_version        text not null,
    granted_by          public.consent_grantor not null default 'self',
    legal_basis         public.legal_basis,
    representative_name text check (char_length(representative_name) <= 120),
    granted_at          timestamptz not null default now(),
    revoked_at          timestamptz,
    revoked_by          uuid references public.users (id) on delete set null,
    foreign key (consent_type, text_version) references public.consent_texts (consent_type, version),
    check ((consent_type in ('care_recipient_data', 'ai_document_processing')) = (care_file_id is not null)),
    check ((care_file_id is null) = (granted_by = 'self')),
    check (consent_type <> 'care_recipient_data' or legal_basis is not null),
    check (granted_by <> 'legal_representative' or representative_name is not null),
    check (revoked_at is null or revoked_at >= granted_at)
);
create index consents_user on public.consents (user_id, consent_type);
create index consents_revoked_by on public.consents (revoked_by);
create index consents_text on public.consents (consent_type, text_version);
create unique index consents_active_user on public.consents (user_id, consent_type)
    where care_file_id is null and revoked_at is null;
create unique index consents_active_file on public.consents (care_file_id, consent_type)
    where care_file_id is not null and revoked_at is null;

-- Seule source des numéros affichés (urgence, crise, répit, lignes d'aide). Jamais de texte généré.
create table public.resources (
    id                  uuid primary key default gen_random_uuid(),
    slug                text not null unique check (slug ~ '^[a-z0-9-]+$'),
    category            public.resource_category not null,
    name                text not null,
    organization        text,
    phone               text check (phone ~ '^[0-9 +-]+$'),
    sms                 text check (sms ~ '^[0-9 +-]+$'),
    url                 text check (url ~ '^https://'),
    description         text,
    hours               text,
    region              text,  -- null = tout le Québec
    source_url          text check (source_url ~ '^https://'),
    verification_status public.verification_status not null default 'to_verify',
    verified_on         date,
    verified_by         text,
    sort_order          smallint not null default 0,
    is_active           boolean not null default true,
    updated_at          timestamptz not null default now(),
    check (phone is not null or sms is not null or url is not null),
    check ((verification_status = 'verified') = (verified_on is not null and verified_by is not null))
);

-- Appels à l'IA : métadonnées seulement, jamais de contenu.
create table public.ai_calls (
    id                   uuid primary key default gen_random_uuid(),
    user_id              uuid references public.users (id) on delete set null,
    care_file_id         uuid,  -- clé étrangère ajoutée à l'étape 2 (on delete set null)
    purpose              public.ai_purpose not null,
    provider             text not null check (provider in ('anthropic', 'bedrock')),
    model                text not null,
    status               text not null check (status in ('ok', 'refusal', 'schema_error', 'guard_flagged', 'error')),
    input_tokens         integer check (input_tokens >= 0),
    output_tokens        integer check (output_tokens >= 0),
    latency_ms           integer check (latency_ms >= 0),
    pseudonymized_counts jsonb not null default '{}' check (jsonb_typeof(pseudonymized_counts) = 'object'),
    created_at           timestamptz not null default now()
);
create index ai_calls_user on public.ai_calls (user_id);
create index ai_calls_created on public.ai_calls (created_at desc);

-- Journal des accès : append-only, sans clé étrangère pour survivre aux suppressions.
create table public.access_log (
    id           bigint generated always as identity primary key,
    occurred_at  timestamptz not null default now(),
    actor_id     uuid,
    care_file_id uuid,
    action       public.access_action not null,
    target_type  text check (target_type ~ '^[a-z_]+$'),
    target_id    uuid,
    metadata     jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object')
);
create index access_log_file on public.access_log (care_file_id, occurred_at desc);
create index access_log_actor on public.access_log (actor_id, occurred_at desc);

-- -----------------------------------------------------------------------------------------------------
-- Fonctions d'accès (schéma private, SECURITY DEFINER)
-- -----------------------------------------------------------------------------------------------------
create function private.has_mfa() returns boolean
language sql stable set search_path = ''
as $$ select coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;

create function private.current_app_role() returns public.app_role
language sql stable security definer set search_path = ''
as $$ select coalesce((select u.app_role from public.users u where u.id = auth.uid()), 'member') $$;

-- Intervenantes et admins : rôle global + MFA (aal2) obligatoire, sinon aucun privilège particulier.
create function private.is_relais_worker() returns boolean
language sql stable security definer set search_path = ''
as $$ select private.current_app_role() = 'relais_worker' and private.has_mfa() $$;

create function private.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select private.current_app_role() = 'admin' and private.has_mfa() $$;

create function private.user_consent_active(p_type public.consent_type) returns boolean
language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.consents c
        where c.user_id = auth.uid() and c.care_file_id is null
          and c.consent_type = p_type and c.revoked_at is null
    )
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
create trigger resources_touch before update on public.resources
    for each row execute function private.touch_updated_at();

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

-- Journal automatique des consentements accordés et retirés.
create function private.audit_consent() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
    if tg_op = 'INSERT' then
        insert into public.access_log (actor_id, care_file_id, action, target_type, target_id, metadata)
        values (auth.uid(), new.care_file_id, 'consent_granted', 'consents', new.id,
                jsonb_build_object('type', new.consent_type, 'version', new.text_version));
    elsif old.revoked_at is null and new.revoked_at is not null then
        insert into public.access_log (actor_id, care_file_id, action, target_type, target_id, metadata)
        values (auth.uid(), new.care_file_id, 'consent_revoked', 'consents', new.id,
                jsonb_build_object('type', new.consent_type, 'version', new.text_version));
    end if;
    return null;
end;
$$;
create trigger consents_audit after insert or update on public.consents
    for each row execute function private.audit_consent();

-- -----------------------------------------------------------------------------------------------------
-- Fonctions appelables (RPC)
-- -----------------------------------------------------------------------------------------------------
-- Accord d'un consentement de portée utilisateur, pour la version affichée du texte.
-- Idempotent pour une même version ; une nouvelle version clôt l'accord précédent (renouvellement).
create function public.grant_consent(p_type public.consent_type, p_version text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
    v_id uuid;
begin
    if auth.uid() is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    if p_type in ('care_recipient_data', 'ai_document_processing') then
        raise exception 'care-file consents are recorded with the care file' using errcode = '22023';
    end if;
    select c.id into v_id from public.consents c
    where c.user_id = auth.uid() and c.care_file_id is null and c.consent_type = p_type
      and c.revoked_at is null and c.text_version = p_version;
    if found then
        return v_id;
    end if;
    update public.consents set revoked_at = now(), revoked_by = auth.uid()
    where user_id = auth.uid() and care_file_id is null and consent_type = p_type and revoked_at is null;
    insert into public.consents (user_id, consent_type, text_version)
    values (auth.uid(), p_type, p_version)
    returning id into v_id;
    return v_id;
end;
$$;

-- Retrait d'un consentement de portée utilisateur. La politique de confidentialité ne se retire pas :
-- il faut supprimer le compte. (La portée « dossier » s'ajoute à l'étape 2.)
create function public.revoke_consent(p_consent_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_type public.consent_type;
begin
    select c.consent_type into v_type
    from public.consents c
    where c.id = p_consent_id and c.revoked_at is null
      and c.care_file_id is null and c.user_id = auth.uid();
    if not found then
        raise exception 'consent not found or not revocable by this user' using errcode = '42501';
    end if;
    if v_type = 'privacy_policy' then
        raise exception 'privacy_policy cannot be revoked; delete the account instead' using errcode = '22023';
    end if;
    update public.consents set revoked_at = now(), revoked_by = auth.uid() where id = p_consent_id;
end;
$$;

-- Droit d'accès et portabilité : toutes les données propres à l'utilisateur, en JSON structuré.
create function public.export_my_data() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_export jsonb;
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    select jsonb_build_object(
        'format', 'relais-export/1',
        'exported_at', now(),
        'account', (
            select jsonb_build_object(
                'id', u.id, 'email', a.email, 'display_name', u.display_name,
                'app_role', u.app_role, 'created_at', u.created_at)
            from public.users u join auth.users a on a.id = u.id
            where u.id = v_uid),
        'consents', coalesce((
            select jsonb_agg(jsonb_build_object(
                'consent_type', c.consent_type, 'text_version', c.text_version, 'care_file_id', c.care_file_id,
                'granted_by', c.granted_by, 'granted_at', c.granted_at, 'revoked_at', c.revoked_at)
                order by c.granted_at)
            from public.consents c where c.user_id = v_uid), '[]'::jsonb),
        'access_log', coalesce((
            select jsonb_agg(jsonb_build_object(
                'occurred_at', l.occurred_at, 'action', l.action, 'care_file_id', l.care_file_id,
                'target_type', l.target_type)
                order by l.occurred_at)
            from public.access_log l where l.actor_id = v_uid), '[]'::jsonb)
    ) into v_export;

    insert into public.access_log (actor_id, action, target_type) values (v_uid, 'export_requested', 'account');
    return v_export;
end;
$$;

-- Droit à la suppression : efface le compte Auth et, par cascade, le profil et les consentements.
-- Le journal garde l'identifiant (pseudonyme) de l'acteur et la trace de la suppression.
-- (L'étape 2 ajoute le refus tant que l'utilisateur est propriétaire d'un dossier.)
create function public.delete_my_account() returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    insert into public.access_log (actor_id, action, target_type) values (v_uid, 'account_deleted', 'account');
    delete from auth.users where id = v_uid;
end;
$$;

revoke all on function public.grant_consent(public.consent_type, text) from public, anon;
revoke all on function public.revoke_consent(uuid) from public, anon;
revoke all on function public.export_my_data() from public, anon;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.grant_consent(public.consent_type, text) to authenticated;
grant execute on function public.revoke_consent(uuid) to authenticated;
grant execute on function public.export_my_data() to authenticated;
grant execute on function public.delete_my_account() to authenticated;

-- -----------------------------------------------------------------------------------------------------
-- Privilèges : rien pour anon sauf les lectures publiques ; grants explicites pour authenticated.
-- -----------------------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;

grant select on public.resources, public.consent_texts to anon, authenticated;
grant insert, update, delete on public.resources to authenticated;  -- RLS : admin (MFA) seulement

grant select on public.users to authenticated;
grant update (display_name) on public.users to authenticated;

grant select on public.consents to authenticated;  -- écritures par grant_consent / revoke_consent
grant select on public.access_log, public.ai_calls to authenticated;

-- -----------------------------------------------------------------------------------------------------
-- Politiques RLS
-- -----------------------------------------------------------------------------------------------------
alter table public.users enable row level security;
alter table public.consent_texts enable row level security;
alter table public.consents enable row level security;
alter table public.resources enable row level security;
alter table public.ai_calls enable row level security;
alter table public.access_log enable row level security;

-- users : soi-même (l'étape 2 ajoute les personnes avec qui on partage un dossier).
create policy users_select on public.users for select to authenticated
    using (id = (select auth.uid()));
create policy users_update on public.users for update to authenticated
    using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy consent_texts_select on public.consent_texts for select to anon, authenticated using (true);

-- consents : lecture de ses propres consentements (portée utilisateur à l'étape 1).
create policy consents_select on public.consents for select to authenticated
    using (care_file_id is null and user_id = (select auth.uid()));

-- resources : lecture des fiches actives, même sans session (écran d'urgence) ; écriture par l'admin.
create policy resources_select_anon on public.resources for select to anon using (is_active);
create policy resources_select on public.resources for select to authenticated
    using (is_active or private.is_admin());
create policy resources_admin_insert on public.resources for insert to authenticated
    with check (private.is_admin());
create policy resources_admin_update on public.resources for update to authenticated
    using (private.is_admin()) with check (private.is_admin());
create policy resources_admin_delete on public.resources for delete to authenticated
    using (private.is_admin());

-- Journaux : chacun voit ses propres actions ; l'étape 2 ajoute le journal du dossier pour le propriétaire.
create policy access_log_select on public.access_log for select to authenticated
    using (actor_id = (select auth.uid()));
create policy ai_calls_admin on public.ai_calls for select to authenticated
    using (private.is_admin());
