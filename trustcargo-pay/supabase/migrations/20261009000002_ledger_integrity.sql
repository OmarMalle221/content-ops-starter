-- =====================================================================================================
-- TrustCargo Pay — ledger & audit integrity
--
--   * ledger_journals / ledger_entries / audit_events are append-only (UPDATE, DELETE, TRUNCATE raise).
--     Ledger corrections are made by posting a REVERSAL journal (reverses_journal_id).
--   * A DEFERRABLE INITIALLY DEFERRED constraint trigger checks, at commit, that each journal has
--     >= 2 entries and that debits = credits per currency.
--   * An entry's currency must equal its account's currency.
--   * trustcargo.post_ledger_journal(...) is the single, idempotent write path (service_role only).
--   * provider_events can never be deleted, and their signed content is immutable.
--   * audit_events form a hash chain: previous_hash must equal the hash of the latest event.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- Append-only guard
-- -----------------------------------------------------------------------------------------------------

create or replace function trustcargo_private.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    raise exception '%.% is append-only: % is not allowed%', tg_table_schema, tg_table_name, tg_op,
        case when tg_table_name like 'ledger_%' then ' (post a reversal journal instead)' else '' end
        using errcode = '42501';
end;
$$;

create trigger ledger_journals_append_only
    before update or delete on trustcargo.ledger_journals
    for each row execute function trustcargo_private.forbid_mutation();
create trigger ledger_journals_no_truncate
    before truncate on trustcargo.ledger_journals
    for each statement execute function trustcargo_private.forbid_mutation();

create trigger ledger_entries_append_only
    before update or delete on trustcargo.ledger_entries
    for each row execute function trustcargo_private.forbid_mutation();
create trigger ledger_entries_no_truncate
    before truncate on trustcargo.ledger_entries
    for each statement execute function trustcargo_private.forbid_mutation();

create trigger audit_events_append_only
    before update or delete on trustcargo.audit_events
    for each row execute function trustcargo_private.forbid_mutation();
create trigger audit_events_no_truncate
    before truncate on trustcargo.audit_events
    for each statement execute function trustcargo_private.forbid_mutation();

-- provider_events: never deleted; only the processing outcome may change.
create trigger provider_events_no_delete
    before delete on trustcargo.provider_events
    for each row execute function trustcargo_private.forbid_mutation();
create trigger provider_events_no_truncate
    before truncate on trustcargo.provider_events
    for each statement execute function trustcargo_private.forbid_mutation();

create or replace function trustcargo_private.provider_events_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.id <> old.id
       or new.provider <> old.provider
       or new.external_event_id <> old.external_event_id
       or new.type <> old.type
       or new.payload <> old.payload
       or new.signature_verified <> old.signature_verified
       or new.occurred_at <> old.occurred_at
       or new.received_at <> old.received_at then
        raise exception 'provider_events: received content is immutable (only status/error/transaction_id/processed_at may change)'
            using errcode = '42501';
    end if;
    if old.status = 'PROCESSED' and new.status <> 'PROCESSED' then
        raise exception 'provider_events: a processed event cannot be re-opened' using errcode = '42501';
    end if;
    return new;
end;
$$;

create trigger provider_events_guard_update
    before update on trustcargo.provider_events
    for each row execute function trustcargo_private.provider_events_guard_update();

-- ledger_accounts: identity of an account (code, currency, type, transaction) is immutable.
create or replace function trustcargo_private.ledger_accounts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'ledger_accounts cannot be deleted' using errcode = '42501';
    end if;
    if new.code <> old.code or new.currency <> old.currency or new.type <> old.type
       or new.transaction_id is distinct from old.transaction_id then
        raise exception 'ledger_accounts: code/currency/type/transaction_id are immutable' using errcode = '42501';
    end if;
    return new;
end;
$$;

create trigger ledger_accounts_guard
    before update or delete on trustcargo.ledger_accounts
    for each row execute function trustcargo_private.ledger_accounts_guard();

-- -----------------------------------------------------------------------------------------------------
-- Entry currency must match account currency
-- -----------------------------------------------------------------------------------------------------

