-- =====================================================================================================
-- TrustCargo Pay — self-checking RLS & ledger tests.
-- Run on a FRESH database after supabase_shim.sql + migrations (see scripts/test-db.sh).
-- Every check raises an exception on failure; with ON_ERROR_STOP psql exits non-zero.
-- =====================================================================================================
\set ON_ERROR_STOP on
\set QUIET on
-- Silence result sets; \echo still prints progress, errors still go to stderr.
\o /dev/null
set client_min_messages = warning;

-- -----------------------------------------------------------------------------------------------------
-- Test helpers (security invoker: they run with the privileges of the current role)
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

-- Statement must be rejected with insufficient_privilege (missing grant or RLS WITH CHECK violation).
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

-- Statement must fail (optionally with a given SQLSTATE).
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

-- Number of rows affected by a DML statement (0 when RLS hides the target rows).
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

\echo '== structural checks'

-- Every table in trustcargo, trustcargo_private and trustcargo_sim has RLS enabled.
select tst.eq('tables in trustcargo / trustcargo_private / trustcargo_sim without RLS', (
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('trustcargo', 'trustcargo_private', 'trustcargo_sim') and c.relkind in ('r', 'p') and not c.relrowsecurity), 0);

-- The target Supabase project is shared with another application: the migrations create nothing in
-- `public` (the shim does not either; the tst schema below is created after this check).
select tst.eq('relations (tables, views, sequences, indexes...) in public', (
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'), 0);
select tst.eq('types and domains in public', (
    select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public'), 0);
select tst.eq('functions and procedures in public', (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'), 0);

-- Private tables (counters, demo TOTP secrets): service_role only.
select tst.eq('anon/authenticated privileges on trustcargo_private tables', (
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) as r (rolname)
    where n.nspname = 'trustcargo_private' and c.relkind in ('r', 'p')
      and (has_table_privilege(r.rolname, c.oid, 'SELECT') or has_table_privilege(r.rolname, c.oid, 'INSERT')
           or has_table_privilege(r.rolname, c.oid, 'UPDATE') or has_table_privilege(r.rolname, c.oid, 'DELETE'))), 0);
-- (has_table_privilege with a list is true when ANY privilege is held: check them one by one.)
select tst.ok('service_role can read and write demo TOTP secrets',
    has_table_privilege('service_role', 'trustcargo_private.demo_mfa_secrets', 'SELECT')
    and has_table_privilege('service_role', 'trustcargo_private.demo_mfa_secrets', 'INSERT')
    and has_table_privilege('service_role', 'trustcargo_private.demo_mfa_secrets', 'UPDATE')
    and has_table_privilege('service_role', 'trustcargo_private.demo_mfa_secrets', 'DELETE'));
select tst.ok('service_role can increment counters but not delete them',
    has_table_privilege('service_role', 'trustcargo_private.counters', 'SELECT')
    and has_table_privilege('service_role', 'trustcargo_private.counters', 'INSERT')
    and has_table_privilege('service_role', 'trustcargo_private.counters', 'UPDATE')
    and not has_table_privilege('service_role', 'trustcargo_private.counters', 'DELETE'));

-- Simulated partner (SIMULATION ONLY, fake partner's records): service_role only, nothing for anon / authenticated.
select tst.eq('trustcargo_sim tables', (
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'trustcargo_sim' and c.relkind in ('r', 'p')), 3);
select tst.ok('anon/authenticated have no usage on schema trustcargo_sim',
    not has_schema_privilege('anon', 'trustcargo_sim', 'USAGE') and not has_schema_privilege('authenticated', 'trustcargo_sim', 'USAGE')
    and not has_schema_privilege('anon', 'trustcargo_sim', 'CREATE') and not has_schema_privilege('authenticated', 'trustcargo_sim', 'CREATE'));
select tst.eq('anon/authenticated table privileges on trustcargo_sim', (
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) as r (rolname)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p (priv)
    where n.nspname = 'trustcargo_sim' and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_table_privilege(r.rolname, c.oid, p.priv)), 0);
select tst.eq('anon/authenticated column privileges on trustcargo_sim', (
    select count(*) from information_schema.column_privileges
    where table_schema = 'trustcargo_sim' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
select tst.eq('anon/authenticated sequence privileges on trustcargo_sim', (
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) as r (rolname)
    cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) as p (priv)
    where n.nspname = 'trustcargo_sim' and c.relkind = 'S' and has_sequence_privilege(r.rolname, c.oid, p.priv)), 0);
select tst.eq('functions in trustcargo_sim', (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'trustcargo_sim'), 0);
select tst.ok('service_role reads and records the simulated partner state but cannot delete it', (
    select bool_and(has_table_privilege('service_role', format('trustcargo_sim.%I', t), 'SELECT')
                    and has_table_privilege('service_role', format('trustcargo_sim.%I', t), 'INSERT')
                    and not has_table_privilege('service_role', format('trustcargo_sim.%I', t), 'DELETE')
                    and not has_table_privilege('service_role', format('trustcargo_sim.%I', t), 'TRUNCATE'))
    from unnest(array['instructions', 'transfers', 'statement_lines']) as t));
select tst.ok('service_role may only update simulated statuses (amounts, references, statement are immutable)',
    has_column_privilege('service_role', 'trustcargo_sim.instructions', 'status', 'UPDATE')
    and has_column_privilege('service_role', 'trustcargo_sim.transfers', 'status', 'UPDATE')
    and not has_column_privilege('service_role', 'trustcargo_sim.instructions', 'amount_minor', 'UPDATE')
    and not has_column_privilege('service_role', 'trustcargo_sim.instructions', 'reference', 'UPDATE')
    and not has_column_privilege('service_role', 'trustcargo_sim.transfers', 'amount_minor', 'UPDATE')
    and not has_column_privilege('service_role', 'trustcargo_sim.transfers', 'idempotency_key', 'UPDATE')
    and not has_table_privilege('service_role', 'trustcargo_sim.statement_lines', 'UPDATE'));
-- The fake partner is an external system: no foreign key between its records and TrustCargo's.
select tst.eq('foreign keys from or to trustcargo_sim', (
    select count(*) from pg_constraint con
    where con.contype = 'f'
      and (con.connamespace = 'trustcargo_sim'::regnamespace
           or con.confrelid in (select c.oid from pg_class c where c.relnamespace = 'trustcargo_sim'::regnamespace))), 0);

-- No foreign key from trustcargo.users to auth.users (demo personas have no Supabase Auth account).
select tst.eq('foreign keys from trustcargo tables to auth.users', (
    select count(*) from pg_constraint con
    where con.contype = 'f' and con.confrelid = 'auth.users'::regclass), 0);

-- Defaults of the single security_settings row = DEFAULT_SECURITY_SETTINGS (src/server/services/context.ts).
select tst.ok('security_settings defaults match the TypeScript defaults', (
    select admin_mfa_max_age_minutes = 720 and sensitive_action_mfa_max_age_minutes = 15
       and payout_account_cooling_off_hours = 72 and invitation_ttl_hours = 168
       and signed_url_ttl_seconds = 300 and max_upload_bytes = 10485760
    from trustcargo.security_settings where id));

-- anon has no privilege at all on trustcargo tables / views.
select tst.eq('anon privileges on trustcargo relations', (
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'trustcargo' and c.relkind in ('r', 'p', 'v')
      and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'INSERT')
           or has_table_privilege('anon', c.oid, 'UPDATE') or has_table_privilege('anon', c.oid, 'DELETE'))), 0);

-- authenticated cannot INSERT/DELETE into any trustcargo table except corridors (platform_admin policy).
select tst.eq('authenticated insert/delete grants outside corridors', (
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'trustcargo' and c.relkind in ('r', 'p') and c.relname <> 'corridors'
      and (has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'DELETE')
           or has_table_privilege('authenticated', c.oid, 'TRUNCATE'))), 0);

-- Every foreign key is covered by an index whose leading columns are the FK columns.
select tst.eq('foreign keys without a covering index', (
    select count(*)
    from pg_constraint con
    join pg_namespace n on n.oid = con.connamespace
    where con.contype = 'f' and n.nspname = 'trustcargo'
      and not exists (
          select 1 from pg_index i
          where i.indrelid = con.conrelid
            and (i.indkey::int2[])[0:cardinality(con.conkey) - 1] @> con.conkey
            and (i.indkey::int2[])[0:cardinality(con.conkey) - 1] <@ con.conkey)), 0);

-- post_ledger_journal is not executable by anon / authenticated.
select tst.ok('post_ledger_journal not executable by authenticated',
    not has_function_privilege('authenticated', 'trustcargo.post_ledger_journal(text,text,uuid,text,text,jsonb,text,uuid,uuid)', 'EXECUTE'));
select tst.ok('post_ledger_journal not executable by anon',
    not has_function_privilege('anon', 'trustcargo.post_ledger_journal(text,text,uuid,text,text,jsonb,text,uuid,uuid)', 'EXECUTE'));
select tst.ok('post_ledger_journal executable by service_role',
    has_function_privilege('service_role', 'trustcargo.post_ledger_journal(text,text,uuid,text,text,jsonb,text,uuid,uuid)', 'EXECUTE'));
select tst.ok('trustcargo-documents bucket is private',
    (select not public from storage.buckets where id = 'trustcargo-documents'));
-- The shared project's storage policies are left untouched: TrustCargo creates none.
select tst.eq('no storage.objects policy created by TrustCargo', (
    select count(*) from pg_policies
    where schemaname = 'storage'
      and (policyname like 'trustcargo%' or coalesce(qual, '') like '%trustcargo%' or coalesce(with_check, '') like '%trustcargo%')), 0);

\echo '== seeding (superuser)'
begin;

-- Users: A seller, A2 colleague of A (same org), B buyer, C outsider (other org), D inspector,
--        E compliance analyst, F finance operator.
insert into auth.users (id, email) values
    ('a0000000-0000-4000-8000-00000000000a', 'seller.a@example.test'),
    ('a2000000-0000-4000-8000-0000000000a2', 'colleague.a2@example.test'),
    ('b0000000-0000-4000-8000-00000000000b', 'buyer.b@example.test'),
    ('c0000000-0000-4000-8000-00000000000c', 'outsider.c@example.test'),
    ('d0000000-0000-4000-8000-00000000000d', 'inspector.d@example.test'),
    ('e0000000-0000-4000-8000-00000000000e', 'compliance.e@example.test'),
    ('f0000000-0000-4000-8000-00000000000f', 'finance.f@example.test');

insert into trustcargo.users (id, email, full_name, country, kyc_status, is_demo) values
    ('a0000000-0000-4000-8000-00000000000a', 'seller.a@example.test', 'Alice Seller', 'CA', 'VERIFIED', true),
    ('a2000000-0000-4000-8000-0000000000a2', 'colleague.a2@example.test', 'Aaron Colleague', 'CA', 'VERIFIED', true),
    ('b0000000-0000-4000-8000-00000000000b', 'buyer.b@example.test', 'Bamba Buyer', 'SN', 'VERIFIED', true),
    ('c0000000-0000-4000-8000-00000000000c', 'outsider.c@example.test', 'Chloe Outsider', 'CA', 'PENDING', true),
    ('d0000000-0000-4000-8000-00000000000d', 'inspector.d@example.test', 'Dan Inspector', 'CA', 'VERIFIED', true),
    ('e0000000-0000-4000-8000-00000000000e', 'compliance.e@example.test', 'Eve Compliance', 'CA', 'VERIFIED', true),
    ('f0000000-0000-4000-8000-00000000000f', 'finance.f@example.test', 'Fatou Finance', 'SN', 'VERIFIED', true);

insert into trustcargo.user_platform_roles (user_id, role) values
    ('e0000000-0000-4000-8000-00000000000e', 'compliance_analyst'),
    ('f0000000-0000-4000-8000-00000000000f', 'finance_operator');

insert into trustcargo.organizations (id, legal_name, registration_number, country, type, kyb_status) values
    ('01000000-0000-4000-8000-000000000001', 'Autos Laval Inc.', 'QC-1170001', 'CA', 'DEALER', 'VERIFIED'),
    ('02000000-0000-4000-8000-000000000002', 'Other Motors Ltd.', 'ON-2280002', 'CA', 'EXPORTER', 'PENDING');

insert into trustcargo.organization_members (organization_id, user_id, role) values
    ('01000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', 'OWNER'),
    ('01000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-0000000000a2', 'MEMBER'),
    ('02000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000c', 'OWNER');

insert into trustcargo.beneficial_owners (organization_id, full_name, ownership_bps, country) values
    ('01000000-0000-4000-8000-000000000001', 'Alice Seller', 10000, 'CA');

insert into trustcargo.identity_verifications (subject_type, subject_user_id, subject_organization_id, provider, provider_reference, status, simulated) values
    ('USER', 'b0000000-0000-4000-8000-00000000000b', null, 'sim-kyc', 'kyc-b-1', 'VERIFIED', true),
    ('ORGANIZATION', null, '01000000-0000-4000-8000-000000000001', 'sim-kyc', 'kyb-o1-1', 'VERIFIED', true);

insert into trustcargo.payment_accounts (id, owner_type, owner_user_id, holder_name, currency, country, bank_name, masked_identifier, provider_token, status, verified_at) values
    ('9a000000-0000-4000-8000-000000000001', 'USER', 'a0000000-0000-4000-8000-00000000000a', 'Alice Seller', 'CAD', 'CA', 'Banque Fictive', '•••• 4821', 'tok_sim_a_00000001', 'VERIFIED', now());

insert into trustcargo.session_events (user_id, country, device_fingerprint_hash, ip_hash) values
    ('b0000000-0000-4000-8000-00000000000b', 'SN', encode(sha256('device-b'::bytea), 'hex'), encode(sha256('ip-b'::bytea), 'hex'));

insert into trustcargo.corridors (id, code, origin_country, destination_country, enabled, allowed_currencies, review_threshold_minor, expected_discharge_ports, required_documents_before_funding) values
    ('c0441d00-0000-4000-8000-000000000001', 'CA-SN', 'CA', 'SN', true, array['CAD', 'USD', 'EUR', 'XOF'],
     '{"CAD": "5000000", "XOF": "2500000000"}', array['SNDKR'], array['INVOICE', 'TITLE']::trustcargo.document_type[]);

-- T1: A (org O1) sells to B, D inspects. T2: C (org O2) sells, buyer only invited. T3: A's DRAFT.
insert into trustcargo.transactions (id, reference, status, title, amount_minor, currency, corridor_id, seller_organization_id, created_by, current_contract_version_id, is_demo) values
    ('11111111-1111-4111-8111-111111111111', 'TCP-2026-0001', 'IN_PROGRESS', 'Toyota RAV4 2021', 1850000, 'CAD',
     'c0441d00-0000-4000-8000-000000000001', '01000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a',
     '1cc00000-0000-4000-8000-000000000001', true),
    ('22222222-2222-4222-8222-222222222222', 'TCP-2026-0002', 'AWAITING_PARTIES', 'Honda CR-V 2019', 1200000, 'CAD',
     'c0441d00-0000-4000-8000-000000000001', '02000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000c',
     '2cc00000-0000-4000-8000-000000000001', true),
    ('33333333-3333-4333-8333-333333333333', 'TCP-2026-0003', 'DRAFT', 'Lexus RX 2020', 2400000, 'CAD',
     'c0441d00-0000-4000-8000-000000000001', '01000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a',
     null, true);

insert into trustcargo.transaction_parties (id, transaction_id, role, user_id, organization_id, display_name, email, status, joined_at) values
    ('1e000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'SELLER', 'a0000000-0000-4000-8000-00000000000a', '01000000-0000-4000-8000-000000000001', 'Autos Laval', 'seller.a@example.test', 'JOINED', now()),
    ('1e000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'BUYER', 'b0000000-0000-4000-8000-00000000000b', null, 'Bamba Buyer', 'buyer.b@example.test', 'JOINED', now()),
    ('1e000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'INSPECTOR', 'd0000000-0000-4000-8000-00000000000d', null, 'Dan Inspector', 'inspector.d@example.test', 'JOINED', now()),
    ('2e000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'SELLER', 'c0000000-0000-4000-8000-00000000000c', '02000000-0000-4000-8000-000000000002', 'Other Motors', 'outsider.c@example.test', 'JOINED', now()),
    ('2e000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'BUYER', null, null, 'Invited Buyer', 'invited@example.test', 'INVITED', null),
    ('3e000000-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SELLER', 'a0000000-0000-4000-8000-00000000000a', '01000000-0000-4000-8000-000000000001', 'Autos Laval', 'seller.a@example.test', 'JOINED', now());

insert into trustcargo.vehicles (transaction_id, make, model, year, vin, mileage_km, declared_condition, origin_country, destination_country) values
    ('11111111-1111-4111-8111-111111111111', 'Toyota', 'RAV4', 2021, '2T3P1RFV8MW000001', 42000, 'GOOD', 'CA', 'SN'),
    ('22222222-2222-4222-8222-222222222222', 'Honda', 'CR-V', 2019, '2HKRW2H50KH000002', 81000, 'FAIR', 'CA', 'SN');

insert into trustcargo.contracts (id, transaction_id) values
    ('1c000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111'),
    ('2c000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222');

insert into trustcargo.contract_versions (id, contract_id, transaction_id, version_number, terms, content_hash, status, created_by) values
    ('1cc00000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 1,
     '{"goodsDescription": "Toyota RAV4"}', encode(sha256('terms-t1-v1'::bytea), 'hex'), 'ACCEPTED', 'a0000000-0000-4000-8000-00000000000a'),
    ('2cc00000-0000-4000-8000-000000000001', '2c000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 1,
     '{"goodsDescription": "Honda CR-V"}', encode(sha256('terms-t2-v1'::bytea), 'hex'), 'PROPOSED', 'c0000000-0000-4000-8000-00000000000c');

insert into trustcargo.contract_acceptances (transaction_id, contract_version_id, party_id, user_id, decision, content_hash) values
    ('11111111-1111-4111-8111-111111111111', '1cc00000-0000-4000-8000-000000000001', '1e000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', 'ACCEPTED', encode(sha256('terms-t1-v1'::bytea), 'hex')),
    ('11111111-1111-4111-8111-111111111111', '1cc00000-0000-4000-8000-000000000001', '1e000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000b', 'ACCEPTED', encode(sha256('terms-t1-v1'::bytea), 'hex'));

insert into trustcargo.milestones (id, transaction_id, contract_version_id, sequence, key, title, share_bps, amount_minor, currency, required_evidence, status) values
    ('1d000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '1cc00000-0000-4000-8000-000000000001', 1, 'inspection', 'Inspection', 3000, 555000, 'CAD', array['INSPECTION_REPORT']::trustcargo.document_type[], 'RELEASED'),
    ('1d000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '1cc00000-0000-4000-8000-000000000001', 2, 'delivery', 'Delivery', 7000, 1295000, 'CAD', array['BILL_OF_LADING']::trustcargo.document_type[], 'ACTIVE'),
    ('2d000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '2cc00000-0000-4000-8000-000000000001', 1, 'delivery', 'Delivery', 10000, 1200000, 'CAD', '{}', 'PENDING');

insert into trustcargo.documents (id, logical_id, version, transaction_id, owner_user_id, type, title, file_name, mime_type, size_bytes, sha256, storage_key, status, visible_to_roles) values
    -- doc1: invoice, SELLER + BUYER only
    ('10c00000-0000-4000-8000-000000000001', '10c10000-0000-4000-8000-000000000001', 1, '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-00000000000a',
     'INVOICE', 'Invoice', 'invoice.pdf', 'application/pdf', 1000, encode(sha256('doc1'::bytea), 'hex'),
     '11111111-1111-4111-8111-111111111111/10c10000-0000-4000-8000-000000000001/1-invoice.pdf', 'VERIFIED', array['SELLER', 'BUYER']),
    -- doc2: inspection report, visible to INSPECTOR too
    ('10c00000-0000-4000-8000-000000000002', '10c10000-0000-4000-8000-000000000002', 1, '11111111-1111-4111-8111-111111111111', 'd0000000-0000-4000-8000-00000000000d',
     'INSPECTION_REPORT', 'Inspection report', 'inspection.pdf', 'application/pdf', 2000, encode(sha256('doc2'::bytea), 'hex'),
     '11111111-1111-4111-8111-111111111111/10c10000-0000-4000-8000-000000000002/1-inspection.pdf', 'VERIFIED', array['SELLER', 'BUYER', 'INSPECTOR']),
    -- doc3: B's identity document (not linked to any transaction)
    ('10c00000-0000-4000-8000-000000000003', '10c10000-0000-4000-8000-000000000003', 1, null, 'b0000000-0000-4000-8000-00000000000b',
     'IDENTITY', 'Passport', 'passport.jpg', 'image/jpeg', 3000, encode(sha256('doc3'::bytea), 'hex'),
     'identity/b0000000-0000-4000-8000-00000000000b/passport.jpg', 'PENDING_REVIEW', '{}'),
    -- doc4: T2 bill of lading
    ('10c00000-0000-4000-8000-000000000004', '10c10000-0000-4000-8000-000000000004', 1, '22222222-2222-4222-8222-222222222222', 'c0000000-0000-4000-8000-00000000000c',
     'BILL_OF_LADING', 'B/L', 'bl.pdf', 'application/pdf', 4000, encode(sha256('doc4'::bytea), 'hex'),
     '22222222-2222-4222-8222-222222222222/10c10000-0000-4000-8000-000000000004/1-bl.pdf', 'PENDING_REVIEW', array['SELLER', 'BUYER']),
    -- doc5: T1 photo uploaded by B, visible to the SELLER only (still visible to B as owner)
    ('10c00000-0000-4000-8000-000000000005', '10c10000-0000-4000-8000-000000000005', 1, '11111111-1111-4111-8111-111111111111', 'b0000000-0000-4000-8000-00000000000b',
     'PHOTO', 'Photo', 'photo.png', 'image/png', 5000, encode(sha256('doc5'::bytea), 'hex'),
     '11111111-1111-4111-8111-111111111111/10c10000-0000-4000-8000-000000000005/1-photo.png', 'VERIFIED', array['SELLER']);

insert into storage.objects (bucket_id, name, owner)
select 'trustcargo-documents', storage_key, owner_user_id from trustcargo.documents where transaction_id is not null;

insert into trustcargo.milestone_evidence (milestone_id, transaction_id, document_id, added_by) values
    ('1d000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '10c00000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-00000000000d');

insert into trustcargo.document_verifications (document_id, reviewer_id, decision, notes) values
    ('10c00000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000e', 'VERIFIED', 'ok');

insert into trustcargo.risk_alerts (id, rule_id, category, severity, transaction_id, fingerprint, reasons, recommended_action, blocks_funds_movement) values
    ('7a000000-0000-4000-8000-000000000001', 'TX_AMOUNT_ABOVE_THRESHOLD', 'TRANSACTION', 'HIGH', '11111111-1111-4111-8111-111111111111',
     'TX_AMOUNT_ABOVE_THRESHOLD:11111111-1111-4111-8111-111111111111', '[{"code": "amount_above_threshold", "params": {}}]', 'ENHANCED_REVIEW', false);
insert into trustcargo.risk_reviews (alert_id, reviewer_id, decision, notes) values
    ('7a000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000e', 'FALSE_POSITIVE', 'Known dealer');
insert into trustcargo.screening_results (subject_type, subject_user_id, provider, provider_reference, result) values
    ('USER', 'b0000000-0000-4000-8000-00000000000b', 'sim-screening', 'scr-b-1', 'NO_MATCH');

insert into trustcargo.disputes (id, transaction_id, opened_by, opened_by_role, reason, description, requested_outcome, status, response_due_at) values
    ('d1500000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'b0000000-0000-4000-8000-00000000000b', 'BUYER',
     'CONTRACTUAL_DELAY', 'Shipping is late', 'Resume with new date', 'UNDER_REVIEW', now() + interval '5 days');
insert into trustcargo.dispute_messages (dispute_id, transaction_id, author_id, author_role, body) values
    ('d1500000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'b0000000-0000-4000-8000-00000000000b', 'BUYER', 'Any update?');

insert into trustcargo.compliance_holds (transaction_id, type, reference, placed_by) values
    ('11111111-1111-4111-8111-111111111111', 'SANCTIONS_REVIEW', 'CH-1', 'e0000000-0000-4000-8000-00000000000e');

insert into trustcargo.payment_instructions (id, transaction_id, provider, provider_reference, amount_minor, currency, payer_user_id, status, details, idempotency_key, expires_at) values
    ('9b000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'sim', 'SIM-PI-0001', 1850000, 'CAD', 'b0000000-0000-4000-8000-00000000000b', 'FUNDED',
     '{"method": "BANK_TRANSFER", "beneficiaryName": "Partner escrow (simulation)", "bankName": "Banque Fictive", "accountMasked": "•••• 0001", "paymentReference": "TCP-2026-0001", "notes": "SIMULATION"}',
     'pi:TCP-2026-0001', now() + interval '7 days');

insert into trustcargo.payouts (transaction_id, milestone_id, payee_party_id, payment_account_id, amount_minor, currency, status, provider, idempotency_key, requested_by) values
    ('11111111-1111-4111-8111-111111111111', '1d000000-0000-4000-8000-000000000001', '1e000000-0000-4000-8000-000000000001', '9a000000-0000-4000-8000-000000000001',
     555000, 'CAD', 'REQUESTED', 'sim', 'payout:1d000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-00000000000f');

insert into trustcargo.refunds (transaction_id, payer_party_id, amount_minor, currency, status, provider, idempotency_key, requested_by) values
    ('11111111-1111-4111-8111-111111111111', '1e000000-0000-4000-8000-000000000002', 1000, 'CAD', 'REQUESTED', 'sim', 'refund:test-1', 'f0000000-0000-4000-8000-00000000000f');

insert into trustcargo.provider_connections (provider, display_name, environment, status, capabilities, webhook_secret_ref, regulatory_status_note) values
    ('sim', 'Simulated partner', 'SIMULATION', 'ACTIVE', array['payments', 'payouts', 'refunds'], 'PARTNER_SIM_WEBHOOK_SECRET', 'Simulation only — no real funds.');

insert into trustcargo.provider_events (id, provider, external_event_id, type, payload, signature_verified, status, transaction_id, occurred_at, processed_at) values
    ('9e000000-0000-4000-8000-000000000001', 'sim', 'evt_0001', 'funds.confirmed', '{"amountMinor": "1850000", "currency": "CAD"}', true, 'PROCESSED',
     '11111111-1111-4111-8111-111111111111', now(), now());

insert into trustcargo.notifications (user_id, type, transaction_id) values
    ('b0000000-0000-4000-8000-00000000000b', 'transaction.funds_confirmed', '11111111-1111-4111-8111-111111111111'),
    ('c0000000-0000-4000-8000-00000000000c', 'transaction.invitations_sent', '22222222-2222-4222-8222-222222222222');

-- Audit chain: genesis (no transaction), a T1 transaction event, an internal T1 risk event.
insert into trustcargo.audit_events (sequence, actor_type, actor_id, action, entity_type, entity_id, previous_hash, hash) values
    (1, 'SYSTEM', 'system', 'system.seeded', 'system', 'seed', repeat('0', 64), encode(sha256('e1'::bytea), 'hex'));
insert into trustcargo.audit_events (sequence, actor_type, actor_id, action, entity_type, entity_id, transaction_id, previous_hash, hash) values
    (2, 'USER', 'a0000000-0000-4000-8000-00000000000a', 'transaction.invitations_sent', 'transaction', '11111111-1111-4111-8111-111111111111',
     '11111111-1111-4111-8111-111111111111', encode(sha256('e1'::bytea), 'hex'), encode(sha256('e2'::bytea), 'hex'));
insert into trustcargo.audit_events (sequence, actor_type, actor_id, action, entity_type, entity_id, transaction_id, previous_hash, hash) values
    (3, 'SYSTEM', 'system', 'risk.alert_raised', 'risk_alert', '7a000000-0000-4000-8000-000000000001',
     '11111111-1111-4111-8111-111111111111', encode(sha256('e2'::bytea), 'hex'), encode(sha256('e3'::bytea), 'hex'));

-- Ledger: funds reported received for T1 (accounts opened on first use).
select tst.ok('seed journal posted', trustcargo.post_ledger_journal(
    'funds:sim:SIM-PI-0001', 'FUNDS_REPORTED_RECEIVED', '11111111-1111-4111-8111-111111111111', 'SIM-PI-0001',
    'Partner reported buyer funds received',
    '[{"account_code": "PARTNER_CLEARING:sim:CAD", "account_type": "ASSET", "account_name": "Partner clearing (sim, CAD)",
       "direction": "DEBIT", "amount_minor": "1850000", "currency": "CAD"},
      {"account_code": "TX_HELD:11111111-1111-4111-8111-111111111111:CAD", "account_type": "LIABILITY",
       "account_transaction_id": "11111111-1111-4111-8111-111111111111",
       "direction": "CREDIT", "amount_minor": 1850000, "currency": "CAD"}]'::jsonb,
    'test', null, '9e000000-0000-4000-8000-000000000001') is not null);

insert into trustcargo.ledger_accounts (code, name, type, currency) values
    ('PARTNER_CLEARING:sim:USD', 'Partner clearing (sim, USD)', 'ASSET', 'USD');

insert into trustcargo.reconciliations (id, provider, run_by, status) values
    ('9f000000-0000-4000-8000-000000000001', 'sim', 'f0000000-0000-4000-8000-00000000000f', 'MATCHED');
insert into trustcargo.reconciliation_items (reconciliation_id, ordinal, external_reference, kind, provider_amount_minor, ledger_amount_minor, currency, result) values
    ('9f000000-0000-4000-8000-000000000001', 0, 'SIM-PI-0001', 'FUNDS', 1850000, 1850000, 'CAD', 'MATCHED');

commit;

-- =====================================================================================================
\echo '== anon'
begin;
set local role anon;
select tst.denied('anon cannot read transactions', 'select * from trustcargo.transactions');
select tst.denied('anon cannot read users', 'select * from trustcargo.users');
select tst.denied('anon cannot call post_ledger_journal',
    $q$select trustcargo.post_ledger_journal('x', 'REVERSAL', null, null, 'x', '[]'::jsonb)$q$);
rollback;

-- =====================================================================================================
\echo '== outsider C'
begin;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
set local role authenticated;
select tst.eq('C cannot see T1', tst.cnt($q$select 1 from trustcargo.transactions where id = '11111111-1111-4111-8111-111111111111'$q$), 0);
select tst.eq('C sees own T2', tst.cnt($q$select 1 from trustcargo.transactions where id = '22222222-2222-4222-8222-222222222222'$q$), 1);
select tst.eq('C sees exactly one transaction', tst.cnt('select 1 from trustcargo.transactions'), 1);
select tst.eq('C cannot see T1 parties', tst.cnt($q$select 1 from trustcargo.transaction_parties where transaction_id = '11111111-1111-4111-8111-111111111111'$q$), 0);
select tst.eq('C cannot see T1 milestones', tst.cnt($q$select 1 from trustcargo.milestones where transaction_id = '11111111-1111-4111-8111-111111111111'$q$), 0);
select tst.eq('C cannot see T1 vehicle', tst.cnt($q$select 1 from trustcargo.vehicles where transaction_id = '11111111-1111-4111-8111-111111111111'$q$), 0);
select tst.eq('C cannot see T1 contract versions', tst.cnt($q$select 1 from trustcargo.contract_versions where transaction_id = '11111111-1111-4111-8111-111111111111'$q$), 0);
select tst.eq('C cannot see T1 documents', tst.cnt($q$select 1 from trustcargo.documents where transaction_id = '11111111-1111-4111-8111-111111111111'$q$), 0);
select tst.eq('C sees own T2 document', tst.cnt($q$select 1 from trustcargo.documents where transaction_id = '22222222-2222-4222-8222-222222222222'$q$), 1);
select tst.eq('C cannot see T1 storage objects', tst.cnt($q$select 1 from storage.objects where name like '11111111-1111-4111-8111-111111111111/%'$q$), 0);
select tst.eq('C cannot see payment instructions', tst.cnt('select 1 from trustcargo.payment_instructions'), 0);
select tst.eq('C cannot see T1 disputes', tst.cnt('select 1 from trustcargo.disputes'), 0);
select tst.eq('C cannot see T1 audit events', tst.cnt('select 1 from trustcargo.audit_events'), 0);
select tst.eq('C cannot see org O1', tst.cnt($q$select 1 from trustcargo.organizations where id = '01000000-0000-4000-8000-000000000001'$q$), 0);
select tst.eq('C sees own org O2', tst.cnt($q$select 1 from trustcargo.organizations where id = '02000000-0000-4000-8000-000000000002'$q$), 1);
select tst.eq('C cannot see O1 members', tst.cnt($q$select 1 from trustcargo.organization_members where organization_id = '01000000-0000-4000-8000-000000000001'$q$), 0);
select tst.eq('C cannot see O1 beneficial owners', tst.cnt('select 1 from trustcargo.beneficial_owners'), 0);
select tst.eq('C cannot see identity verifications of others', tst.cnt('select 1 from trustcargo.identity_verifications'), 0);
select tst.eq('C sees only own user row', tst.cnt('select 1 from trustcargo.users'), 1);
select tst.eq('C sees only own notifications', tst.cnt('select 1 from trustcargo.notifications'), 1);
select tst.ok('C has no party role in T1', trustcargo_private.party_role('11111111-1111-4111-8111-111111111111') is null);
select tst.denied('C cannot upload into T1 folder',
    $q$insert into storage.objects (bucket_id, name, owner) values ('trustcargo-documents', '11111111-1111-4111-8111-111111111111/x/evil.pdf', 'c0000000-0000-4000-8000-00000000000c')$q$);
select tst.eq('C cannot update T1', tst.affected($q$update trustcargo.transactions set title = 'pwned' where id = '11111111-1111-4111-8111-111111111111'$q$), 0);
rollback;

-- =====================================================================================================
\echo '== buyer B'
begin;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
select tst.eq('B sees T1', tst.cnt($q$select 1 from trustcargo.transactions where id = '11111111-1111-4111-8111-111111111111'$q$), 1);
select tst.eq('B cannot see T2', tst.cnt($q$select 1 from trustcargo.transactions where id = '22222222-2222-4222-8222-222222222222'$q$), 0);
select tst.eq('B cannot see T3', tst.cnt($q$select 1 from trustcargo.transactions where id = '33333333-3333-4333-8333-333333333333'$q$), 0);
select tst.eq('B sees T1 parties', tst.cnt($q$select 1 from trustcargo.transaction_parties where transaction_id = '11111111-1111-4111-8111-111111111111'$q$), 3);
select tst.eq('B sees T1 milestones', tst.cnt($q$select 1 from trustcargo.milestones where transaction_id = '11111111-1111-4111-8111-111111111111'$q$), 2);
select tst.eq('B sees T1 acceptances', tst.cnt('select 1 from trustcargo.contract_acceptances'), 2);
select tst.eq('B sees T1 documents (invoice, inspection, own photo)', tst.cnt($q$select 1 from trustcargo.documents where transaction_id = '11111111-1111-4111-8111-111111111111'$q$), 3);
select tst.eq('B sees own identity document', tst.cnt($q$select 1 from trustcargo.documents where type = 'IDENTITY'$q$), 1);
select tst.eq('B cannot see T2 documents', tst.cnt($q$select 1 from trustcargo.documents where transaction_id = '22222222-2222-4222-8222-222222222222'$q$), 0);
select tst.eq('B cannot read TrustCargo storage objects directly (server-only bucket)', tst.cnt($q$select 1 from storage.objects where bucket_id = 'trustcargo-documents'$q$), 0);
select tst.eq('B sees T1 payment instruction', tst.cnt('select 1 from trustcargo.payment_instructions'), 1);
select tst.eq('B sees T1 payouts', tst.cnt('select 1 from trustcargo.payouts'), 1);
select tst.eq('B sees T1 refunds', tst.cnt('select 1 from trustcargo.refunds'), 1);
select tst.eq('B sees T1 dispute', tst.cnt('select 1 from trustcargo.disputes'), 1);
select tst.eq('B sees T1 dispute messages', tst.cnt('select 1 from trustcargo.dispute_messages'), 1);
select tst.eq('B cannot see risk alerts', tst.cnt('select 1 from trustcargo.risk_alerts'), 0);
select tst.eq('B cannot see risk reviews', tst.cnt('select 1 from trustcargo.risk_reviews'), 0);
select tst.eq('B cannot see screening results', tst.cnt('select 1 from trustcargo.screening_results'), 0);
select tst.eq('B cannot see compliance holds', tst.cnt('select 1 from trustcargo.compliance_holds'), 0);
select tst.eq('B cannot see ledger journals', tst.cnt('select 1 from trustcargo.ledger_journals'), 0);
select tst.eq('B cannot see ledger entries', tst.cnt('select 1 from trustcargo.ledger_entries'), 0);
select tst.eq('B cannot see ledger balances', tst.cnt('select 1 from trustcargo.ledger_account_balances'), 0);
select tst.eq('B cannot see provider events', tst.cnt('select 1 from trustcargo.provider_events'), 0);
select tst.eq('B cannot see provider connections', tst.cnt('select 1 from trustcargo.provider_connections'), 0);
select tst.eq('B cannot see reconciliations', tst.cnt('select 1 from trustcargo.reconciliations'), 0);
select tst.eq('B sees only the T1 non-internal audit event', tst.cnt('select 1 from trustcargo.audit_events'), 1);
select tst.eq('B sees own identity verification only', tst.cnt('select 1 from trustcargo.identity_verifications'), 1);
select tst.eq('B cannot see A payment account', tst.cnt('select 1 from trustcargo.payment_accounts'), 0);
select tst.eq('B sees only own user row', tst.cnt('select 1 from trustcargo.users'), 1);
select tst.eq('B sees corridors', tst.cnt('select 1 from trustcargo.corridors'), 1);
select tst.eq('B cannot see security settings', tst.cnt('select 1 from trustcargo.security_settings'), 0);
select tst.ok('B party_role(T1) = BUYER', trustcargo_private.party_role('11111111-1111-4111-8111-111111111111') = 'BUYER');
-- Writes that must be refused.
select tst.denied('B cannot insert payment instruction',
    $q$insert into trustcargo.payment_instructions (transaction_id, provider, provider_reference, amount_minor, currency, payer_user_id, details, idempotency_key, expires_at)
       values ('11111111-1111-4111-8111-111111111111', 'sim', 'X', 1, 'CAD', 'b0000000-0000-4000-8000-00000000000b', '{"method":"BANK_TRANSFER"}', 'k', now())$q$);
select tst.denied('B cannot insert ledger entries',
    $q$insert into trustcargo.ledger_entries (journal_id, account_id, direction, amount_minor, currency)
       select j.id, a.id, 'DEBIT', 1, 'CAD' from trustcargo.ledger_journals j, trustcargo.ledger_accounts a limit 1$q$);
select tst.denied('B cannot insert ledger journals',
    $q$insert into trustcargo.ledger_journals (idempotency_key, kind, description, posted_by) values ('x', 'PAYOUT_SETTLED', 'x', 'b')$q$);
select tst.denied('B cannot insert provider events',
    $q$insert into trustcargo.provider_events (provider, external_event_id, type, payload, signature_verified, occurred_at)
       values ('sim', 'evt_forged', 'funds.confirmed', '{}', true, now())$q$);
select tst.denied('B cannot insert audit events',
    $q$insert into trustcargo.audit_events (sequence, actor_type, action, entity_type, entity_id, previous_hash, hash) values (4, 'SYSTEM', 'x', 'x', 'x', encode(sha256('e3'::bytea), 'hex'), repeat('1', 64))$q$);
select tst.denied('B cannot read the counters', 'select * from trustcargo_private.counters');
select tst.denied('B cannot read demo TOTP secrets', 'select * from trustcargo_private.demo_mfa_secrets');
select tst.denied('B cannot insert risk alerts',
    $q$insert into trustcargo.risk_alerts (rule_id, category, severity, subject_user_id, fingerprint, recommended_action) values ('r', 'USER', 'LOW', 'b0000000-0000-4000-8000-00000000000b', 'f', 'x')$q$);
select tst.denied('B cannot change transaction status',
    $q$update trustcargo.transactions set status = 'COMPLETED' where id = '11111111-1111-4111-8111-111111111111'$q$);
select tst.denied('B cannot change transaction amount',
    $q$update trustcargo.transactions set amount_minor = 1 where id = '11111111-1111-4111-8111-111111111111'$q$);
select tst.denied('B cannot update payouts',
    $q$update trustcargo.payouts set status = 'PAID'$q$);
select tst.denied('B cannot update payment instructions',
    $q$update trustcargo.payment_instructions set status = 'FUNDED'$q$);
select tst.denied('B cannot delete documents', $q$delete from trustcargo.documents$q$);
select tst.denied('B cannot call post_ledger_journal',
    $q$select trustcargo.post_ledger_journal('x', 'REVERSAL', null, null, 'x', '[]'::jsonb)$q$);
select tst.denied('B cannot self-verify KYC',
    $q$update trustcargo.users set kyc_status = 'VERIFIED' where id = 'b0000000-0000-4000-8000-00000000000b'$q$);
select tst.denied('B cannot grant himself a platform role',
    $q$insert into trustcargo.user_platform_roles (user_id, role) values ('b0000000-0000-4000-8000-00000000000b', 'finance_operator')$q$);
select tst.denied('B cannot write corridors (not platform_admin)',
    $q$insert into trustcargo.corridors (code, origin_country, destination_country) values ('CA-FR', 'CA', 'FR')$q$);
select tst.eq('B can update own profile', tst.affected($q$update trustcargo.users set full_name = 'Bamba B.' where id = 'b0000000-0000-4000-8000-00000000000b'$q$), 1);
select tst.eq('B cannot update A profile', tst.affected($q$update trustcargo.users set full_name = 'x' where id = 'a0000000-0000-4000-8000-00000000000a'$q$), 0);
select tst.eq('B can mark own notification read', tst.affected('update trustcargo.notifications set read_at = now()'), 1);
select tst.denied('B cannot re-target a notification',
    $q$update trustcargo.notifications set user_id = 'c0000000-0000-4000-8000-00000000000c'$q$);
select tst.eq('B (not creator) cannot rename T1', tst.affected($q$update trustcargo.transactions set title = 'x' where id = '11111111-1111-4111-8111-111111111111'$q$), 0);
select tst.denied('B cannot upload directly, even into a T1 folder (server-only bucket)',
    $q$insert into storage.objects (bucket_id, name, owner) values ('trustcargo-documents', '11111111-1111-4111-8111-111111111111/new/1-proof.pdf', 'b0000000-0000-4000-8000-00000000000b')$q$);
select tst.denied('B cannot upload as somebody else',
    $q$insert into storage.objects (bucket_id, name, owner) values ('trustcargo-documents', '11111111-1111-4111-8111-111111111111/new/2-proof.pdf', 'a0000000-0000-4000-8000-00000000000a')$q$);
select tst.denied('B cannot upload outside a transaction folder',
    $q$insert into storage.objects (bucket_id, name, owner) values ('trustcargo-documents', 'not-a-uuid/proof.pdf', 'b0000000-0000-4000-8000-00000000000b')$q$);
rollback;

-- =====================================================================================================
\echo '== inspector D'
begin;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
set local role authenticated;
select tst.eq('D sees T1', tst.cnt($q$select 1 from trustcargo.transactions where id = '11111111-1111-4111-8111-111111111111'$q$), 1);
select tst.eq('D sees T1 vehicle', tst.cnt($q$select 1 from trustcargo.vehicles where transaction_id = '11111111-1111-4111-8111-111111111111'$q$), 1);
select tst.eq('D sees T1 milestones', tst.cnt('select 1 from trustcargo.milestones'), 2);
select tst.eq('D cannot see payment instructions', tst.cnt('select 1 from trustcargo.payment_instructions'), 0);
select tst.eq('D cannot see payouts', tst.cnt('select 1 from trustcargo.payouts'), 0);
select tst.eq('D cannot see refunds', tst.cnt('select 1 from trustcargo.refunds'), 0);
select tst.eq('D cannot see disputes', tst.cnt('select 1 from trustcargo.disputes'), 0);
select tst.eq('D cannot see dispute messages', tst.cnt('select 1 from trustcargo.dispute_messages'), 0);
select tst.eq('D sees only documents visible to INSPECTOR', tst.cnt('select 1 from trustcargo.documents'), 1);
select tst.eq('D cannot see the invoice (SELLER/BUYER only)', tst.cnt($q$select 1 from trustcargo.documents where type = 'INVOICE'$q$), 0);
select tst.eq('D cannot read storage objects directly (server-only bucket)', tst.cnt('select 1 from storage.objects'), 0);
select tst.eq('D cannot see risk alerts', tst.cnt('select 1 from trustcargo.risk_alerts'), 0);
select tst.ok('D party_role(T1) = INSPECTOR', trustcargo_private.party_role('11111111-1111-4111-8111-111111111111') = 'INSPECTOR');
rollback;

-- =====================================================================================================
\echo '== seller A and org colleague A2'
begin;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select tst.eq('A sees T1 and T3', tst.cnt('select 1 from trustcargo.transactions'), 2);
select tst.eq('A sees invoice, inspection report, photo (SELLER)', tst.cnt($q$select 1 from trustcargo.documents where transaction_id = '11111111-1111-4111-8111-111111111111'$q$), 3);
select tst.eq('A cannot see B identity document', tst.cnt($q$select 1 from trustcargo.documents where type = 'IDENTITY'$q$), 0);
select tst.eq('A cannot see B identity verification', tst.cnt('select 1 from trustcargo.identity_verifications where subject_user_id is not null'), 0);
select tst.eq('A sees own payment account', tst.cnt('select 1 from trustcargo.payment_accounts'), 1);
select tst.eq('A cannot rename a non-DRAFT transaction', tst.affected($q$update trustcargo.transactions set title = 'x' where id = '11111111-1111-4111-8111-111111111111'$q$), 0);
select tst.eq('A can rename own DRAFT', tst.affected($q$update trustcargo.transactions set title = 'Lexus RX 2020 (blue)' where id = '33333333-3333-4333-8333-333333333333'$q$), 1);
select tst.denied('A cannot move own DRAFT forward',
    $q$update trustcargo.transactions set status = 'AWAITING_PARTIES' where id = '33333333-3333-4333-8333-333333333333'$q$);
rollback;

begin;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select tst.eq('A2 (member of seller org) sees T1', tst.cnt($q$select 1 from trustcargo.transactions where id = '11111111-1111-4111-8111-111111111111'$q$), 1);
select tst.ok('A2 party_role(T1) = SELLER via organization', trustcargo_private.party_role('11111111-1111-4111-8111-111111111111') = 'SELLER');
select tst.eq('A2 sees T1 payment instruction', tst.cnt('select 1 from trustcargo.payment_instructions'), 1);
select tst.eq('A2 sees own org', tst.cnt('select 1 from trustcargo.organizations'), 1);
select tst.eq('A2 sees org KYB', tst.cnt('select 1 from trustcargo.identity_verifications'), 1);
select tst.eq('A2 sees org payment-less view (A personal account hidden)', tst.cnt('select 1 from trustcargo.payment_accounts'), 0);
select tst.eq('A2 cannot see T2', tst.cnt($q$select 1 from trustcargo.transactions where id = '22222222-2222-4222-8222-222222222222'$q$), 0);
rollback;

-- =====================================================================================================
\echo '== compliance analyst E'
begin;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-8000-00000000000e","role":"authenticated"}', true);
set local role authenticated;
select tst.eq('E sees risk alerts', tst.cnt('select 1 from trustcargo.risk_alerts'), 1);
select tst.eq('E sees risk reviews', tst.cnt('select 1 from trustcargo.risk_reviews'), 1);
select tst.eq('E sees compliance holds', tst.cnt('select 1 from trustcargo.compliance_holds'), 1);
select tst.eq('E sees all transactions', tst.cnt('select 1 from trustcargo.transactions'), 3);
select tst.eq('E sees all documents incl. identity', tst.cnt('select 1 from trustcargo.documents'), 5);
select tst.eq('E sees all users', tst.cnt('select 1 from trustcargo.users'), 7);
select tst.eq('E sees all identity verifications', tst.cnt('select 1 from trustcargo.identity_verifications'), 2);
select tst.eq('E sees all audit events', tst.cnt('select 1 from trustcargo.audit_events'), 3);
select tst.eq('E cannot see ledger journals', tst.cnt('select 1 from trustcargo.ledger_journals'), 0);
select tst.eq('E cannot see provider events', tst.cnt('select 1 from trustcargo.provider_events'), 0);
select tst.denied('E cannot update risk alerts directly', $q$update trustcargo.risk_alerts set status = 'RESOLVED'$q$);
rollback;

-- =====================================================================================================
\echo '== finance operator F'
begin;
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-00000000000f","role":"authenticated"}', true);
set local role authenticated;
select tst.eq('F sees ledger journals', tst.cnt('select 1 from trustcargo.ledger_journals'), 1);
select tst.eq('F sees ledger entries', tst.cnt('select 1 from trustcargo.ledger_entries'), 2);
select tst.eq('F sees ledger accounts', tst.cnt('select 1 from trustcargo.ledger_accounts'), 3);
select tst.eq('F sees TX_HELD balance', tst.cnt($q$select 1 from trustcargo.ledger_account_balances where code like 'TX_HELD:%' and balance_minor = 1850000$q$), 1);
select tst.eq('F sees provider events', tst.cnt('select 1 from trustcargo.provider_events'), 1);
select tst.eq('F sees provider connections', tst.cnt('select 1 from trustcargo.provider_connections'), 1);
select tst.eq('F sees reconciliation items', tst.cnt('select 1 from trustcargo.reconciliation_items'), 1);
select tst.eq('F cannot see risk alerts', tst.cnt('select 1 from trustcargo.risk_alerts'), 0);
select tst.eq('F cannot see documents', tst.cnt('select 1 from trustcargo.documents'), 0);
select tst.eq('F cannot see identity verifications', tst.cnt('select 1 from trustcargo.identity_verifications'), 0);
select tst.denied('F cannot insert ledger entries',
    $q$insert into trustcargo.ledger_entries (journal_id, account_id, direction, amount_minor, currency)
       select j.id, a.id, 'DEBIT', 1, 'CAD' from trustcargo.ledger_journals j, trustcargo.ledger_accounts a limit 1$q$);
select tst.denied('F cannot call post_ledger_journal',
    $q$select trustcargo.post_ledger_journal('x', 'REVERSAL', null, null, 'x', '[]'::jsonb)$q$);
rollback;

-- =====================================================================================================
\echo '== ledger integrity (service_role)'
begin;
set local role service_role;

-- Idempotency.
select tst.ok('post_ledger_journal is idempotent',
    trustcargo.post_ledger_journal('funds:sim:SIM-PI-0001', 'FUNDS_REPORTED_RECEIVED', '11111111-1111-4111-8111-111111111111', 'SIM-PI-0001', 'dup',
        '[{"account_code": "PARTNER_CLEARING:sim:CAD", "direction": "DEBIT", "amount_minor": "1850000", "currency": "CAD"},
          {"account_code": "TX_HELD:11111111-1111-4111-8111-111111111111:CAD", "direction": "CREDIT", "amount_minor": "1850000", "currency": "CAD"}]')
    = (select id from trustcargo.ledger_journals where idempotency_key = 'funds:sim:SIM-PI-0001'));
select tst.eq('idempotent replay created no journal', (select count(*) from trustcargo.ledger_journals), 1);
select tst.eq('idempotent replay created no entries', (select count(*) from trustcargo.ledger_entries), 2);
select tst.fails('idempotency key reused with another kind',
    $q$select trustcargo.post_ledger_journal('funds:sim:SIM-PI-0001', 'PAYOUT_SETTLED', '11111111-1111-4111-8111-111111111111', null, 'x',
        '[{"account_code": "PARTNER_CLEARING:sim:CAD", "direction": "DEBIT", "amount_minor": "1", "currency": "CAD"},
          {"account_code": "PARTNER_CLEARING:sim:CAD", "direction": "CREDIT", "amount_minor": "1", "currency": "CAD"}]')$q$, '22023');

-- Validation inside post_ledger_journal.
select tst.fails('unbalanced journal rejected by post_ledger_journal',
    $q$select trustcargo.post_ledger_journal('test:unbalanced-fn', 'RELEASE_AUTHORIZED', '11111111-1111-4111-8111-111111111111', null, 'x',
        '[{"account_code": "TX_HELD:11111111-1111-4111-8111-111111111111:CAD", "direction": "DEBIT", "amount_minor": "100", "currency": "CAD"},
          {"account_code": "PARTNER_CLEARING:sim:CAD", "direction": "CREDIT", "amount_minor": "90", "currency": "CAD"}]')$q$, '23514');
select tst.fails('single-entry journal rejected',
    $q$select trustcargo.post_ledger_journal('test:single', 'RELEASE_AUTHORIZED', null, null, 'x',
        '[{"account_code": "PARTNER_CLEARING:sim:CAD", "direction": "DEBIT", "amount_minor": "100", "currency": "CAD"}]')$q$, '22023');
select tst.fails('fractional amount rejected',
    $q$select trustcargo.post_ledger_journal('test:float', 'RELEASE_AUTHORIZED', null, null, 'x',
        '[{"account_code": "PARTNER_CLEARING:sim:CAD", "direction": "DEBIT", "amount_minor": 1.5, "currency": "CAD"},
          {"account_code": "PARTNER_CLEARING:sim:CAD", "direction": "CREDIT", "amount_minor": 1.5, "currency": "CAD"}]')$q$, '22023');
select tst.fails('currency mismatch with account rejected (function)',
    $q$select trustcargo.post_ledger_journal('test:ccy', 'RELEASE_AUTHORIZED', null, null, 'x',
        '[{"account_code": "PARTNER_CLEARING:sim:USD", "direction": "DEBIT", "amount_minor": "100", "currency": "CAD"},
          {"account_code": "PARTNER_CLEARING:sim:CAD", "direction": "CREDIT", "amount_minor": "100", "currency": "CAD"}]')$q$, '23514');
select tst.fails('unknown account rejected',
    $q$select trustcargo.post_ledger_journal('test:unknown', 'RELEASE_AUTHORIZED', null, null, 'x',
        '[{"account_code": "NOPE", "direction": "DEBIT", "amount_minor": "100", "currency": "CAD"},
          {"account_code": "PARTNER_CLEARING:sim:CAD", "direction": "CREDIT", "amount_minor": "100", "currency": "CAD"}]')$q$, '23503');

-- Currency mismatch on direct insert.
select tst.fails('entry currency must equal account currency',
    $q$insert into trustcargo.ledger_entries (journal_id, account_id, direction, amount_minor, currency)
       select j.id, a.id, 'DEBIT', 100, 'CAD' from trustcargo.ledger_journals j, trustcargo.ledger_accounts a
       where a.code = 'PARTNER_CLEARING:sim:USD' limit 1$q$, '23514');
select tst.fails('non-positive entry amount rejected',
    $q$insert into trustcargo.ledger_entries (journal_id, account_id, direction, amount_minor, currency)
       select j.id, a.id, 'DEBIT', 0, 'CAD' from trustcargo.ledger_journals j, trustcargo.ledger_accounts a
       where a.code = 'PARTNER_CLEARING:sim:CAD' limit 1$q$, '23514');

-- Append-only.
select tst.fails('UPDATE ledger_entries forbidden', 'update trustcargo.ledger_entries set amount_minor = amount_minor + 1', '42501');
select tst.fails('DELETE ledger_entries forbidden', 'delete from trustcargo.ledger_entries', '42501');
select tst.fails('TRUNCATE ledger_entries forbidden', 'truncate trustcargo.ledger_entries', '42501');
select tst.fails('UPDATE ledger_journals forbidden', $q$update trustcargo.ledger_journals set description = 'edited'$q$, '42501');
select tst.fails('DELETE ledger_journals forbidden', 'delete from trustcargo.ledger_journals', '42501');
select tst.fails('ledger account currency immutable', $q$update trustcargo.ledger_accounts set currency = 'USD' where code = 'PARTNER_CLEARING:sim:CAD'$q$, '42501');

-- Reversal rules.
select tst.ok('reversal journal can be posted', trustcargo.post_ledger_journal(
    'reversal:seed', 'REVERSAL', '11111111-1111-4111-8111-111111111111', 'SIM-PI-0001', 'Reversal of seed',
    '[{"account_code": "PARTNER_CLEARING:sim:CAD", "direction": "CREDIT", "amount_minor": "1850000", "currency": "CAD"},
      {"account_code": "TX_HELD:11111111-1111-4111-8111-111111111111:CAD", "direction": "DEBIT", "amount_minor": "1850000", "currency": "CAD"}]',
    'test', (select id from trustcargo.ledger_journals where idempotency_key = 'funds:sim:SIM-PI-0001')) is not null);
select tst.fails('a journal can only be reversed once',
    $q$select trustcargo.post_ledger_journal('reversal:seed-2', 'REVERSAL', '11111111-1111-4111-8111-111111111111', null, 'again',
        '[{"account_code": "PARTNER_CLEARING:sim:CAD", "direction": "CREDIT", "amount_minor": "1", "currency": "CAD"},
          {"account_code": "PARTNER_CLEARING:sim:CAD", "direction": "DEBIT", "amount_minor": "1", "currency": "CAD"}]',
        'test', (select id from trustcargo.ledger_journals where idempotency_key = 'funds:sim:SIM-PI-0001'))$q$, '23505');
select tst.fails('a reversal cannot be reversed',
    $q$select trustcargo.post_ledger_journal('reversal:of-reversal', 'REVERSAL', '11111111-1111-4111-8111-111111111111', null, 'x',
        '[{"account_code": "PARTNER_CLEARING:sim:CAD", "direction": "CREDIT", "amount_minor": "1", "currency": "CAD"},
          {"account_code": "PARTNER_CLEARING:sim:CAD", "direction": "DEBIT", "amount_minor": "1", "currency": "CAD"}]',
        'test', (select id from trustcargo.ledger_journals where idempotency_key = 'reversal:seed'))$q$, '23514');

-- Deferred balance trigger, forced to fire now (the commit-time variant is tested below).
select tst.fails('unbalanced direct insert caught by deferred trigger',
    $q$
    with j as (
        insert into trustcargo.ledger_journals (idempotency_key, kind, description, posted_by)
        values ('test:direct-unbalanced', 'RELEASE_AUTHORIZED', 'x', 'test') returning id)
    insert into trustcargo.ledger_entries (journal_id, account_id, direction, amount_minor, currency)
    select j.id, a.id, d.direction, d.amount, 'CAD'
    from j, trustcargo.ledger_accounts a,
         (values ('DEBIT', 100::bigint, 'PARTNER_CLEARING:sim:CAD'),
                 ('CREDIT', 90::bigint, 'TX_HELD:11111111-1111-4111-8111-111111111111:CAD')) as d (direction, amount, code)
    where a.code = d.code;
    set constraints all immediate;
    $q$, '23514');
select tst.fails('journal without entries caught by deferred trigger',
    $q$
    insert into trustcargo.ledger_journals (idempotency_key, kind, description, posted_by)
    values ('test:empty', 'RELEASE_AUTHORIZED', 'x', 'test');
    set constraints all immediate;
    $q$, '23514');
rollback;

\echo '== unbalanced journal fails at COMMIT (an ERROR printed below is expected)'
\set ON_ERROR_STOP off
begin;
set local role service_role;
insert into trustcargo.ledger_journals (idempotency_key, kind, description, posted_by)
values ('test:commit-unbalanced', 'RELEASE_AUTHORIZED', 'x', 'test');
insert into trustcargo.ledger_entries (journal_id, account_id, direction, amount_minor, currency)
select j.id, a.id, d.direction, d.amount, 'CAD'
from trustcargo.ledger_journals j, trustcargo.ledger_accounts a,
     (values ('DEBIT', 100::bigint, 'PARTNER_CLEARING:sim:CAD'),
             ('CREDIT', 90::bigint, 'TX_HELD:11111111-1111-4111-8111-111111111111:CAD')) as d (direction, amount, code)
where j.idempotency_key = 'test:commit-unbalanced' and a.code = d.code;
\set insert_failed :ERROR
commit;
\set commit_failed :ERROR
\set ON_ERROR_STOP on
select tst.ok('inserts succeeded before commit', :'insert_failed' = 'false');
select tst.ok('COMMIT of unbalanced journal failed', :'commit_failed' = 'true');
select tst.eq('unbalanced journal was rolled back', (select count(*) from trustcargo.ledger_journals where idempotency_key = 'test:commit-unbalanced'), 0);

\echo '== audit, provider events, state machine, constraints (service_role)'
begin;
set local role service_role;
select tst.fails('UPDATE audit_events forbidden', $q$update trustcargo.audit_events set action = 'tampered'$q$, '42501');
select tst.fails('DELETE audit_events forbidden', 'delete from trustcargo.audit_events', '42501');
select tst.fails('audit chain: wrong previous_hash rejected',
    $q$insert into trustcargo.audit_events (sequence, actor_type, actor_id, action, entity_type, entity_id, previous_hash, hash)
       values (4, 'SYSTEM', 'system', 'x.y', 'x', 'x', encode(sha256('e1'::bytea), 'hex'), encode(sha256('fork'::bytea), 'hex'))$q$, '40001');
select tst.fails('audit chain: sequence gap rejected',
    $q$insert into trustcargo.audit_events (sequence, actor_type, actor_id, action, entity_type, entity_id, previous_hash, hash)
       values (5, 'SYSTEM', 'system', 'x.y', 'x', 'x', encode(sha256('e3'::bytea), 'hex'), encode(sha256('gap'::bytea), 'hex'))$q$, '40001');
select tst.fails('audit chain: replayed sequence rejected',
    $q$insert into trustcargo.audit_events (sequence, actor_type, actor_id, action, entity_type, entity_id, previous_hash, hash)
       values (3, 'SYSTEM', 'system', 'x.y', 'x', 'x', encode(sha256('e3'::bytea), 'hex'), encode(sha256('replay'::bytea), 'hex'))$q$, '40001');
select tst.fails('audit chain: sequence is required',
    $q$insert into trustcargo.audit_events (actor_type, actor_id, action, entity_type, entity_id, previous_hash, hash)
       values ('SYSTEM', 'system', 'x.y', 'x', 'x', encode(sha256('e3'::bytea), 'hex'), encode(sha256('none'::bytea), 'hex'))$q$, '23502');
select tst.fails('audit: a USER event needs a user id as actor',
    $q$insert into trustcargo.audit_events (sequence, actor_type, actor_id, action, entity_type, entity_id, previous_hash, hash)
       values (4, 'USER', 'system', 'x.y', 'x', 'x', encode(sha256('e3'::bytea), 'hex'), encode(sha256('e4'::bytea), 'hex'))$q$, '23514');
select tst.ok('audit chain: next sequence with correct previous_hash accepted (SYSTEM actor label, non-uuid entity id)', tst.affected(
    $q$insert into trustcargo.audit_events (sequence, actor_type, actor_id, action, entity_type, entity_id, previous_hash, hash)
       values (4, 'PROVIDER', 'mock', 'provider_event.rejected', 'provider_event', 'unverified', encode(sha256('e3'::bytea), 'hex'), encode(sha256('e4'::bytea), 'hex'))$q$) = 1);
select tst.fails('duplicate provider event rejected (replay protection)',
    $q$insert into trustcargo.provider_events (provider, external_event_id, type, payload, signature_verified, occurred_at)
       values ('sim', 'evt_0001', 'funds.confirmed', '{}', true, now())$q$, '23505');
select tst.fails('provider events cannot be deleted', 'delete from trustcargo.provider_events', '42501');
select tst.fails('provider event payload is immutable', $q$update trustcargo.provider_events set payload = '{"amountMinor": "1"}'$q$, '42501');
select tst.fails('unsigned provider event cannot be PROCESSED',
    $q$insert into trustcargo.provider_events (provider, external_event_id, type, payload, signature_verified, status, occurred_at)
       values ('sim', 'evt_unsigned', 'funds.confirmed', '{}', false, 'PROCESSED', now())$q$, '23514');
select tst.fails('invalid status transition rejected',
    $q$update trustcargo.transactions set status = 'COMPLETED' where id = '33333333-3333-4333-8333-333333333333'$q$, '23514');
select tst.eq('valid status transition accepted', tst.affected(
    $q$update trustcargo.transactions set status = 'AWAITING_PARTIES', version = version + 1 where id = '33333333-3333-4333-8333-333333333333' and version = 1$q$), 1);
select tst.eq('version bumped', (select version from trustcargo.transactions where id = '33333333-3333-4333-8333-333333333333'), 2);
select tst.eq('stale optimistic-lock write affects nothing', tst.affected(
    $q$update trustcargo.transactions set title = 'stale' where id = '33333333-3333-4333-8333-333333333333' and version = 1$q$), 0);
select tst.fails('version can only move by +1',
    $q$update trustcargo.transactions set version = version + 5 where id = '33333333-3333-4333-8333-333333333333'$q$, '40001');
select tst.fails('invalid payout transition rejected', $q$update trustcargo.payouts set status = 'PAID'$q$, '23514');
select tst.fails('raw account number cannot be stored',
    $q$insert into trustcargo.payment_accounts (owner_type, owner_user_id, holder_name, currency, country, bank_name, masked_identifier, provider_token)
       values ('USER', 'b0000000-0000-4000-8000-00000000000b', 'B', 'XOF', 'SN', 'Bank', 'SN08 SN01 0015 2000 0253 0000 7542', 'tok_sim_b_00000001')$q$, '23514');
select tst.fails('milestone share_bps must be >= 1',
    $q$insert into trustcargo.milestones (transaction_id, contract_version_id, sequence, key, title, share_bps, amount_minor, currency)
       values ('11111111-1111-4111-8111-111111111111', '1cc00000-0000-4000-8000-000000000001', 9, 'zero', 'z', 0, 1, 'CAD')$q$, '23514');
select tst.fails('ownership_bps must be <= 10000',
    $q$insert into trustcargo.beneficial_owners (organization_id, full_name, ownership_bps, country) values ('01000000-0000-4000-8000-000000000001', 'X', 10001, 'CA')$q$, '23514');
select tst.fails('unsupported currency rejected',
    $q$insert into trustcargo.ledger_accounts (code, name, type, currency) values ('X:GBP', 'x', 'ASSET', 'GBP')$q$, '23514');
select tst.fails('one acceptance per (contract_version, party)',
    $q$insert into trustcargo.contract_acceptances (transaction_id, contract_version_id, party_id, user_id, decision, content_hash)
       values ('11111111-1111-4111-8111-111111111111', '1cc00000-0000-4000-8000-000000000001', '1e000000-0000-4000-8000-000000000002',
               'b0000000-0000-4000-8000-00000000000b', 'ACCEPTED', encode(sha256('terms-t1-v1'::bytea), 'hex'))$q$, '23505');
select tst.fails('acceptance party must belong to the same transaction',
    $q$insert into trustcargo.contract_acceptances (transaction_id, contract_version_id, party_id, user_id, decision, content_hash)
       values ('11111111-1111-4111-8111-111111111111', '1cc00000-0000-4000-8000-000000000001', '2e000000-0000-4000-8000-000000000001',
               'c0000000-0000-4000-8000-00000000000c', 'ACCEPTED', encode(sha256('terms-t1-v1'::bytea), 'hex'))$q$, '23503');
select tst.fails('duplicate contract version number rejected',
    $q$insert into trustcargo.contract_versions (contract_id, transaction_id, version_number, terms, content_hash, created_by)
       values ('1c000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 1, '{}', encode(sha256('x'::bytea), 'hex'), 'a0000000-0000-4000-8000-00000000000a')$q$, '23505');
select tst.fails('duplicate document (logical_id, version) rejected',
    $q$insert into trustcargo.documents (logical_id, version, transaction_id, owner_user_id, type, title, file_name, mime_type, size_bytes, sha256, storage_key)
       values ('10c10000-0000-4000-8000-000000000001', 1, '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-00000000000a', 'INVOICE', 'x', 'x.pdf',
               'application/pdf', 1, encode(sha256('x'::bytea), 'hex'), '11111111-1111-4111-8111-111111111111/dup.pdf')$q$, '23505');
select tst.fails('identity documents cannot be shared with parties',
    $q$insert into trustcargo.documents (logical_id, transaction_id, owner_user_id, type, title, file_name, mime_type, size_bytes, sha256, storage_key, visible_to_roles)
       values (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'b0000000-0000-4000-8000-00000000000b', 'IDENTITY', 'x', 'x.pdf',
               'application/pdf', 1, encode(sha256('y'::bytea), 'hex'), '11111111-1111-4111-8111-111111111111/id.pdf', array['SELLER'])$q$, '23514');
select tst.fails('duplicate transaction reference rejected',
    $q$insert into trustcargo.transactions (reference, title, amount_minor, currency, corridor_id, created_by)
       values ('TCP-2026-0001', 'x', 1, 'CAD', 'c0441d00-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a')$q$, '23505');
select tst.fails('second open dispute on a transaction rejected',
    $q$insert into trustcargo.disputes (transaction_id, opened_by, opened_by_role, reason, description, requested_outcome, response_due_at)
       values ('11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-00000000000a', 'SELLER', 'NOT_DELIVERED', 'x', 'x', now())$q$, '23505');
select tst.fails('webhook secret ref must be a name, not a secret value',
    $q$insert into trustcargo.provider_connections (provider, display_name, webhook_secret_ref, regulatory_status_note)
       values ('other', 'x', 'whsec_live abc:def', 'x')$q$, '23514');
rollback;

-- =====================================================================================================
\echo '== storage of the TypeScript model (service_role)'
begin;
set local role service_role;

-- Users: demo personas need no auth account; real users must have one.
select tst.ok('demo persona without auth.users account accepted', tst.affected(
    $q$insert into trustcargo.users (id, email, full_name, country, is_demo)
       values ('0d000000-0000-7000-8000-000000000001', 'persona@demo.trustcargo.test', 'Demo Persona', 'CA', true)$q$) = 1);
select tst.fails('non-demo user without auth.users account rejected',
    $q$insert into trustcargo.users (id, email, full_name, country, is_demo)
       values ('0e000000-0000-7000-8000-000000000001', 'real@example.test', 'Real User', 'CA', false)$q$, '23503');
select tst.ok('non-demo user with an auth.users account accepted', tst.affected(
    $q$insert into trustcargo.users (id, email, full_name, country, is_demo)
       values ('c0000000-0000-4000-8000-00000000000c', 'dup@example.test', 'x', 'CA', false)
       on conflict (id) do update set is_demo = false$q$) = 1);

-- Demo TOTP secrets: demo personas only.
select tst.ok('TOTP secret stored for a demo persona', tst.affected(
    $q$insert into trustcargo_private.demo_mfa_secrets (user_id, totp_secret) values ('0d000000-0000-7000-8000-000000000001', 'JBSWY3DPEHPK3PXP')$q$) = 1);
select tst.fails('TOTP secret refused for a real user',
    $q$insert into trustcargo_private.demo_mfa_secrets (user_id, totp_secret) values ('c0000000-0000-4000-8000-00000000000c', 'JBSWY3DPEHPK3PXP')$q$, '42501');
select tst.fails('a demo persona with a TOTP secret cannot silently become a real user',
    $q$update trustcargo.users set is_demo = false where id = '0d000000-0000-7000-8000-000000000001'$q$);

-- Counters: atomic, transactional upsert-increment.
with x as (insert into trustcargo_private.counters as c (name, value) values ('transaction_reference', 1)
           on conflict (name) do update set value = c.value + 1 returning value)
select tst.eq('counter starts at 1', (select max(value) from x), 1);
with x as (insert into trustcargo_private.counters as c (name, value) values ('transaction_reference', 1)
           on conflict (name) do update set value = c.value + 1 returning value)
select tst.eq('counter increments', (select max(value) from x), 2);

-- Session pseudonyms: HMAC hex (pseudonymize() keeps 128 bits), never a raw identifier.
select tst.ok('128-bit pseudonymised session identifiers accepted', tst.affected(
    $q$insert into trustcargo.session_events (user_id, country, device_fingerprint_hash, ip_hash)
       values ('b0000000-0000-4000-8000-00000000000b', 'SN', repeat('ab', 16), repeat('cd', 16))$q$) = 1);
select tst.fails('raw device identifier rejected',
    $q$insert into trustcargo.session_events (user_id, country, device_fingerprint_hash, ip_hash)
       values ('b0000000-0000-4000-8000-00000000000b', 'SN', 'dev-awa-phone', repeat('cd', 16))$q$, '23514');

-- Append-only records of the Db port.
select tst.fails('session_events are append-only', $q$update trustcargo.session_events set country = 'CA'$q$, '42501');
select tst.fails('contract_acceptances are append-only', $q$update trustcargo.contract_acceptances set comment = 'edited'$q$, '42501');
select tst.fails('contract_acceptances cannot be deleted', 'delete from trustcargo.contract_acceptances', '42501');
select tst.fails('document_verifications are append-only', $q$update trustcargo.document_verifications set notes = 'edited'$q$, '42501');
select tst.fails('document_access_logs cannot be truncated', 'truncate trustcargo.document_access_logs', '42501');
select tst.fails('risk_reviews cannot be deleted', 'delete from trustcargo.risk_reviews', '42501');
select tst.fails('risk_reviews are append-only', $q$update trustcargo.risk_reviews set notes = 'edited'$q$, '42501');
select tst.fails('dispute_messages are append-only', $q$update trustcargo.dispute_messages set body = 'edited'$q$, '42501');
select tst.fails('reconciliations are append-only', $q$update trustcargo.reconciliations set status = 'DISCREPANCIES'$q$, '42501');
select tst.fails('reconciliation_items cannot be deleted', 'delete from trustcargo.reconciliation_items', '42501');
select tst.fails('reconciliation item positions are unique',
    $q$insert into trustcargo.reconciliation_items (reconciliation_id, ordinal, external_reference, kind, provider_amount_minor, currency, result)
       values ('9f000000-0000-4000-8000-000000000001', 0, 'X', 'FUNDS', 1, 'CAD', 'MISSING_IN_LEDGER')$q$, '23505');

-- Payout / refund lifecycles = PAYOUT_TRANSITIONS / REFUND_TRANSITIONS (the full matrix is compared with
-- TypeScript in tests/integration/postgres-adapter.test.ts).
select tst.ok('payout FAILED -> CANCELLED allowed', trustcargo_private.settlement_transition_allowed('payouts', 'FAILED', 'CANCELLED'));
select tst.ok('payout FAILED -> REQUESTED refused', not trustcargo_private.settlement_transition_allowed('payouts', 'FAILED', 'REQUESTED'));
select tst.ok('refund FAILED -> CANCELLED allowed', trustcargo_private.settlement_transition_allowed('refunds', 'FAILED', 'CANCELLED'));
select tst.ok('refund FAILED -> REQUESTED refused', not trustcargo_private.settlement_transition_allowed('refunds', 'FAILED', 'REQUESTED'));
select tst.eq('payout REQUESTED -> FAILED -> CANCELLED', tst.affected($q$
    update trustcargo.payouts set status = 'FAILED', failure_reason = 'Reported failed by partner';
    update trustcargo.payouts set status = 'CANCELLED'$q$), 1);
select tst.fails('payout amount immutable even without a status change', 'update trustcargo.payouts set amount_minor = amount_minor + 1', '42501');
select tst.eq('refund REQUESTED -> FAILED -> CANCELLED', tst.affected($q$
    update trustcargo.refunds set status = 'FAILED', failure_reason = 'Reported failed by partner';
    update trustcargo.refunds set status = 'CANCELLED'$q$), 1);

-- requested_by: a user id or 'system' (automatic re-attempts), user ids still checked against users.
select tst.ok('payout requested by the system accepted', tst.affected(
    $q$insert into trustcargo.payouts (transaction_id, milestone_id, payee_party_id, payment_account_id, amount_minor, currency, provider, idempotency_key, requested_by)
       values ('11111111-1111-4111-8111-111111111111', '1d000000-0000-4000-8000-000000000002', '1e000000-0000-4000-8000-000000000001',
               '9a000000-0000-4000-8000-000000000001', 1, 'CAD', 'sim', 'payout:system-retry', 'system')$q$) = 1);
select tst.fails('payout requested_by must be a user id or system',
    $q$insert into trustcargo.payouts (transaction_id, payee_party_id, payment_account_id, amount_minor, currency, provider, idempotency_key, requested_by)
       values ('11111111-1111-4111-8111-111111111111', '1e000000-0000-4000-8000-000000000001',
               '9a000000-0000-4000-8000-000000000001', 1, 'CAD', 'sim', 'payout:bad-requester', 'somebody')$q$, '23514');
select tst.fails('payout requested_by user must exist',
    $q$insert into trustcargo.payouts (transaction_id, payee_party_id, payment_account_id, amount_minor, currency, provider, idempotency_key, requested_by)
       values ('11111111-1111-4111-8111-111111111111', '1e000000-0000-4000-8000-000000000001',
               '9a000000-0000-4000-8000-000000000001', 1, 'CAD', 'sim', 'payout:ghost', '99999999-9999-4999-8999-999999999999')$q$, '23503');

-- Transactions: the price can still be amended in AWAITING_FUNDING (CONTRACT_AMENDED), not once funding started.
update trustcargo.transactions set status = 'AWAITING_PARTIES' where id = '33333333-3333-4333-8333-333333333333';
update trustcargo.transactions set status = 'IDENTITY_VERIFICATION' where id = '33333333-3333-4333-8333-333333333333';
update trustcargo.transactions set status = 'AWAITING_AGREEMENT' where id = '33333333-3333-4333-8333-333333333333';
update trustcargo.transactions set status = 'AWAITING_FUNDING' where id = '33333333-3333-4333-8333-333333333333';
select tst.eq('amendment in AWAITING_FUNDING may change the amount', tst.affected(
    $q$update trustcargo.transactions set status = 'AWAITING_AGREEMENT', amount_minor = 2300000 where id = '33333333-3333-4333-8333-333333333333'$q$), 1);
update trustcargo.transactions set status = 'AWAITING_FUNDING' where id = '33333333-3333-4333-8333-333333333333';
update trustcargo.transactions set status = 'FUNDING_PENDING' where id = '33333333-3333-4333-8333-333333333333';
select tst.fails('amount frozen once funding started',
    $q$update trustcargo.transactions set amount_minor = 1 where id = '33333333-3333-4333-8333-333333333333'$q$, '42501');
select tst.eq('version incremented by 1 on every update (7 updates)', (select version from trustcargo.transactions where id = '33333333-3333-4333-8333-333333333333'), 8);

-- FUNDS_CONFIRMED needs a FUNDED payment instruction for exactly the transaction's amount (now 2300000 CAD):
-- the partner's confirmation of an instruction issued before the amendment (1850000) must not fund it.
select tst.fails('FUNDS_CONFIRMED refused without any payment instruction',
    $q$update trustcargo.transactions set status = 'FUNDS_CONFIRMED' where id = '33333333-3333-4333-8333-333333333333'$q$, '23514');
insert into trustcargo.payment_instructions (id, transaction_id, provider, provider_reference, amount_minor, currency, payer_user_id, status, details, idempotency_key, expires_at) values
    ('9b000000-0000-4000-8000-000000000031', '33333333-3333-4333-8333-333333333333', 'sim', 'SIM-PI-0031', 2400000, 'CAD', 'b0000000-0000-4000-8000-00000000000b', 'FUNDED',
     '{"method": "BANK_TRANSFER"}', 'fund:t3:v1', now() + interval '7 days'),
    ('9b000000-0000-4000-8000-000000000032', '33333333-3333-4333-8333-333333333333', 'sim', 'SIM-PI-0032', 2300000, 'USD', 'b0000000-0000-4000-8000-00000000000b', 'FUNDED',
     '{"method": "BANK_TRANSFER"}', 'fund:t3:v1:usd', now() + interval '7 days'),
    ('9b000000-0000-4000-8000-000000000033', '33333333-3333-4333-8333-333333333333', 'sim', 'SIM-PI-0033', 2300000, 'CAD', 'b0000000-0000-4000-8000-00000000000b', 'PENDING',
     '{"method": "BANK_TRANSFER"}', 'fund:t3:v2', now() + interval '7 days'),
    ('9b000000-0000-4000-8000-000000000034', '11111111-1111-4111-8111-111111111111', 'sim', 'SIM-PI-0034', 2300000, 'CAD', 'b0000000-0000-4000-8000-00000000000b', 'FUNDED',
     '{"method": "BANK_TRANSFER"}', 'fund:t1:other', now() + interval '7 days');
select tst.fails('FUNDS_CONFIRMED refused: FUNDED instructions of another amount / currency / transaction, matching one only PENDING',
    $q$update trustcargo.transactions set status = 'FUNDS_CONFIRMED' where id = '33333333-3333-4333-8333-333333333333'$q$, '23514');
select tst.eq('FUNDS_CONFIRMED accepted once the instruction for the transaction amount is FUNDED', tst.affected($q$
    update trustcargo.payment_instructions set status = 'FUNDED' where id = '9b000000-0000-4000-8000-000000000033';
    update trustcargo.transactions set status = 'FUNDS_CONFIRMED' where id = '33333333-3333-4333-8333-333333333333'$q$), 1);

-- updated_at: application-owned columns keep the writer's value; DB-owned columns are always now().
with u as (update trustcargo.transactions set title = 'Lexus RX 2020 (a)', updated_at = '2026-01-02T03:04:05.678Z'
           where id = '33333333-3333-4333-8333-333333333333' returning updated_at)
select tst.ok('explicit updated_at kept', (select count(*) = 1 and bool_and(updated_at = '2026-01-02T03:04:05.678Z') from u));
with u as (update trustcargo.transactions set title = 'Lexus RX 2020 (b)' where id = '33333333-3333-4333-8333-333333333333' returning updated_at)
select tst.ok('unchanged updated_at set to now() for other writers', (select count(*) = 1 and bool_and(updated_at = now()) from u));
select set_config('trustcargo.app_managed_updated_at', 'on', true);
with u as (update trustcargo.transactions set title = 'Lexus RX 2020 (c)', updated_at = '2026-01-02T03:04:05.678Z'
           where id = '33333333-3333-4333-8333-333333333333' returning updated_at)
select tst.ok('server unit of work: explicit updated_at kept', (select count(*) = 1 and bool_and(updated_at = '2026-01-02T03:04:05.678Z') from u));
with u as (update trustcargo.transactions set title = 'Lexus RX 2020 (d)', updated_at = '2026-01-02T03:04:05.678Z'
           where id = '33333333-3333-4333-8333-333333333333' returning updated_at)
select tst.ok('server unit of work: the same instant written twice is kept',
    (select count(*) = 1 and bool_and(updated_at = '2026-01-02T03:04:05.678Z') from u));
with u as (update trustcargo.users set city = 'Dakar', updated_at = '2000-01-01T00:00:00Z'
           where id = 'b0000000-0000-4000-8000-00000000000b' returning updated_at)
select tst.ok('database-owned updated_at is always now()', (select count(*) = 1 and bool_and(updated_at = now()) from u));
rollback;

-- =====================================================================================================
\echo '== simulated partner records (trustcargo_sim)'
begin;
set local role anon;
select tst.denied('anon cannot read simulated instructions', 'select * from trustcargo_sim.instructions');
select tst.denied('anon cannot read the simulated statement', 'select * from trustcargo_sim.statement_lines');
rollback;

begin;
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-00000000000f","role":"authenticated"}', true);
set local role authenticated;
select tst.denied('finance operator F cannot read simulated transfers', 'select * from trustcargo_sim.transfers');
select tst.denied('finance operator F cannot add a simulated statement line',
    $q$insert into trustcargo_sim.statement_lines (external_reference, kind, amount_minor, currency, occurred_at)
       values ('sim_pi_forged', 'FUNDS_RECEIVED', 1850000, 'CAD', now())$q$);
rollback;

begin;
set local role service_role;
select tst.ok('service_role records a simulated instruction', tst.affected(
    $q$insert into trustcargo_sim.instructions (reference, idempotency_key, amount_minor, currency)
       values ('sim_pi_AbC-12_xyz', 'fund:sim-test', 1850000, 'CAD')$q$) = 1);
select tst.fails('one simulated instruction per idempotency key',
    $q$insert into trustcargo_sim.instructions (reference, idempotency_key, amount_minor, currency)
       values ('sim_pi_other', 'fund:sim-test', 1850000, 'CAD')$q$, '23505');
select tst.eq('a replayed key is ignored by ON CONFLICT DO NOTHING', tst.affected(
    $q$insert into trustcargo_sim.instructions (reference, idempotency_key, amount_minor, currency)
       values ('sim_pi_other', 'fund:sim-test', 1, 'USD') on conflict (idempotency_key) do nothing$q$), 0);
select tst.fails('simulated references carry the sim_ prefix',
    $q$insert into trustcargo_sim.instructions (reference, idempotency_key, amount_minor, currency)
       values ('PI-REAL-0001', 'fund:not-sim', 1850000, 'CAD')$q$, '23514');
select tst.fails('simulated amounts are positive integers',
    $q$insert into trustcargo_sim.instructions (reference, idempotency_key, amount_minor, currency)
       values ('sim_pi_zero', 'fund:zero', 0, 'CAD')$q$, '23514');
select tst.eq('service_role moves a simulated status', tst.affected(
    $q$update trustcargo_sim.instructions set status = 'FUNDED', updated_at = now() where reference = 'sim_pi_AbC-12_xyz'$q$), 1);
select tst.fails('unknown simulated status rejected',
    $q$update trustcargo_sim.instructions set status = 'SETTLED' where reference = 'sim_pi_AbC-12_xyz'$q$, '23514');
select tst.denied('simulated amounts cannot be rewritten',
    $q$update trustcargo_sim.instructions set amount_minor = 1 where reference = 'sim_pi_AbC-12_xyz'$q$);
select tst.denied('simulated instructions cannot be deleted', 'delete from trustcargo_sim.instructions');
select tst.ok('service_role records a simulated payout', tst.affected(
    $q$insert into trustcargo_sim.transfers (reference, kind, idempotency_key, amount_minor, currency)
       values ('sim_po_AbC123', 'PAYOUT', 'payout:sim-test', 185000, 'CAD')$q$) = 1);
select tst.fails('one simulated transfer per idempotency key',
    $q$insert into trustcargo_sim.transfers (reference, kind, idempotency_key, amount_minor, currency)
       values ('sim_po_other', 'PAYOUT', 'payout:sim-test', 185000, 'CAD')$q$, '23505');
select tst.fails('transfer reference prefix matches its kind',
    $q$insert into trustcargo_sim.transfers (reference, kind, idempotency_key, amount_minor, currency)
       values ('sim_po_mismatch', 'REFUND', 'refund:sim-test', 185000, 'CAD')$q$, '23514');
select tst.ok('service_role appends to the simulated statement', tst.affected(
    $q$insert into trustcargo_sim.statement_lines (external_reference, kind, amount_minor, currency, occurred_at)
       values ('sim_pi_AbC-12_xyz', 'FUNDS_RECEIVED', 1850000, 'CAD', now())$q$) = 1);
select tst.denied('the simulated statement is append-only (update)', 'update trustcargo_sim.statement_lines set amount_minor = 1');
select tst.denied('the simulated statement is append-only (delete)', 'delete from trustcargo_sim.statement_lines');
rollback;

-- Cleanup of test helpers.
drop schema tst cascade;

\echo 'ALL RLS/LEDGER TESTS PASSED'
