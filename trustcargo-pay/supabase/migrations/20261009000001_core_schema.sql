-- =====================================================================================================
-- TrustCargo Pay — core schema
--
-- Source of truth: src/domain/model.ts, src/domain/money.ts, src/domain/transaction/state-machine.ts.
-- Conventions:
--   * snake_case tables/columns, uuid primary keys. The server supplies time-ordered UUIDv7 ids
--     (src/server/adapters/uuid-v7.ts); gen_random_uuid() is only the default for SQL-side inserts.
--   * Money is ALWAYS `amount_minor bigint` (integer minor units) + `currency trustcargo.currency_code`.
--     No numeric/float column ever holds an amount.
--   * Status vocabularies that are central to authorization are Postgres enums; the others are text
--     columns with CHECK constraints (cheaper to evolve).
--   * Polymorphic ids of the TS model (subjectId / ownerId) are normalized into two nullable FKs
--     (`*_user_id` / `*_organization_id`) with a CHECK that exactly the right one is set.
--   * TrustCargo never holds funds: the payment tables mirror instructions sent to, and events
--     reported by, the licensed payment partner. The MVP runs in SIMULATION mode only.
--   * Nothing is created in `public`: the target Supabase project is shared with another application.
-- =====================================================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Dedicated schemas so the project can share a Supabase database without touching `public`:
--   trustcargo         business tables (read through RLS by `authenticated`, written by the server)
--   trustcargo_private SECURITY DEFINER helpers and trigger functions (never exposed through PostgREST)
create schema if not exists trustcargo;
create schema if not exists trustcargo_private;
revoke all on schema trustcargo from public;
revoke all on schema trustcargo_private from public;

-- -----------------------------------------------------------------------------------------------------
-- Domains & enums
-- -----------------------------------------------------------------------------------------------------

create domain trustcargo.currency_code as char(3)
    check (value in ('CAD', 'USD', 'EUR', 'XOF'));

create domain trustcargo.country_code as char(2)
    check (value ~ '^[A-Z]{2}$');

create domain trustcargo.sha256_hex as text
    check (value ~ '^[0-9a-f]{64}$');

create type trustcargo.platform_role as enum (
    'compliance_analyst',
    'document_reviewer',
    'dispute_manager',
    'finance_operator',
    'platform_admin',
    'auditor'
);

