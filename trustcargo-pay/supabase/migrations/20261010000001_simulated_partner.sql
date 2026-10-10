-- =====================================================================================================
-- TrustCargo Pay — records of the SIMULATED payment partner (SIMULATION ONLY)
--
-- In SIMULATION mode the licensed payment partner is played by MockPaymentProvider
-- (src/server/adapters/mock/mock-payment-provider.ts). No real money is held, received or transferred.
-- Schema `trustcargo_sim` holds the FAKE partner's own records (its payment instructions, its transfers
-- and its account statement) so the simulator survives a restart and is shared by several instances
-- (src/server/adapters/postgres/pg-simulated-partner-store.ts).
--
--   * This is NOT TrustCargo's books. TrustCargo's records (payment_instructions, payouts, refunds,
--     provider_events, ledger) live in schema `trustcargo`; reconciliation compares them with the
--     statement below. Nothing here is a financial confirmation.
--   * The fake partner stands for an external system: no foreign key to or from `trustcargo`, and the
--     server writes here in its own short transactions on a separate connection pool, never inside a
--     TrustCargo unit of work.
--   * Minimal data: references, amounts and statuses only (no payer name, no bank details).
--   * service_role only: no privilege for anon / authenticated, RLS enabled without policies, not
--     exposed through PostgREST. Amounts, references and statement lines cannot be changed or deleted.
--   * Production refuses the mock provider at startup; drop this schema once a licensed partner adapter
--     replaces it.
--   * Nothing is created in `public`.
-- =====================================================================================================

create schema if not exists trustcargo_sim;
revoke all on schema trustcargo_sim from public;
comment on schema trustcargo_sim is
    'SIMULATION ONLY: records of the fictitious payment partner (MockPaymentProvider). Not TrustCargo''s books; no real funds.';

-- Payment instructions issued by the fake partner (one per idempotency key).
create table trustcargo_sim.instructions (
    id              bigint generated always as identity primary key, -- creation order
    reference       text not null unique check (reference ~ '^sim_pi_[A-Za-z0-9_-]{1,64}$'),
    idempotency_key text not null unique check (length(idempotency_key) between 1 and 500),
    amount_minor    bigint not null check (amount_minor > 0),
    currency        char(3) not null check (currency ~ '^[A-Z]{3}$'),
    status          text not null default 'CREATED' check (status in ('CREATED', 'PENDING', 'FUNDED', 'FAILED', 'EXPIRED')),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
comment on table trustcargo_sim.instructions is
    'SIMULATION ONLY: payment instructions of the fictitious partner. Not TrustCargo''s books.';

-- Payouts and refunds submitted to the fake partner (one per idempotency key).
create table trustcargo_sim.transfers (
    id              bigint generated always as identity primary key, -- creation order
    reference       text not null unique check (reference ~ '^sim_(po|rf)_[A-Za-z0-9_-]{1,64}$'),
    kind            text not null check (kind in ('PAYOUT', 'REFUND')),
    idempotency_key text not null unique check (length(idempotency_key) between 1 and 500),
    amount_minor    bigint not null check (amount_minor > 0),
    currency        char(3) not null check (currency ~ '^[A-Z]{3}$'),
    status          text not null default 'SUBMITTED' check (status in ('SUBMITTED', 'PROCESSING', 'PAID', 'FAILED')),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint transfers_reference_matches_kind check ((kind = 'PAYOUT') = (reference like 'sim\_po\_%'))
);
comment on table trustcargo_sim.transfers is
    'SIMULATION ONLY: payouts and refunds of the fictitious partner. Not TrustCargo''s books.';

-- The fake partner's account statement, append-only (read by reconciliation as the "partner side").
create table trustcargo_sim.statement_lines (
    id                 bigint generated always as identity primary key, -- recording order
    external_reference text not null check (length(external_reference) between 1 and 200),
    kind               text not null check (kind in ('FUNDS_RECEIVED', 'PAYOUT_PAID', 'REFUND_PAID')),
    amount_minor       bigint not null check (amount_minor > 0),
    currency           char(3) not null check (currency ~ '^[A-Z]{3}$'),
    occurred_at        timestamptz not null,
    recorded_at        timestamptz not null default now()
);
create index statement_lines_occurred_at_idx on trustcargo_sim.statement_lines (occurred_at);
comment on table trustcargo_sim.statement_lines is
    'SIMULATION ONLY: account statement of the fictitious partner (append-only). Not TrustCargo''s books.';

-- RLS without policies: only roles with BYPASSRLS (service_role) can read or write rows.
alter table trustcargo_sim.instructions enable row level security;
alter table trustcargo_sim.transfers enable row level security;
alter table trustcargo_sim.statement_lines enable row level security;

-- Privileges: service_role only. Statuses are the only updatable columns; nothing can be deleted.
revoke all on all tables in schema trustcargo_sim from public, anon, authenticated, service_role;
revoke all on all sequences in schema trustcargo_sim from public, anon, authenticated, service_role;
alter default privileges in schema trustcargo_sim revoke all on tables from public, anon, authenticated;
alter default privileges in schema trustcargo_sim revoke all on sequences from public, anon, authenticated;
alter default privileges in schema trustcargo_sim revoke all on functions from public, anon, authenticated;
grant usage on schema trustcargo_sim to service_role;
grant select, insert on trustcargo_sim.instructions, trustcargo_sim.transfers, trustcargo_sim.statement_lines to service_role;
grant update (status, updated_at) on trustcargo_sim.instructions, trustcargo_sim.transfers to service_role;