create or replace function trustcargo_private.ledger_entry_currency_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_account_currency text;
begin
    select a.currency into v_account_currency from trustcargo.ledger_accounts a where a.id = new.account_id;
    if v_account_currency is null then
        raise exception 'ledger account % does not exist', new.account_id using errcode = '23503';
    end if;
    if v_account_currency <> new.currency::text then
        raise exception 'ledger entry currency % does not match account currency %', new.currency, v_account_currency
            using errcode = '23514';
    end if;
    return new;
end;
$$;

create trigger ledger_entries_currency_check
    before insert on trustcargo.ledger_entries
    for each row execute function trustcargo_private.ledger_entry_currency_check();

-- -----------------------------------------------------------------------------------------------------
-- Reversal rules (mirror of buildReversal in src/domain/ledger/ledger.ts)
-- -----------------------------------------------------------------------------------------------------

create or replace function trustcargo_private.ledger_journal_reversal_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_original trustcargo.ledger_journals%rowtype;
begin
    if new.reverses_journal_id is null then
        return new;
    end if;
    select * into v_original from trustcargo.ledger_journals where id = new.reverses_journal_id;
    if not found then
        raise exception 'reversed journal % does not exist', new.reverses_journal_id using errcode = '23503';
    end if;
    if v_original.kind = 'REVERSAL' then
        raise exception 'a reversal cannot itself be reversed; post a new journal instead' using errcode = '23514';
    end if;
    if v_original.transaction_id is distinct from new.transaction_id then
        raise exception 'a reversal must reference the same transaction as the original journal' using errcode = '23514';
    end if;
    return new;
end;
$$;

create trigger ledger_journals_reversal_check
    before insert on trustcargo.ledger_journals
    for each row execute function trustcargo_private.ledger_journal_reversal_check();

-- -----------------------------------------------------------------------------------------------------
-- Balance check (deferred to commit)
-- -----------------------------------------------------------------------------------------------------