create type trustcargo.verification_status as enum ('NOT_STARTED', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED');

create type trustcargo.transaction_status as enum (
    'DRAFT',
    'AWAITING_PARTIES',
    'IDENTITY_VERIFICATION',
    'AWAITING_AGREEMENT',
    'AWAITING_FUNDING',
    'FUNDING_PENDING',
    'FUNDS_CONFIRMED',
    'IN_PROGRESS',
    'MILESTONE_REVIEW',
    'DISPUTED',
    'COMPLETED',
    'CANCELLED',
    'REFUND_PENDING',
    'REFUNDED'
);

create type trustcargo.party_role as enum ('SELLER', 'BUYER', 'INSPECTOR', 'FREIGHT_FORWARDER');

create type trustcargo.document_type as enum (
    'INVOICE',
    'TITLE',
    'CONTRACT',
    'INSPECTION_REPORT',
    'PHOTO',
    'BILL_OF_LADING',
    'EXPORT_DECLARATION',
    'DELIVERY_PROOF',
    'IDENTITY',
    'OTHER'
);

-- -----------------------------------------------------------------------------------------------------
-- Generic helpers
-- -----------------------------------------------------------------------------------------------------

-- Lenient uuid parser (null when the text is not a uuid). Used by generated columns and storage policies.
create or replace function trustcargo_private.try_uuid(p_value text)
returns uuid
language sql
immutable
set search_path = ''
as $$
    select case
        when p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_value::uuid
    end;
$$;

-- updated_at owned by the database (the TypeScript entity has no updatedAt): always now().
create or replace function trustcargo_private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

-- updated_at owned by the application (the TypeScript entity has updatedAt, set from the server clock):
-- the writer's value is kept; now() is only used when the writer left updated_at unchanged. The server's
-- unit of work sets `trustcargo.app_managed_updated_at = on` (transaction-local) because it may
-- legitimately write the same instant twice (two writes in one millisecond, demo clock frozen).
create or replace function trustcargo_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.updated_at is not distinct from old.updated_at
       and coalesce(current_setting('trustcargo.app_managed_updated_at', true), '') <> 'on' then
        new.updated_at := now();
    end if;
    return new;
end;
$$;

-- =====================================================================================================
-- Identity & organizations
-- =====================================================================================================

-- No foreign key to auth.users: demo personas (is_demo) have no Supabase Auth account and must not get one
-- (the shared project's other application provisions its own profiles from auth.users). A real user's id
-- must be an auth.users id (trigger below); RLS keys on auth.uid() = users.id.
create table trustcargo.users (
    id          uuid primary key,
    email       text not null check (position('@' in email) > 1),
    full_name   text not null check (length(btrim(full_name)) between 1 and 200),
    phone       text check (phone is null or phone ~ '^\+?[0-9 ().-]{6,20}$'),
    country     trustcargo.country_code not null,
    city        text,
    locale      text not null default 'fr' check (locale in ('fr', 'en')),
    kyc_status  trustcargo.verification_status not null default 'NOT_STARTED',
    status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED')),
    is_demo     boolean not null default false,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
comment on table trustcargo.users is
    'Application profile. Real users: id = auth.users.id, MFA delegated to Supabase Auth. Demo personas: no auth account, fictitious TOTP secret in trustcargo_private.demo_mfa_secrets.';
create unique index users_email_lower_key on trustcargo.users (lower(email));
create index users_kyc_status_idx on trustcargo.users (kyc_status);
create index users_created_at_idx on trustcargo.users (created_at);

create table trustcargo.user_platform_roles (
    user_id    uuid not null references trustcargo.users (id) on delete cascade,
    role       trustcargo.platform_role not null,
    -- Position in User.platformRoles, so the list reads back in the order it was written.
    ordinal    smallint not null default 0 check (ordinal >= 0),
    granted_by uuid references trustcargo.users (id),
    granted_at timestamptz not null default now(),
    primary key (user_id, role)
);
create index user_platform_roles_role_idx on trustcargo.user_platform_roles (role);
create index user_platform_roles_granted_by_idx on trustcargo.user_platform_roles (granted_by);

-- A non-demo profile must belong to a Supabase Auth account; demo personas never get one.
create or replace function trustcargo_private.users_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not new.is_demo and not exists (select 1 from auth.users a where a.id = new.id) then
        raise exception 'trustcargo.users: a non-demo user must have an auth.users account (id %)', new.id
            using errcode = '23503';
    end if;
    if tg_op = 'UPDATE' and old.is_demo and not new.is_demo
       and exists (select 1 from trustcargo_private.demo_mfa_secrets s where s.user_id = new.id) then
        raise exception 'trustcargo.users: remove the demo TOTP secret before converting a demo persona'
            using errcode = '42501';
    end if;
    return new;
end;
$$;

create trigger users_guard
    before insert or update of id, is_demo on trustcargo.users
    for each row execute function trustcargo_private.users_guard();

-- Fictitious TOTP secrets of demo personas only (real users' MFA is delegated to Supabase Auth).
-- service_role only: no privilege for anon/authenticated, RLS without policies.
create table trustcargo_private.demo_mfa_secrets (
    user_id     uuid primary key references trustcargo.users (id) on delete cascade,
    totp_secret text not null check (totp_secret ~ '^[A-Z2-7]{16,64}$')
);

create or replace function trustcargo_private.demo_mfa_secrets_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not exists (select 1 from trustcargo.users u where u.id = new.user_id and u.is_demo) then
        raise exception 'TOTP secrets are only stored for demo personas (user %)', new.user_id using errcode = '42501';
    end if;
    return new;
end;
$$;

create trigger demo_mfa_secrets_guard
    before insert or update on trustcargo_private.demo_mfa_secrets
    for each row execute function trustcargo_private.demo_mfa_secrets_guard();

create table trustcargo.organizations (
    id                  uuid primary key default gen_random_uuid(),
    legal_name          text not null check (length(btrim(legal_name)) between 1 and 300),
    trade_name          text,
    registration_number text not null check (length(btrim(registration_number)) between 1 and 100),
    country             trustcargo.country_code not null,
    city                text,
    type                text not null check (type in ('DEALER', 'EXPORTER', 'FREIGHT_FORWARDER', 'INSPECTION_COMPANY', 'BUYER_BUSINESS')),
    kyb_status          trustcargo.verification_status not null default 'NOT_STARTED',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    unique (country, registration_number)
);
create index organizations_kyb_status_idx on trustcargo.organizations (kyb_status);
create index organizations_created_at_idx on trustcargo.organizations (created_at);

create table trustcargo.organization_members (
    id              uuid primary key default gen_random_uuid(),
    organization_id uuid not null references trustcargo.organizations (id) on delete cascade,
    user_id         uuid not null references trustcargo.users (id) on delete cascade,
    role            text not null default 'MEMBER' check (role in ('OWNER', 'ADMIN', 'MEMBER')),
    created_at      timestamptz not null default now(),
    unique (organization_id, user_id)
);
create index organization_members_user_id_idx on trustcargo.organization_members (user_id);

create table trustcargo.identity_verifications (
    id                      uuid primary key default gen_random_uuid(),
    subject_type            text not null check (subject_type in ('USER', 'ORGANIZATION')),
    subject_user_id         uuid references trustcargo.users (id),
    subject_organization_id uuid references trustcargo.organizations (id),
    provider                text not null,
    provider_reference      text not null,
    status                  trustcargo.verification_status not null default 'PENDING',
    level                   text not null default 'BASIC' check (level in ('BASIC', 'ENHANCED')),
    verified_name           text,
    document_type           text check (document_type in ('PASSPORT', 'NATIONAL_ID', 'DRIVER_LICENSE', 'BUSINESS_REGISTRY')),
    document_country        trustcargo.country_code,
    document_expires_at     date,
    checks                  jsonb not null default '[]'::jsonb check (jsonb_typeof(checks) = 'array'),
    reviewed_by             uuid references trustcargo.users (id),
    review_note             text,
    simulated               boolean not null default true,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    completed_at            timestamptz,
    unique (provider, provider_reference),
    check (
        (subject_type = 'USER' and subject_user_id is not null and subject_organization_id is null)
        or (subject_type = 'ORGANIZATION' and subject_organization_id is not null and subject_user_id is null)
    )
);
create index identity_verifications_subject_user_id_idx on trustcargo.identity_verifications (subject_user_id);
create index identity_verifications_subject_org_id_idx on trustcargo.identity_verifications (subject_organization_id);
create index identity_verifications_reviewed_by_idx on trustcargo.identity_verifications (reviewed_by);
create index identity_verifications_status_idx on trustcargo.identity_verifications (status);
create index identity_verifications_created_at_idx on trustcargo.identity_verifications (created_at);

create table trustcargo.beneficial_owners (
    id                  uuid primary key default gen_random_uuid(),
    organization_id     uuid not null references trustcargo.organizations (id) on delete cascade,
    full_name           text not null,
    ownership_bps       integer not null check (ownership_bps between 0 and 10000),
    country             trustcargo.country_code not null,
    verification_status trustcargo.verification_status not null default 'NOT_STARTED',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
create index beneficial_owners_organization_id_idx on trustcargo.beneficial_owners (organization_id);

create table trustcargo.payment_accounts (
    id                    uuid primary key default gen_random_uuid(),
    owner_type            text not null check (owner_type in ('USER', 'ORGANIZATION')),
    owner_user_id         uuid references trustcargo.users (id),
    owner_organization_id uuid references trustcargo.organizations (id),
    holder_name           text not null,
    currency              trustcargo.currency_code not null,
    country               trustcargo.country_code not null,
    bank_name             text not null,
    -- Display-only masked identifier, e.g. '•••• 4821'. At most 4 digits may appear: a full account
    -- number / IBAN can never be stored here (TrustCargo never stores raw account numbers).
    masked_identifier     text not null check (
        length(masked_identifier) <= 40
        and length(regexp_replace(masked_identifier, '[^0-9]', '', 'g')) <= 4
    ),
    -- Opaque token from the payment partner's vault.
    provider_token        text not null check (length(provider_token) between 8 and 512),
    status                text not null default 'PENDING_VERIFICATION' check (status in ('PENDING_VERIFICATION', 'VERIFIED', 'DISABLED')),
    replaces_account_id   uuid references trustcargo.payment_accounts (id),
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    verified_at           timestamptz,
    disabled_at           timestamptz,
    unique (provider_token),
    check (
        (owner_type = 'USER' and owner_user_id is not null and owner_organization_id is null)
        or (owner_type = 'ORGANIZATION' and owner_organization_id is not null and owner_user_id is null)
    ),
    check ((status = 'DISABLED') = (disabled_at is not null))
);
comment on column trustcargo.payment_accounts.masked_identifier is 'Masked display value only (<= 4 digits). Raw account numbers are never stored.';
comment on column trustcargo.payment_accounts.provider_token is 'Opaque vault token issued by the licensed payment partner.';
create index payment_accounts_owner_user_id_idx on trustcargo.payment_accounts (owner_user_id);
create index payment_accounts_owner_org_id_idx on trustcargo.payment_accounts (owner_organization_id);
create index payment_accounts_replaces_account_id_idx on trustcargo.payment_accounts (replaces_account_id);
create index payment_accounts_status_idx on trustcargo.payment_accounts (status);

create table trustcargo.session_events (
    id                      uuid primary key default gen_random_uuid(),
    user_id                 uuid not null references trustcargo.users (id) on delete cascade,
    at                      timestamptz not null default now(),
    country                 trustcargo.country_code not null,
    -- Keyed pseudonyms (HMAC-SHA-256, truncated to 128 bits by pseudonymize()); never the raw value.
    device_fingerprint_hash text not null check (device_fingerprint_hash ~ '^[0-9a-f]{32,64}$'),
    ip_hash                 text not null check (ip_hash ~ '^[0-9a-f]{32,64}$')
);
create index session_events_user_id_at_idx on trustcargo.session_events (user_id, at desc);

-- =====================================================================================================
-- Configuration
-- =====================================================================================================

create table trustcargo.corridors (
    id                                uuid primary key default gen_random_uuid(),
    code                              text not null unique check (code ~ '^[A-Z0-9_-]{3,32}$'),
    origin_country                    trustcargo.country_code not null,
    destination_country               trustcargo.country_code not null,
    enabled                           boolean not null default false,
    allowed_currencies                text[] not null default '{}'
        check (allowed_currencies <@ array['CAD', 'USD', 'EUR', 'XOF']::text[]),
    -- { "CAD": "5000000", ... } — per-currency minor-unit thresholds, stored as strings (no floats).
    review_threshold_minor            jsonb not null default '{}'::jsonb check (jsonb_typeof(review_threshold_minor) = 'object'),
    expected_discharge_ports          text[] not null default '{}',
    required_documents_before_funding trustcargo.document_type[] not null default '{}',
    updated_at                        timestamptz not null default now(),
    updated_by                        uuid references trustcargo.users (id),
    check (origin_country <> destination_country)
);
create index corridors_updated_by_idx on trustcargo.corridors (updated_by);

-- Single row (TypeScript id 'default'). Defaults = DEFAULT_SECURITY_SETTINGS in src/server/services/context.ts.
create table trustcargo.security_settings (
    id                                   boolean primary key default true check (id), -- single row
    admin_mfa_max_age_minutes            integer not null default 720 check (admin_mfa_max_age_minutes between 1 and 1440),
    sensitive_action_mfa_max_age_minutes integer not null default 15 check (sensitive_action_mfa_max_age_minutes between 1 and 1440),
    payout_account_cooling_off_hours     integer not null default 72 check (payout_account_cooling_off_hours between 0 and 720),
    invitation_ttl_hours                 integer not null default 168 check (invitation_ttl_hours between 1 and 720),
    signed_url_ttl_seconds               integer not null default 300 check (signed_url_ttl_seconds between 10 and 3600),
    max_upload_bytes                     bigint  not null default 10485760 check (max_upload_bytes between 1024 and 104857600),
    updated_at                           timestamptz not null default now(),
    updated_by                           uuid references trustcargo.users (id)
);
create index security_settings_updated_by_idx on trustcargo.security_settings (updated_by);
insert into trustcargo.security_settings (id) values (true);

-- =====================================================================================================
-- Transactions
-- =====================================================================================================

create table trustcargo.transactions (
    id                          uuid primary key default gen_random_uuid(),
    reference                   text not null unique check (reference ~ '^[A-Z0-9-]{6,40}$'),
    type                        text not null default 'VEHICLE_PURCHASE' check (type in ('VEHICLE_PURCHASE', 'GOODS_PURCHASE', 'SERVICE_MILESTONES')),
    status                      trustcargo.transaction_status not null default 'DRAFT',
    title                       text not null check (length(btrim(title)) between 1 and 200),
    amount_minor                bigint not null check (amount_minor > 0),
    currency                    trustcargo.currency_code not null,
    corridor_id                 uuid not null references trustcargo.corridors (id),
    seller_organization_id      uuid references trustcargo.organizations (id),
    created_by                  uuid not null references trustcargo.users (id),
    current_contract_version_id uuid, -- FK added once contract_versions exists
    version                     integer not null default 1 check (version >= 1), -- optimistic lock
    created_at                  timestamptz not null default now(),
    updated_at                  timestamptz not null default now(),
    funded_at                   timestamptz,
    closed_at                   timestamptz,
    cancellation_reason         text,
    status_before_dispute       trustcargo.transaction_status,
    is_demo                     boolean not null default false,
    check (status <> 'CANCELLED' or cancellation_reason is not null),
    check (status_before_dispute is null or status_before_dispute not in ('DISPUTED', 'COMPLETED', 'CANCELLED', 'REFUNDED'))
);
create index transactions_status_idx on trustcargo.transactions (status);
create index transactions_corridor_id_idx on trustcargo.transactions (corridor_id);
create index transactions_seller_org_id_idx on trustcargo.transactions (seller_organization_id);
create index transactions_created_by_idx on trustcargo.transactions (created_by);
create index transactions_created_at_idx on trustcargo.transactions (created_at desc);

create table trustcargo.transaction_parties (
    id                    uuid primary key default gen_random_uuid(),
    transaction_id        uuid not null references trustcargo.transactions (id) on delete cascade,
    role                  trustcargo.party_role not null,
    user_id               uuid references trustcargo.users (id),
    organization_id       uuid references trustcargo.organizations (id),
    display_name          text not null,
    email                 text not null check (position('@' in email) > 1),
    status                text not null default 'INVITED' check (status in ('INVITED', 'JOINED', 'DECLINED', 'REMOVED')),
    -- SHA-256 of the invitation token. The raw token is never stored.
    invitation_token_hash trustcargo.sha256_hex,
    invitation_expires_at timestamptz,
    joined_at             timestamptz,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    unique (id, transaction_id),
    check (status <> 'JOINED' or (user_id is not null and joined_at is not null))
);
-- One active SELLER and one active BUYER per transaction.
create unique index transaction_parties_one_principal_per_role
    on trustcargo.transaction_parties (transaction_id, role)
    where role in ('SELLER', 'BUYER') and status in ('INVITED', 'JOINED');
create unique index transaction_parties_invitation_token_hash_key
    on trustcargo.transaction_parties (invitation_token_hash) where invitation_token_hash is not null;
create index transaction_parties_transaction_id_idx on trustcargo.transaction_parties (transaction_id);
create index transaction_parties_user_id_idx on trustcargo.transaction_parties (user_id);
create index transaction_parties_organization_id_idx on trustcargo.transaction_parties (organization_id);
create index transaction_parties_status_idx on trustcargo.transaction_parties (status);

create table trustcargo.vehicles (
    id                  uuid primary key default gen_random_uuid(),
    transaction_id      uuid not null unique references trustcargo.transactions (id) on delete cascade,
    make                text not null,
    model               text not null,
    year                integer not null check (year between 1900 and 2100),
    vin                 text not null check (length(btrim(vin)) between 1 and 32), -- validated in src/domain/vehicle/vin.ts
    mileage_km          integer not null check (mileage_km >= 0),
    declared_condition  text not null check (declared_condition in ('EXCELLENT', 'GOOD', 'FAIR', 'NEEDS_REPAIR')),
    condition_notes     text,
    origin_country      trustcargo.country_code not null,
    destination_country trustcargo.country_code not null,
    exterior_color      text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
create index vehicles_vin_idx on trustcargo.vehicles (upper(vin));

-- =====================================================================================================
-- Contracts & milestones
-- =====================================================================================================

create table trustcargo.contracts (
    id             uuid primary key default gen_random_uuid(),
    transaction_id uuid not null unique references trustcargo.transactions (id) on delete cascade,
    created_at     timestamptz not null default now(),
    unique (id, transaction_id)
);

create table trustcargo.contract_versions (
    id             uuid primary key default gen_random_uuid(),
    contract_id    uuid not null,
    transaction_id uuid not null references trustcargo.transactions (id) on delete cascade,
    version_number integer not null check (version_number >= 1),
    terms          jsonb not null check (jsonb_typeof(terms) = 'object'),
    -- SHA-256 over the canonical JSON of `terms`; acceptances bind to this hash.
    content_hash   trustcargo.sha256_hex not null,
    status         text not null default 'PROPOSED' check (status in ('PROPOSED', 'ACCEPTED', 'SUPERSEDED')),
    change_summary text,
    created_by     uuid not null references trustcargo.users (id),
    created_at     timestamptz not null default now(),
    unique (transaction_id, version_number),
    unique (id, transaction_id),
    foreign key (contract_id, transaction_id) references trustcargo.contracts (id, transaction_id)
);
create index contract_versions_contract_id_idx on trustcargo.contract_versions (contract_id, transaction_id);
create index contract_versions_created_by_idx on trustcargo.contract_versions (created_by);
create index contract_versions_status_idx on trustcargo.contract_versions (status);

alter table trustcargo.transactions
    add constraint transactions_current_contract_version_fk
    foreign key (current_contract_version_id, id) references trustcargo.contract_versions (id, transaction_id)
    deferrable initially deferred;
create index transactions_current_contract_version_idx on trustcargo.transactions (current_contract_version_id, id);

create table trustcargo.contract_acceptances (
    id                  uuid primary key default gen_random_uuid(),
    transaction_id      uuid not null references trustcargo.transactions (id) on delete cascade,
    contract_version_id uuid not null,
    party_id            uuid not null,
    user_id             uuid not null references trustcargo.users (id),
    decision            text not null check (decision in ('ACCEPTED', 'DECLINED')),
    content_hash        trustcargo.sha256_hex not null,
    comment             text,
    decided_at          timestamptz not null default now(),
    unique (contract_version_id, party_id),
    foreign key (contract_version_id, transaction_id) references trustcargo.contract_versions (id, transaction_id),
    foreign key (party_id, transaction_id) references trustcargo.transaction_parties (id, transaction_id)
);
create index contract_acceptances_transaction_id_idx on trustcargo.contract_acceptances (transaction_id);
create index contract_acceptances_cv_tx_idx on trustcargo.contract_acceptances (contract_version_id, transaction_id);
create index contract_acceptances_party_tx_idx on trustcargo.contract_acceptances (party_id, transaction_id);
create index contract_acceptances_user_id_idx on trustcargo.contract_acceptances (user_id);

create table trustcargo.milestones (
    id                    uuid primary key default gen_random_uuid(),
    transaction_id        uuid not null references trustcargo.transactions (id) on delete cascade,
    contract_version_id   uuid not null,
    sequence              integer not null check (sequence >= 1),
    key                   text not null check (key ~ '^[a-z0-9_-]{1,64}$'),
    title                 text not null,
    description           text not null default '',
    share_bps             integer not null check (share_bps between 1 and 10000),
    amount_minor          bigint not null check (amount_minor > 0),
    currency              trustcargo.currency_code not null,
    required_evidence     trustcargo.document_type[] not null default '{}',
    status                text not null default 'PENDING' check (status in ('PENDING', 'ACTIVE', 'SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED', 'RELEASED', 'REFUNDED', 'CANCELLED')),
    submitted_at          timestamptz,
    submission_note       text,
    decided_at            timestamptz,
    decided_by            uuid references trustcargo.users (id),
    change_request_reason text,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    unique (contract_version_id, sequence),
    unique (contract_version_id, key),
    unique (id, transaction_id),
    foreign key (contract_version_id, transaction_id) references trustcargo.contract_versions (id, transaction_id)
);
create index milestones_transaction_id_idx on trustcargo.milestones (transaction_id);
create index milestones_cv_tx_idx on trustcargo.milestones (contract_version_id, transaction_id);
create index milestones_decided_by_idx on trustcargo.milestones (decided_by);
create index milestones_status_idx on trustcargo.milestones (status);

-- =====================================================================================================
-- Documents
-- =====================================================================================================

create table trustcargo.documents (
    id                uuid primary key default gen_random_uuid(),
    logical_id        uuid not null,               -- all versions of a logical document share it
    version           integer not null default 1 check (version >= 1),
    transaction_id    uuid references trustcargo.transactions (id),
    owner_user_id     uuid not null references trustcargo.users (id),
    type              trustcargo.document_type not null,
    title             text not null,
    file_name         text not null check (file_name !~ '[/\\]'),
    mime_type         text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
    size_bytes        bigint not null check (size_bytes > 0),
    sha256            trustcargo.sha256_hex not null,
    -- Object path inside the private `trustcargo-documents` bucket: '<transaction_id>/<logical_id>/<version>-<file>'.
    storage_key       text not null unique,
    status            text not null default 'SCAN_PENDING' check (status in ('SCAN_PENDING', 'QUARANTINED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED', 'SUPERSEDED')),
    -- Party roles that may see the document, besides the owner and compliance staff.
    visible_to_roles  text[] not null default '{}'
        check (visible_to_roles <@ array['SELLER', 'BUYER', 'INSPECTOR', 'FREIGHT_FORWARDER']::text[]),
    extracted         jsonb not null default '{}'::jsonb check (jsonb_typeof(extracted) = 'object'),
    -- DECLARED / MOCK_EXTRACTION never prove authenticity.
    extraction_source text not null default 'NONE' check (extraction_source in ('DECLARED', 'MOCK_EXTRACTION', 'NONE')),
    scan_status       text not null default 'PENDING' check (scan_status in ('PENDING', 'CLEAN', 'INFECTED', 'ERROR')),
    scan_engine       text not null default 'none',
    scanned_at        timestamptz,
    uploaded_at       timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    unique (logical_id, version),
    unique (id, transaction_id),
    -- Transaction documents must live under their transaction's folder.
    check (transaction_id is null or storage_key like transaction_id::text || '/%'),
    -- Identity documents are never shared with counterparties.
    check (type <> 'IDENTITY' or visible_to_roles = '{}'),
    check (scan_status <> 'INFECTED' or status = 'QUARANTINED')
);
create index documents_transaction_id_idx on trustcargo.documents (transaction_id);
create index documents_owner_user_id_idx on trustcargo.documents (owner_user_id);
create index documents_status_idx on trustcargo.documents (status);
create index documents_type_idx on trustcargo.documents (type);
create index documents_uploaded_at_idx on trustcargo.documents (uploaded_at desc);

create table trustcargo.milestone_evidence (
    id             uuid primary key default gen_random_uuid(),
    milestone_id   uuid not null,
    transaction_id uuid not null references trustcargo.transactions (id) on delete cascade,
    document_id    uuid not null,
    added_by       uuid not null references trustcargo.users (id),
    added_at       timestamptz not null default now(),
    unique (milestone_id, document_id),
    foreign key (milestone_id, transaction_id) references trustcargo.milestones (id, transaction_id),
    foreign key (document_id, transaction_id) references trustcargo.documents (id, transaction_id)
);
create index milestone_evidence_transaction_id_idx on trustcargo.milestone_evidence (transaction_id);
create index milestone_evidence_milestone_tx_idx on trustcargo.milestone_evidence (milestone_id, transaction_id);
create index milestone_evidence_document_tx_idx on trustcargo.milestone_evidence (document_id, transaction_id);
create index milestone_evidence_added_by_idx on trustcargo.milestone_evidence (added_by);

create table trustcargo.document_verifications (
    id          uuid primary key default gen_random_uuid(),
    document_id uuid not null references trustcargo.documents (id),
    reviewer_id uuid not null references trustcargo.users (id),
    decision    text not null check (decision in ('VERIFIED', 'REJECTED', 'NEEDS_INFO')),
    notes       text not null default '',
    created_at  timestamptz not null default now()
);
create index document_verifications_document_id_idx on trustcargo.document_verifications (document_id);
create index document_verifications_reviewer_id_idx on trustcargo.document_verifications (reviewer_id);
create index document_verifications_created_at_idx on trustcargo.document_verifications (created_at);

create table trustcargo.document_access_logs (
    id          uuid primary key default gen_random_uuid(),
    document_id uuid not null references trustcargo.documents (id),
    user_id     uuid not null references trustcargo.users (id),
    action      text not null check (action in ('VIEW_METADATA', 'SIGNED_URL_ISSUED', 'DOWNLOAD', 'DENIED')),
    at          timestamptz not null default now()
);
create index document_access_logs_document_id_idx on trustcargo.document_access_logs (document_id, at desc);
create index document_access_logs_user_id_idx on trustcargo.document_access_logs (user_id, at desc);

-- =====================================================================================================
-- Risk & screening (internal — never visible to parties)
-- =====================================================================================================

create table trustcargo.risk_alerts (
    id                    uuid primary key default gen_random_uuid(),
    rule_id               text not null,
    category              text not null check (category in ('USER', 'TRANSACTION', 'VEHICLE')),
    severity              text not null check (severity in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    transaction_id        uuid references trustcargo.transactions (id),
    subject_user_id       uuid references trustcargo.users (id),
    fingerprint           text not null unique, -- de-duplication across re-evaluations
    reasons               jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
    recommended_action    text not null,
    blocks_funds_movement boolean not null default false,
    status                text not null default 'OPEN' check (status in ('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED')),
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    check (transaction_id is not null or subject_user_id is not null)
);
create index risk_alerts_transaction_id_idx on trustcargo.risk_alerts (transaction_id);
create index risk_alerts_subject_user_id_idx on trustcargo.risk_alerts (subject_user_id);
create index risk_alerts_status_idx on trustcargo.risk_alerts (status);
create index risk_alerts_created_at_idx on trustcargo.risk_alerts (created_at desc);

create table trustcargo.risk_reviews (
    id          uuid primary key default gen_random_uuid(),
    alert_id    uuid not null references trustcargo.risk_alerts (id),
    reviewer_id uuid not null references trustcargo.users (id),
    decision    text not null check (decision in ('CONFIRMED_RISK', 'RISK_MITIGATED', 'FALSE_POSITIVE', 'NEEDS_INFORMATION', 'ESCALATED')),
    notes       text not null,
    created_at  timestamptz not null default now()
);
create index risk_reviews_alert_id_idx on trustcargo.risk_reviews (alert_id);
create index risk_reviews_reviewer_id_idx on trustcargo.risk_reviews (reviewer_id);

create table trustcargo.screening_results (
    id                      uuid primary key default gen_random_uuid(),
    subject_type            text not null check (subject_type in ('USER', 'ORGANIZATION')),
    subject_user_id         uuid references trustcargo.users (id),
    subject_organization_id uuid references trustcargo.organizations (id),
    provider                text not null,
    provider_reference      text not null,
    result                  text not null check (result in ('NO_MATCH', 'POTENTIAL_MATCH', 'CONFIRMED_MATCH', 'ERROR')),
    lists_checked           text[] not null default '{}',
    simulated               boolean not null default true,
    checked_at              timestamptz not null default now(),
    unique (provider, provider_reference),
    check (
        (subject_type = 'USER' and subject_user_id is not null and subject_organization_id is null)
        or (subject_type = 'ORGANIZATION' and subject_organization_id is not null and subject_user_id is null)
    )
);
create index screening_results_subject_user_id_idx on trustcargo.screening_results (subject_user_id);
create index screening_results_subject_org_id_idx on trustcargo.screening_results (subject_organization_id);
create index screening_results_checked_at_idx on trustcargo.screening_results (checked_at desc);

-- =====================================================================================================
-- Disputes & compliance holds
-- =====================================================================================================

create table trustcargo.disputes (
    id                uuid primary key default gen_random_uuid(),
    transaction_id    uuid not null references trustcargo.transactions (id),
    milestone_id      uuid,
    opened_by         uuid not null references trustcargo.users (id),
    opened_by_role    text not null check (opened_by_role in ('BUYER', 'SELLER')),
    reason            text not null check (reason in ('NOT_AS_DESCRIBED', 'NOT_DELIVERED', 'SUSPICIOUS_DOCUMENTS', 'CONTRACTUAL_DELAY', 'INSPECTION_DISAGREEMENT', 'POTENTIAL_FRAUD')),
    description       text not null,
    requested_outcome text not null,
    status            text not null default 'AWAITING_RESPONSE' check (status in ('AWAITING_RESPONSE', 'UNDER_REVIEW', 'DECIDED', 'EXECUTING', 'RESOLVED', 'WITHDRAWN', 'ARCHIVED')),
    response_due_at   timestamptz not null,
    assigned_to       uuid references trustcargo.users (id),
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    resolved_at       timestamptz,
    unique (id, transaction_id),
    foreign key (milestone_id, transaction_id) references trustcargo.milestones (id, transaction_id)
);
-- At most one open dispute per transaction (DISPUTE_ALREADY_OPEN guard).
create unique index disputes_one_open_per_transaction
    on trustcargo.disputes (transaction_id)
    where status in ('AWAITING_RESPONSE', 'UNDER_REVIEW', 'DECIDED', 'EXECUTING');
create index disputes_transaction_id_idx on trustcargo.disputes (transaction_id);
create index disputes_milestone_tx_idx on trustcargo.disputes (milestone_id, transaction_id);
create index disputes_opened_by_idx on trustcargo.disputes (opened_by);
create index disputes_assigned_to_idx on trustcargo.disputes (assigned_to);
create index disputes_status_idx on trustcargo.disputes (status);
create index disputes_created_at_idx on trustcargo.disputes (created_at desc);

create table trustcargo.dispute_messages (
    id             uuid primary key default gen_random_uuid(),
    dispute_id     uuid not null,
    transaction_id uuid not null references trustcargo.transactions (id), -- denormalized for RLS
    author_id      uuid not null references trustcargo.users (id),
    author_role    text not null check (author_role in ('BUYER', 'SELLER', 'PLATFORM')),
    body           text not null check (length(body) between 1 and 10000),
    document_ids   uuid[] not null default '{}',
    created_at     timestamptz not null default now(),
    foreign key (dispute_id, transaction_id) references trustcargo.disputes (id, transaction_id)
);
create index dispute_messages_dispute_tx_idx on trustcargo.dispute_messages (dispute_id, transaction_id, created_at);
create index dispute_messages_transaction_id_idx on trustcargo.dispute_messages (transaction_id);
create index dispute_messages_author_id_idx on trustcargo.dispute_messages (author_id);

create table trustcargo.dispute_decisions (
    id                        uuid primary key default gen_random_uuid(),
    dispute_id                uuid not null unique,
    transaction_id            uuid not null references trustcargo.transactions (id),
    decided_by                uuid not null references trustcargo.users (id),
    outcome                   text not null check (outcome in ('RELEASE_TO_SELLER', 'REFUND_TO_BUYER', 'SPLIT', 'RESUME')),
    seller_amount_minor       bigint not null check (seller_amount_minor >= 0),
    buyer_refund_amount_minor bigint not null check (buyer_refund_amount_minor >= 0),
    currency                  trustcargo.currency_code not null,
    rationale                 text not null,
    contract_clause           text not null,
    mfa_verified_at           timestamptz not null,
    created_at                timestamptz not null default now(),
    foreign key (dispute_id, transaction_id) references trustcargo.disputes (id, transaction_id),
    check (outcome <> 'RESUME' or (seller_amount_minor = 0 and buyer_refund_amount_minor = 0)),
    check (outcome <> 'SPLIT' or (seller_amount_minor > 0 and buyer_refund_amount_minor > 0))
);
create index dispute_decisions_dispute_tx_idx on trustcargo.dispute_decisions (dispute_id, transaction_id);
create index dispute_decisions_transaction_id_idx on trustcargo.dispute_decisions (transaction_id);
create index dispute_decisions_decided_by_idx on trustcargo.dispute_decisions (decided_by);

-- Regulatory / legal freezes. Deliberately separate from commercial disputes.
create table trustcargo.compliance_holds (
    id             uuid primary key default gen_random_uuid(),
    transaction_id uuid not null references trustcargo.transactions (id),
    type           text not null check (type in ('SANCTIONS_REVIEW', 'COURT_ORDER', 'REGULATORY_FREEZE', 'LAW_ENFORCEMENT_REQUEST')),
    status         text not null default 'ACTIVE' check (status in ('ACTIVE', 'LIFTED')),
    reference      text not null,
    notes          text not null default '',
    placed_by      uuid not null references trustcargo.users (id),
    placed_at      timestamptz not null default now(),
    lifted_by      uuid references trustcargo.users (id),
    lifted_at      timestamptz,
    check ((status = 'LIFTED') = (lifted_at is not null and lifted_by is not null))
);
create index compliance_holds_transaction_id_idx on trustcargo.compliance_holds (transaction_id);
create index compliance_holds_active_idx on trustcargo.compliance_holds (transaction_id) where status = 'ACTIVE';
create index compliance_holds_placed_by_idx on trustcargo.compliance_holds (placed_by);
create index compliance_holds_lifted_by_idx on trustcargo.compliance_holds (lifted_by);

-- =====================================================================================================
-- Payments (mirror of the licensed partner; written by the server only)
-- =====================================================================================================

create table trustcargo.payment_instructions (
    id                 uuid primary key default gen_random_uuid(),
    transaction_id     uuid not null references trustcargo.transactions (id),
    provider           text not null,
    provider_reference text not null,
    amount_minor       bigint not null check (amount_minor > 0),
    currency           trustcargo.currency_code not null,
    payer_user_id      uuid not null references trustcargo.users (id),
    status             text not null default 'CREATED' check (status in ('CREATED', 'PENDING', 'FUNDED', 'FAILED', 'CANCELLED', 'EXPIRED')),
    -- { method, beneficiaryName, bankName, accountMasked, paymentReference, notes } — masked data only.
    details            jsonb not null check (jsonb_typeof(details) = 'object' and details ? 'method'),
    idempotency_key    text not null unique,
    expires_at         timestamptz not null,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    failure_reason     text,
    unique (provider, provider_reference)
);
create index payment_instructions_transaction_id_idx on trustcargo.payment_instructions (transaction_id);
create index payment_instructions_payer_user_id_idx on trustcargo.payment_instructions (payer_user_id);
create index payment_instructions_status_idx on trustcargo.payment_instructions (status);
create index payment_instructions_created_at_idx on trustcargo.payment_instructions (created_at desc);

create table trustcargo.payouts (
    id                  uuid primary key default gen_random_uuid(),
    transaction_id      uuid not null references trustcargo.transactions (id),
    milestone_id        uuid,
    dispute_decision_id uuid references trustcargo.dispute_decisions (id),
    payee_party_id      uuid not null,
    payment_account_id  uuid not null references trustcargo.payment_accounts (id),
    amount_minor        bigint not null check (amount_minor > 0),
    currency            trustcargo.currency_code not null,
    status              text not null default 'REQUESTED' check (status in ('REQUESTED', 'SUBMITTED', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED')),
    provider            text not null,
    provider_reference  text,
    idempotency_key     text not null unique,
    -- A user id, or 'system' when the release is re-attempted automatically (alert cleared, hold lifted).
    requested_by        text not null check (requested_by = 'system' or trustcargo_private.try_uuid(requested_by) is not null),
    requested_by_user_id uuid generated always as (trustcargo_private.try_uuid(requested_by)) stored
                        references trustcargo.users (id),
    requested_at        timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    attempts            integer not null default 0 check (attempts >= 0), -- partner submission attempts (retry policy)
    failure_reason      text,
    foreign key (milestone_id, transaction_id) references trustcargo.milestones (id, transaction_id),
    foreign key (payee_party_id, transaction_id) references trustcargo.transaction_parties (id, transaction_id),
    check (status <> 'FAILED' or failure_reason is not null)
);
create unique index payouts_provider_reference_key on trustcargo.payouts (provider, provider_reference) where provider_reference is not null;
create index payouts_transaction_id_idx on trustcargo.payouts (transaction_id);
create index payouts_milestone_tx_idx on trustcargo.payouts (milestone_id, transaction_id);
create index payouts_dispute_decision_id_idx on trustcargo.payouts (dispute_decision_id);
create index payouts_payee_party_tx_idx on trustcargo.payouts (payee_party_id, transaction_id);
create index payouts_payment_account_id_idx on trustcargo.payouts (payment_account_id);
create index payouts_requested_by_user_id_idx on trustcargo.payouts (requested_by_user_id);
create index payouts_status_idx on trustcargo.payouts (status);

create table trustcargo.refunds (
    id                  uuid primary key default gen_random_uuid(),
    transaction_id      uuid not null references trustcargo.transactions (id),
    dispute_decision_id uuid references trustcargo.dispute_decisions (id),
    payer_party_id      uuid not null,
    amount_minor        bigint not null check (amount_minor > 0),
    currency            trustcargo.currency_code not null,
    status              text not null default 'REQUESTED' check (status in ('REQUESTED', 'SUBMITTED', 'PROCESSING', 'REFUNDED', 'FAILED', 'CANCELLED')),
    provider            text not null,
    provider_reference  text,
    idempotency_key     text not null unique,
    requested_by        text not null check (requested_by = 'system' or trustcargo_private.try_uuid(requested_by) is not null),
    requested_by_user_id uuid generated always as (trustcargo_private.try_uuid(requested_by)) stored
                        references trustcargo.users (id),
    requested_at        timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    attempts            integer not null default 0 check (attempts >= 0), -- partner submission attempts (retry policy)
    failure_reason      text,
    foreign key (payer_party_id, transaction_id) references trustcargo.transaction_parties (id, transaction_id),
    check (status <> 'FAILED' or failure_reason is not null)
);
create unique index refunds_provider_reference_key on trustcargo.refunds (provider, provider_reference) where provider_reference is not null;
create index refunds_transaction_id_idx on trustcargo.refunds (transaction_id);
create index refunds_dispute_decision_id_idx on trustcargo.refunds (dispute_decision_id);
create index refunds_payer_party_tx_idx on trustcargo.refunds (payer_party_id, transaction_id);
create index refunds_requested_by_user_id_idx on trustcargo.refunds (requested_by_user_id);
create index refunds_status_idx on trustcargo.refunds (status);

create table trustcargo.provider_connections (
    id                     uuid primary key default gen_random_uuid(),
    provider               text not null unique check (provider ~ '^[a-z0-9_-]{2,40}$'),
    display_name           text not null,
    environment            text not null default 'SIMULATION' check (environment in ('SIMULATION', 'SANDBOX', 'PRODUCTION')),
    status                 text not null default 'DISABLED' check (status in ('ACTIVE', 'DISABLED')),
    capabilities           text[] not null default '{}',
    -- NAME of the secret in the secret manager (e.g. 'PARTNER_SIM_WEBHOOK_SECRET'), never the secret itself.
    webhook_secret_ref     text not null check (webhook_secret_ref ~ '^[A-Za-z][A-Za-z0-9_./-]{1,127}$'),
    regulatory_status_note text not null,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now()
);
comment on column trustcargo.provider_connections.webhook_secret_ref is 'Secret manager key NAME only. Never store the secret value.';

create table trustcargo.provider_events (
    id                 uuid primary key default gen_random_uuid(),
    provider           text not null,
    external_event_id  text not null,
    type               text not null check (type in (
        'payment.initiated', 'payment.pending', 'funds.confirmed', 'payment.failed',
        'payout.authorized', 'payout.paid', 'payout.failed',
        'refund.processing', 'refund.completed', 'refund.failed', 'provider.error')),
    payload            jsonb not null check (jsonb_typeof(payload) = 'object'),
    signature_verified boolean not null,
    status             text not null default 'RECEIVED' check (status in ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
    error              text,
    transaction_id     uuid references trustcargo.transactions (id),
    occurred_at        timestamptz not null,
    received_at        timestamptz not null default now(),
    processed_at       timestamptz,
    -- Replay protection: a partner event id is accepted once.
    unique (provider, external_event_id),
    -- Unsigned events may be stored for forensics but can never be processed.
    check (status <> 'PROCESSED' or signature_verified)
);
create index provider_events_transaction_id_idx on trustcargo.provider_events (transaction_id);
create index provider_events_status_idx on trustcargo.provider_events (status);
create index provider_events_received_at_idx on trustcargo.provider_events (received_at desc);

-- =====================================================================================================
-- Ledger (double entry, append-only — see 20261009000002_ledger_integrity.sql)
-- =====================================================================================================

create table trustcargo.ledger_accounts (
    id             uuid primary key default gen_random_uuid(),
    code           text not null unique, -- e.g. 'PARTNER_CLEARING:sim:CAD', 'TX_HELD:<tx>:CAD'
    name           text not null,
    type           text not null check (type in ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
    currency       trustcargo.currency_code not null,
    transaction_id uuid references trustcargo.transactions (id),
    created_at     timestamptz not null default now()
);
create index ledger_accounts_transaction_id_idx on trustcargo.ledger_accounts (transaction_id);

create table trustcargo.ledger_journals (
    id                  uuid primary key default gen_random_uuid(),
    idempotency_key     text not null unique check (length(idempotency_key) between 1 and 200),
    kind                text not null check (kind in ('FUNDS_REPORTED_RECEIVED', 'RELEASE_AUTHORIZED', 'PAYOUT_SETTLED', 'REFUND_AUTHORIZED', 'REFUND_SETTLED', 'REVERSAL')),
    transaction_id      uuid references trustcargo.transactions (id),
    external_reference  text,
    provider_event_id   uuid references trustcargo.provider_events (id),
    description         text not null,
    -- Corrections are made by posting a reversal journal, never by editing.
    reverses_journal_id uuid unique references trustcargo.ledger_journals (id),
    posted_by           text not null,
    posted_at           timestamptz not null default now(),
    check ((kind = 'REVERSAL') = (reverses_journal_id is not null)),
    check (reverses_journal_id is null or reverses_journal_id <> id)
);
create index ledger_journals_transaction_id_idx on trustcargo.ledger_journals (transaction_id);
create index ledger_journals_provider_event_id_idx on trustcargo.ledger_journals (provider_event_id);
create index ledger_journals_external_reference_idx on trustcargo.ledger_journals (external_reference);
create index ledger_journals_posted_at_idx on trustcargo.ledger_journals (posted_at desc);

create table trustcargo.ledger_entries (
    id           uuid primary key default gen_random_uuid(),
    journal_id   uuid not null references trustcargo.ledger_journals (id),
    account_id   uuid not null references trustcargo.ledger_accounts (id),
    direction    text not null check (direction in ('DEBIT', 'CREDIT')),
    amount_minor bigint not null check (amount_minor > 0),
    currency     trustcargo.currency_code not null,
    created_at   timestamptz not null default now()
);
create index ledger_entries_journal_id_idx on trustcargo.ledger_entries (journal_id);
create index ledger_entries_account_id_idx on trustcargo.ledger_entries (account_id);

create table trustcargo.reconciliations (
    id       uuid primary key default gen_random_uuid(),
    provider text not null,
    run_by   uuid not null references trustcargo.users (id),
    run_at   timestamptz not null default now(),
    status   text not null check (status in ('MATCHED', 'DISCREPANCIES'))
);
create index reconciliations_run_by_idx on trustcargo.reconciliations (run_by);
create index reconciliations_run_at_idx on trustcargo.reconciliations (run_at desc);

create table trustcargo.reconciliation_items (
    id                    uuid primary key default gen_random_uuid(),
    reconciliation_id     uuid not null references trustcargo.reconciliations (id) on delete cascade,
    ordinal               integer not null check (ordinal >= 0), -- position in Reconciliation.items
    external_reference    text not null,
    kind                  text not null,
    provider_amount_minor bigint,
    ledger_amount_minor   bigint,
    currency              trustcargo.currency_code not null,
    result                text not null check (result in ('MATCHED', 'MISSING_IN_LEDGER', 'MISSING_AT_PROVIDER', 'AMOUNT_MISMATCH')),
    check (result <> 'MATCHED' or provider_amount_minor = ledger_amount_minor),
    check (result <> 'MISSING_IN_LEDGER' or ledger_amount_minor is null),
    check (result <> 'MISSING_AT_PROVIDER' or provider_amount_minor is null),
    unique (reconciliation_id, ordinal)
);
create index reconciliation_items_result_idx on trustcargo.reconciliation_items (result);

-- =====================================================================================================
-- Audit & notifications
-- =====================================================================================================

create table trustcargo.audit_events (
    id             uuid primary key default gen_random_uuid(),
    -- Chain position, supplied by the writer (it is part of the hashed body); the chain trigger checks it.
    sequence       bigint not null unique check (sequence >= 1),
    at             timestamptz not null default now(),
    actor_type     text not null check (actor_type in ('USER', 'SYSTEM', 'PROVIDER')),
    -- USER: the user id. SYSTEM / PROVIDER: a label ('system', the provider name). Part of the hashed body.
    actor_id       text,
    action         text not null check (action ~ '^[a-z0-9_.]+$'),
    entity_type    text not null,
    entity_id      text not null,
    transaction_id uuid references trustcargo.transactions (id),
    metadata       jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
    -- Tamper evidence: hash = SHA-256(previous_hash + canonical event). Genesis previous_hash = 64 zeros.
    previous_hash  trustcargo.sha256_hex not null,
    hash           trustcargo.sha256_hex not null unique,
    check (actor_type <> 'USER' or trustcargo_private.try_uuid(actor_id) is not null)
);
create index audit_events_transaction_id_idx on trustcargo.audit_events (transaction_id, sequence);
create index audit_events_entity_idx on trustcargo.audit_events (entity_type, entity_id);
create index audit_events_actor_id_idx on trustcargo.audit_events (actor_id);
create index audit_events_at_idx on trustcargo.audit_events (at desc);

create table trustcargo.notifications (
    id             uuid primary key default gen_random_uuid(),
    user_id        uuid not null references trustcargo.users (id) on delete cascade,
    type           text not null,
    params         jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
    transaction_id uuid references trustcargo.transactions (id),
    read_at        timestamptz,
    created_at     timestamptz not null default now()
);
create index notifications_user_id_created_at_idx on trustcargo.notifications (user_id, created_at desc);
create index notifications_unread_idx on trustcargo.notifications (user_id) where read_at is null;
create index notifications_transaction_id_idx on trustcargo.notifications (transaction_id);

-- Named gap-free counters (e.g. 'transaction_reference'), incremented inside the writer's transaction.
-- The audit sequence is not stored here: it is derived from audit_events under the unit-of-work lock.
create table trustcargo_private.counters (
    name  text primary key check (name ~ '^[a-z][a-z0-9_]{0,62}$'),
    value bigint not null check (value >= 1)
);

-- =====================================================================================================
-- updated_at triggers
-- =====================================================================================================

do $$
declare
    t text;
begin
    -- Database-owned updated_at (no updatedAt in the TypeScript entity).
    foreach t in array array[
        'users', 'organizations', 'identity_verifications', 'beneficial_owners', 'payment_accounts',
        'transaction_parties', 'vehicles', 'milestones', 'documents', 'provider_connections'
    ] loop
        execute format(
            'create trigger %I before update on trustcargo.%I for each row execute function trustcargo_private.set_updated_at()',
            t || '_set_updated_at', t);
    end loop;
    -- Application-owned updated_at (Corridor, SecuritySettings, Transaction, RiskAlert, Dispute,
    -- PaymentInstruction, Payout, Refund carry updatedAt).
    foreach t in array array[
        'corridors', 'security_settings', 'transactions', 'risk_alerts', 'disputes', 'payment_instructions',
        'payouts', 'refunds'
    ] loop
        execute format(
            'create trigger %I before update on trustcargo.%I for each row execute function trustcargo_private.touch_updated_at()',
            t || '_touch_updated_at', t);
    end loop;
end;
$$;

-- =====================================================================================================
-- Transactions: optimistic locking + state machine guard (defense in depth for the TS engine)
-- =====================================================================================================

-- Status changes allowed by TRANSITIONS in src/domain/transaction/state-machine.ts (the integration test
-- tests/integration/postgres-adapter.test.ts compares every pair with the TypeScript definition).
create or replace function trustcargo_private.transaction_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
    select (p_from, p_to) in (
        ('DRAFT', 'AWAITING_PARTIES'), ('DRAFT', 'CANCELLED'),
        ('AWAITING_PARTIES', 'IDENTITY_VERIFICATION'), ('AWAITING_PARTIES', 'CANCELLED'),
        ('IDENTITY_VERIFICATION', 'AWAITING_AGREEMENT'), ('IDENTITY_VERIFICATION', 'CANCELLED'),
        ('AWAITING_AGREEMENT', 'AWAITING_FUNDING'), ('AWAITING_AGREEMENT', 'CANCELLED'),
        ('AWAITING_FUNDING', 'AWAITING_AGREEMENT'), ('AWAITING_FUNDING', 'FUNDING_PENDING'),
        ('AWAITING_FUNDING', 'FUNDS_CONFIRMED'), ('AWAITING_FUNDING', 'CANCELLED'),
        ('FUNDING_PENDING', 'FUNDS_CONFIRMED'), ('FUNDING_PENDING', 'AWAITING_FUNDING'),
        ('FUNDS_CONFIRMED', 'IN_PROGRESS'), ('FUNDS_CONFIRMED', 'DISPUTED'),
        ('IN_PROGRESS', 'MILESTONE_REVIEW'), ('IN_PROGRESS', 'COMPLETED'), ('IN_PROGRESS', 'DISPUTED'),
        ('MILESTONE_REVIEW', 'IN_PROGRESS'), ('MILESTONE_REVIEW', 'DISPUTED'),
        ('DISPUTED', 'IN_PROGRESS'), ('DISPUTED', 'MILESTONE_REVIEW'), ('DISPUTED', 'REFUND_PENDING'),
        ('REFUND_PENDING', 'REFUNDED'));
$$;

create or replace function trustcargo_private.transactions_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    -- Optimistic lock: writers do `update ... set ..., version = version + 1 where id = $1 and version = $2`.
    -- If the writer forgot to bump, bump for it; any other change of `version` is rejected.
    if new.version = old.version then
        new.version := old.version + 1;
    elsif new.version <> old.version + 1 then
        raise exception 'transactions.version must be incremented by exactly 1 (old %, new %)', old.version, new.version
            using errcode = '40001';
    end if;

    if new.id <> old.id or new.reference <> old.reference or new.created_by <> old.created_by then
        raise exception 'transactions.id/reference/created_by are immutable' using errcode = '42501';
    end if;

    -- AWAITING_FUNDING is not frozen: the seller may still amend the price (CONTRACT_AMENDED, guarded by
    -- "no funding started"); from FUNDING_PENDING on, the amount can no longer change.
    if old.status in ('FUNDING_PENDING', 'FUNDS_CONFIRMED', 'IN_PROGRESS', 'MILESTONE_REVIEW',
                      'DISPUTED', 'COMPLETED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED')
       and (new.amount_minor <> old.amount_minor or new.currency <> old.currency) then
        raise exception 'transaction amount is frozen once funding has started' using errcode = '42501';
    end if;

    if new.status is distinct from old.status
       and not trustcargo_private.transaction_transition_allowed(old.status::text, new.status::text) then
        raise exception 'invalid transaction status transition % -> %', old.status, new.status
            using errcode = '23514';
    end if;

    return new;
end;
$$;

create trigger transactions_before_update
    before update on trustcargo.transactions
    for each row execute function trustcargo_private.transactions_before_update();

-- Payout / refund lifecycles (mirror of PAYOUT_TRANSITIONS / REFUND_TRANSITIONS in state-machine.ts).
-- A FAILED transfer is never resubmitted as-is: it is CANCELLED and a new record is created.
create or replace function trustcargo_private.settlement_transition_allowed(p_table text, p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
    select case p_table
        when 'payouts' then (p_from, p_to) in (
            ('REQUESTED', 'SUBMITTED'), ('REQUESTED', 'FAILED'), ('REQUESTED', 'CANCELLED'),
            ('SUBMITTED', 'PROCESSING'), ('SUBMITTED', 'PAID'), ('SUBMITTED', 'FAILED'),
            ('PROCESSING', 'PAID'), ('PROCESSING', 'FAILED'),
            ('FAILED', 'CANCELLED'))
        when 'refunds' then (p_from, p_to) in (
            ('REQUESTED', 'SUBMITTED'), ('REQUESTED', 'FAILED'), ('REQUESTED', 'CANCELLED'),
            ('SUBMITTED', 'PROCESSING'), ('SUBMITTED', 'REFUNDED'), ('SUBMITTED', 'FAILED'),
            ('PROCESSING', 'REFUNDED'), ('PROCESSING', 'FAILED'),
            ('FAILED', 'CANCELLED'))
        else false
    end;
$$;

create or replace function trustcargo_private.settlement_status_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    -- Checked on every update (previously only when the status changed).
    if new.amount_minor <> old.amount_minor or new.currency <> old.currency then
        raise exception '% amount is immutable', tg_table_name using errcode = '42501';
    end if;
    if new.status <> old.status
       and not trustcargo_private.settlement_transition_allowed(tg_table_name, old.status, new.status) then
        raise exception 'invalid % status transition % -> %', tg_table_name, old.status, new.status
            using errcode = '23514';
    end if;
    return new;
end;
$$;

create trigger payouts_status_guard before update on trustcargo.payouts
    for each row execute function trustcargo_private.settlement_status_guard();
create trigger refunds_status_guard before update on trustcargo.refunds
    for each row execute function trustcargo_private.settlement_status_guard();