create or replace function trustcargo_private.assert_journal_balanced(p_journal_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_count    integer;
    v_currency text;
    v_debit    numeric;
    v_credit   numeric;
begin
    select count(*) into v_count from trustcargo.ledger_entries where journal_id = p_journal_id;
    if v_count < 2 then
        raise exception 'ledger journal % must have at least 2 entries (has %)', p_journal_id, v_count
            using errcode = '23514';
    end if;

    -- numeric aggregation of bigint values cannot overflow; amounts are integers, no float involved.
    for v_currency, v_debit, v_credit in
        select e.currency::text,
               coalesce(sum(e.amount_minor) filter (where e.direction = 'DEBIT'), 0),
               coalesce(sum(e.amount_minor) filter (where e.direction = 'CREDIT'), 0)
        from trustcargo.ledger_entries e
        where e.journal_id = p_journal_id
        group by e.currency
    loop
        if v_debit <> v_credit then
            raise exception 'ledger journal % is unbalanced in %: debits % <> credits %',
                p_journal_id, v_currency, v_debit, v_credit
                using errcode = '23514';
        end if;
    end loop;
end;
$$;

create or replace function trustcargo_private.ledger_balance_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if tg_table_name = 'ledger_journals' then
        perform trustcargo_private.assert_journal_balanced(new.id);
    else
        perform trustcargo_private.assert_journal_balanced(new.journal_id);
    end if;
    return null;
end;
$$;

create constraint trigger ledger_entries_balanced
    after insert on trustcargo.ledger_entries
    deferrable initially deferred
    for each row execute function trustcargo_private.ledger_balance_trigger();

-- Catches journals inserted without any entry.
create constraint trigger ledger_journals_balanced
    after insert on trustcargo.ledger_journals
    deferrable initially deferred
    for each row execute function trustcargo_private.ledger_balance_trigger();

-- -----------------------------------------------------------------------------------------------------
-- post_ledger_journal: the only supported write path for the ledger.
--
-- p_entries: jsonb array of objects:
--   { "account_code": "TX_HELD:<tx>:CAD" | "account_id": "<uuid>",
--     "direction": "DEBIT" | "CREDIT",
--     "amount_minor": "185000000"   (string or JSON integer — parsed as bigint, never float),
--     "currency": "CAD",
--     -- optional, to open the account on first use (chart of accounts is deterministic):
--     "account_name": "...", "account_type": "ASSET|LIABILITY|...", "account_transaction_id": "<uuid>" }
--
-- Idempotent: if p_idempotency_key already exists, returns the existing journal id (and raises if the
-- key is reused with a different kind / transaction). Journal + entries are inserted atomically; the
-- balance is validated immediately (and again by the deferred constraint trigger at commit).
-- -----------------------------------------------------------------------------------------------------

create or replace function trustcargo.post_ledger_journal(
    p_idempotency_key     text,
    p_kind                text,
    p_transaction_id      uuid,
    p_external_reference  text,
    p_description         text,
    p_entries             jsonb,
    p_posted_by           text default 'system',
    p_reverses_journal_id uuid default null,
    p_provider_event_id   uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_journal_id uuid;
    v_existing   trustcargo.ledger_journals%rowtype;
    v_entry      jsonb;
    v_account_id uuid;
    v_amount     bigint;
    v_direction  text;
    v_currency   text;
    v_first_ccy  text;
    v_debit      numeric := 0;
    v_credit     numeric := 0;
begin
    if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
        raise exception 'idempotency key is required' using errcode = '22023';
    end if;
    if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) < 2 then
        raise exception 'a journal needs at least two entries' using errcode = '22023';
    end if;

    -- Fast path: already posted.
    select * into v_existing from trustcargo.ledger_journals where idempotency_key = p_idempotency_key;
    if found then
        if v_existing.kind <> p_kind or v_existing.transaction_id is distinct from p_transaction_id then
            raise exception 'idempotency key % reused with different parameters', p_idempotency_key
                using errcode = '22023';
        end if;
        return v_existing.id;
    end if;

    -- Validate entries before writing anything.
    for v_entry in select value from jsonb_array_elements(p_entries) loop
        v_direction := v_entry ->> 'direction';
        v_currency  := v_entry ->> 'currency';
        if v_direction is null or v_direction not in ('DEBIT', 'CREDIT') then
            raise exception 'invalid entry direction: %', v_direction using errcode = '22023';
        end if;
        if v_currency is null then
            raise exception 'entry currency is required' using errcode = '22023';
        end if;
        if (v_entry ->> 'amount_minor') is null
           or jsonb_typeof(v_entry -> 'amount_minor') not in ('string', 'number')
           or (v_entry ->> 'amount_minor') !~ '^[0-9]{1,18}$' then
            raise exception 'amount_minor must be a positive integer in minor units (got %)', v_entry -> 'amount_minor'
                using errcode = '22023';
        end if;
        v_amount := (v_entry ->> 'amount_minor')::bigint;
        if v_amount <= 0 then
            raise exception 'entry amounts must be strictly positive' using errcode = '22023';
        end if;
        v_first_ccy := coalesce(v_first_ccy, v_currency);
        if v_currency is distinct from v_first_ccy then
            raise exception 'multi-currency journals are not supported' using errcode = '22023';
        end if;
        if v_direction = 'DEBIT' then
            v_debit := v_debit + v_amount;
        else
            v_credit := v_credit + v_amount;
        end if;
    end loop;
    if v_debit <> v_credit then
        raise exception 'journal unbalanced: debit % <> credit %', v_debit, v_credit using errcode = '23514';
    end if;

    -- Concurrency-safe insert: a concurrent poster with the same key waits, then gets the existing id.
    insert into trustcargo.ledger_journals (
        idempotency_key, kind, transaction_id, external_reference, provider_event_id,
        description, reverses_journal_id, posted_by)
    values (
        p_idempotency_key, p_kind, p_transaction_id, p_external_reference, p_provider_event_id,
        p_description, p_reverses_journal_id, coalesce(p_posted_by, 'system'))
    on conflict (idempotency_key) do nothing
    returning id into v_journal_id;

    if v_journal_id is null then
        select * into v_existing from trustcargo.ledger_journals where idempotency_key = p_idempotency_key;
        if v_existing.kind <> p_kind or v_existing.transaction_id is distinct from p_transaction_id then
            raise exception 'idempotency key % reused with different parameters', p_idempotency_key
                using errcode = '22023';
        end if;
        return v_existing.id;
    end if;

    for v_entry in select value from jsonb_array_elements(p_entries) loop
        if v_entry ? 'account_id' then
            v_account_id := (v_entry ->> 'account_id')::uuid;
        else
            if v_entry ? 'account_type' then
                insert into trustcargo.ledger_accounts (code, name, type, currency, transaction_id)
                values (
                    v_entry ->> 'account_code',
                    coalesce(v_entry ->> 'account_name', v_entry ->> 'account_code'),
                    v_entry ->> 'account_type',
                    (v_entry ->> 'currency')::trustcargo.currency_code,
                    (v_entry ->> 'account_transaction_id')::uuid)
                on conflict (code) do nothing;
            end if;
            select a.id into v_account_id from trustcargo.ledger_accounts a where a.code = v_entry ->> 'account_code';
        end if;
        if v_account_id is null then
            raise exception 'unknown ledger account %', coalesce(v_entry ->> 'account_code', v_entry ->> 'account_id')
                using errcode = '23503';
        end if;

        insert into trustcargo.ledger_entries (journal_id, account_id, direction, amount_minor, currency)
        values (
            v_journal_id,
            v_account_id,
            v_entry ->> 'direction',
            (v_entry ->> 'amount_minor')::bigint,
            (v_entry ->> 'currency')::trustcargo.currency_code);
        v_account_id := null;
    end loop;

    perform trustcargo_private.assert_journal_balanced(v_journal_id);
    return v_journal_id;
end;
$$;

revoke all on function trustcargo.post_ledger_journal(text, text, uuid, text, text, jsonb, text, uuid, uuid) from public;
revoke all on function trustcargo.post_ledger_journal(text, text, uuid, text, text, jsonb, text, uuid, uuid) from anon, authenticated;
grant execute on function trustcargo.post_ledger_journal(text, text, uuid, text, text, jsonb, text, uuid, uuid) to service_role;

-- Account balances (normal side), handy for reconciliation. security_invoker => RLS of the caller applies.
create or replace view trustcargo.ledger_account_balances
with (security_invoker = true) as
select a.id as account_id,
       a.code,
       a.type,
       a.currency,
       a.transaction_id,
       coalesce(sum(e.amount_minor) filter (where e.direction = 'DEBIT'), 0)::bigint  as debits_minor,
       coalesce(sum(e.amount_minor) filter (where e.direction = 'CREDIT'), 0)::bigint as credits_minor,
       (case when a.type in ('ASSET', 'EXPENSE')
             then coalesce(sum(e.amount_minor) filter (where e.direction = 'DEBIT'), 0)
                  - coalesce(sum(e.amount_minor) filter (where e.direction = 'CREDIT'), 0)
             else coalesce(sum(e.amount_minor) filter (where e.direction = 'CREDIT'), 0)
                  - coalesce(sum(e.amount_minor) filter (where e.direction = 'DEBIT'), 0)
        end)::bigint as balance_minor
from trustcargo.ledger_accounts a
left join trustcargo.ledger_entries e on e.account_id = a.id
group by a.id;

-- -----------------------------------------------------------------------------------------------------
-- Audit hash chain linkage
--
-- The application computes hash = SHA-256(previous_hash + canonical event) (canonical form is defined
-- in TypeScript). The database enforces the *linkage*: inserts are serialized, `sequence` is assigned
-- under the lock (so sequence order = chain order) and previous_hash must equal the latest hash
-- (64 zeros for the genesis event). A writer racing on a stale head gets an error and must retry.
-- -----------------------------------------------------------------------------------------------------

create or replace function trustcargo_private.audit_events_chain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_head text;
begin
    perform pg_advisory_xact_lock(hashtextextended('trustcargo.audit_events.chain', 0));
    new.sequence := nextval(pg_get_serial_sequence('trustcargo.audit_events', 'sequence'));
    select a.hash into v_head from trustcargo.audit_events a order by a.sequence desc limit 1;
    if new.previous_hash <> coalesce(v_head, repeat('0', 64)) then
        raise exception 'audit chain broken: previous_hash % does not match head %',
            new.previous_hash, coalesce(v_head, repeat('0', 64))
            using errcode = '40001';
    end if;
    if new.hash = new.previous_hash then
        raise exception 'audit hash must differ from previous_hash' using errcode = '23514';
    end if;
    return new;
end;
$$;

create trigger audit_events_chain
    before insert on trustcargo.audit_events
    for each row execute function trustcargo_private.audit_events_chain();
