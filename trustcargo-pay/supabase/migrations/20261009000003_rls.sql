-- =====================================================================================================
-- TrustCargo Pay — privileges & Row Level Security
--
-- Model:
--   * anon: nothing.
--   * authenticated: SELECT filtered by RLS, plus a handful of column-scoped self-service updates.
--     Every business write (state transitions, payments, ledger, audit, risk) goes through the server
--     using service_role, which runs the TypeScript state machine and writes the audit chain in the
--     same unit of work. There are NO insert/update policies for authenticated on financial tables.
--   * service_role: full table access (BYPASSRLS) for the server's unit of work; the ledger and audit
--     tables stay append-only and balanced through triggers whichever path writes them.
--   * trustcargo_private tables (counters, demo_mfa_secrets): service_role only, RLS enabled, no policy.
--
-- Helper functions are SECURITY DEFINER (owned by the migration role, which owns the tables and is
-- therefore not subject to their RLS), STABLE and pinned to an empty search_path. Policies that need
-- to look at transaction_parties always go through them, which avoids RLS recursion.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------------------------------

-- trustcargo_private.try_uuid(text) is defined in the core schema migration (used by generated columns).

create or replace function trustcargo_private.has_platform_role(p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from trustcargo.user_platform_roles r
        join trustcargo.users u on u.id = r.user_id
        where r.user_id = auth.uid()
          and r.role::text = p_role
          and u.status = 'ACTIVE'
    );
$$;

create or replace function trustcargo_private.has_any_platform_role(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from trustcargo.user_platform_roles r
        join trustcargo.users u on u.id = r.user_id
        where r.user_id = auth.uid()
          and r.role::text = any (p_roles)
          and u.status = 'ACTIVE'
    );
$$;

create or replace function trustcargo_private.is_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from trustcargo.organization_members m
        where m.organization_id = p_organization_id
          and m.user_id = auth.uid()
    );
$$;

-- Party roles held by the current user in a transaction: JOINED parties, either directly (user_id)
-- or through membership of the party's organization.
create or replace function trustcargo_private.party_roles(p_transaction_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
    select coalesce(array_agg(distinct p.role::text), '{}')
    from trustcargo.transaction_parties p
    where p.transaction_id = p_transaction_id
      and p.status = 'JOINED'
      and (
          p.user_id = auth.uid()
          or (p.organization_id is not null and exists (
                select 1 from trustcargo.organization_members m
                where m.organization_id = p.organization_id and m.user_id = auth.uid()))
      );
$$;

-- Single "most privileged" role (SELLER > BUYER > INSPECTOR > FREIGHT_FORWARDER), or null.
create or replace function trustcargo_private.party_role(p_transaction_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
    select r
    from unnest(trustcargo_private.party_roles(p_transaction_id)) as r
    order by array_position(array['SELLER', 'BUYER', 'INSPECTOR', 'FREIGHT_FORWARDER'], r)
    limit 1;
$$;

create or replace function trustcargo_private.is_transaction_party(p_transaction_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select cardinality(trustcargo_private.party_roles(p_transaction_id)) > 0;
$$;

-- SELLER / BUYER only. Inspectors and freight forwarders never see money movements or disputes.
create or replace function trustcargo_private.is_principal_party(p_transaction_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select trustcargo_private.party_roles(p_transaction_id) && array['SELLER', 'BUYER'];
$$;

revoke all on schema trustcargo_private from public;
grant usage on schema trustcargo_private to authenticated, service_role;
revoke all on all functions in schema trustcargo_private from public;
grant execute on all functions in schema trustcargo_private to service_role;
grant execute on function
    trustcargo_private.try_uuid(text),
    trustcargo_private.has_platform_role(text),
    trustcargo_private.has_any_platform_role(text[]),
    trustcargo_private.is_org_member(uuid),
    trustcargo_private.party_roles(uuid),
    trustcargo_private.party_role(uuid),
    trustcargo_private.is_transaction_party(uuid),
    trustcargo_private.is_principal_party(uuid),
    -- evaluated by the transactions trigger when a DRAFT creator renames their transaction
    trustcargo_private.transaction_transition_allowed(text, text)
to authenticated;

-- -----------------------------------------------------------------------------------------------------
-- Table privileges (identical on Supabase and on plain Postgres + shim)
-- -----------------------------------------------------------------------------------------------------

revoke all on all tables in schema trustcargo from anon, authenticated;
revoke all on all sequences in schema trustcargo from anon, authenticated;
revoke all on function trustcargo.post_ledger_journal(text, text, uuid, text, text, jsonb, text, uuid, uuid) from anon, authenticated;
alter default privileges in schema trustcargo revoke all on tables from anon, authenticated;
alter default privileges in schema trustcargo revoke all on sequences from anon, authenticated;

grant usage on schema trustcargo to authenticated, service_role;
grant all on all tables in schema trustcargo to service_role;
grant usage, select on all sequences in schema trustcargo to service_role;

-- Reads are filtered by RLS; tables without a matching policy return no rows.
grant select on all tables in schema trustcargo to authenticated;

-- Private tables: the server (service_role) only. Counters are never deleted; demo secrets may be removed.
revoke all on all tables in schema trustcargo_private from public, anon, authenticated;
alter default privileges in schema trustcargo_private revoke all on tables from public, anon, authenticated;
grant select, insert, update on trustcargo_private.counters to service_role;
grant select, insert, update, delete on trustcargo_private.demo_mfa_secrets to service_role;

-- Self-service writes, column-scoped (kyc_status, status, roles, email... are NOT updatable).
grant update (full_name, phone, city, locale) on trustcargo.users to authenticated;
grant update (read_at) on trustcargo.notifications to authenticated;
grant update (title) on trustcargo.transactions to authenticated; -- never status/amount/version
grant insert, update on trustcargo.corridors to authenticated;           -- platform_admin via policy
grant update (
    admin_mfa_max_age_minutes, sensitive_action_mfa_max_age_minutes, payout_account_cooling_off_hours,
    invitation_ttl_hours, signed_url_ttl_seconds, max_upload_bytes, updated_by
) on trustcargo.security_settings to authenticated;                      -- platform_admin via policy

-- -----------------------------------------------------------------------------------------------------
-- Enable RLS on every table in trustcargo and trustcargo_private
-- -----------------------------------------------------------------------------------------------------

do $$
declare
    r record;
begin
    for r in
        select n.nspname, c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('trustcargo', 'trustcargo_private') and c.relkind in ('r', 'p')
    loop
        execute format('alter table %I.%I enable row level security', r.nspname, r.relname);
    end loop;
end;
$$;

-- -----------------------------------------------------------------------------------------------------
-- Identity & organizations
-- -----------------------------------------------------------------------------------------------------

create policy users_select on trustcargo.users for select to authenticated
    using (
        id = (select auth.uid())
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'auditor']))
    );

create policy users_update_own on trustcargo.users for update to authenticated
    using (id = (select auth.uid()))
    with check (id = (select auth.uid()));

create policy user_platform_roles_select on trustcargo.user_platform_roles for select to authenticated
    using (
        user_id = (select auth.uid())
        or (select trustcargo_private.has_any_platform_role(array['platform_admin', 'auditor']))
    );

create policy organizations_select on trustcargo.organizations for select to authenticated
    using (
        trustcargo_private.is_org_member(id)
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'auditor']))
    );

create policy organization_members_select on trustcargo.organization_members for select to authenticated
    using (
        trustcargo_private.is_org_member(organization_id)
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'auditor']))
    );

create policy identity_verifications_select on trustcargo.identity_verifications for select to authenticated
    using (
        subject_user_id = (select auth.uid())
        or (subject_organization_id is not null and trustcargo_private.is_org_member(subject_organization_id))
        or (select trustcargo_private.has_platform_role('compliance_analyst'))
    );

create policy beneficial_owners_select on trustcargo.beneficial_owners for select to authenticated
    using (
        trustcargo_private.is_org_member(organization_id)
        or (select trustcargo_private.has_platform_role('compliance_analyst'))
    );

create policy payment_accounts_select on trustcargo.payment_accounts for select to authenticated
    using (
        owner_user_id = (select auth.uid())
        or (owner_organization_id is not null and trustcargo_private.is_org_member(owner_organization_id))
        or (select trustcargo_private.has_platform_role('compliance_analyst'))
    );

create policy session_events_select on trustcargo.session_events for select to authenticated
    using (
        user_id = (select auth.uid())
        or (select trustcargo_private.has_platform_role('compliance_analyst'))
    );

-- -----------------------------------------------------------------------------------------------------
-- Configuration
-- -----------------------------------------------------------------------------------------------------

create policy corridors_select on trustcargo.corridors for select to authenticated
    using (true);
create policy corridors_insert on trustcargo.corridors for insert to authenticated
    with check ((select trustcargo_private.has_platform_role('platform_admin')));
create policy corridors_update on trustcargo.corridors for update to authenticated
    using ((select trustcargo_private.has_platform_role('platform_admin')))
    with check ((select trustcargo_private.has_platform_role('platform_admin')));

create policy security_settings_select on trustcargo.security_settings for select to authenticated
    using ((select trustcargo_private.has_platform_role('platform_admin')));
create policy security_settings_update on trustcargo.security_settings for update to authenticated
    using ((select trustcargo_private.has_platform_role('platform_admin')))
    with check ((select trustcargo_private.has_platform_role('platform_admin')));

-- -----------------------------------------------------------------------------------------------------
-- Transactions & related (parties + justified staff)
-- -----------------------------------------------------------------------------------------------------

create policy transactions_select on trustcargo.transactions for select to authenticated
    using (
        trustcargo_private.is_transaction_party(id)
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'dispute_manager', 'auditor', 'finance_operator']))
    );

-- Only the creator may rename a DRAFT; column privileges restrict the update to `title`.
create policy transactions_update_draft_title on trustcargo.transactions for update to authenticated
    using (created_by = (select auth.uid()) and status = 'DRAFT')
    with check (created_by = (select auth.uid()) and status = 'DRAFT');

create policy transaction_parties_select on trustcargo.transaction_parties for select to authenticated
    using (
        trustcargo_private.is_transaction_party(transaction_id)
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'dispute_manager', 'auditor']))
    );

create policy vehicles_select on trustcargo.vehicles for select to authenticated
    using (
        trustcargo_private.is_transaction_party(transaction_id)
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'dispute_manager', 'auditor']))
    );

create policy contracts_select on trustcargo.contracts for select to authenticated
    using (
        trustcargo_private.is_transaction_party(transaction_id)
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'dispute_manager', 'auditor']))
    );

create policy contract_versions_select on trustcargo.contract_versions for select to authenticated
    using (
        trustcargo_private.is_transaction_party(transaction_id)
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'dispute_manager', 'auditor']))
    );

create policy contract_acceptances_select on trustcargo.contract_acceptances for select to authenticated
    using (
        trustcargo_private.is_transaction_party(transaction_id)
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'dispute_manager', 'auditor']))
    );

create policy milestones_select on trustcargo.milestones for select to authenticated
    using (
        trustcargo_private.is_transaction_party(transaction_id)
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'dispute_manager', 'auditor']))
    );

create policy milestone_evidence_select on trustcargo.milestone_evidence for select to authenticated
    using (
        trustcargo_private.is_transaction_party(transaction_id)
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'dispute_manager', 'auditor']))
    );

-- Disputes are between SELLER and BUYER.
create policy disputes_select on trustcargo.disputes for select to authenticated
    using (
        trustcargo_private.is_principal_party(transaction_id)
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'dispute_manager', 'auditor']))
    );

create policy dispute_messages_select on trustcargo.dispute_messages for select to authenticated
    using (
        trustcargo_private.is_principal_party(transaction_id)
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'dispute_manager', 'auditor']))
    );

create policy dispute_decisions_select on trustcargo.dispute_decisions for select to authenticated
    using (
        trustcargo_private.is_principal_party(transaction_id)
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'dispute_manager', 'auditor']))
    );

-- Legal / regulatory holds may not be disclosed to parties (tipping-off risk).
create policy compliance_holds_select on trustcargo.compliance_holds for select to authenticated
    using ((select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'auditor'])));

-- -----------------------------------------------------------------------------------------------------
-- Documents
-- -----------------------------------------------------------------------------------------------------

create policy documents_select on trustcargo.documents for select to authenticated
    using (
        owner_user_id = (select auth.uid())
        or (
            type = 'IDENTITY'
            and (select trustcargo_private.has_platform_role('compliance_analyst'))
        )
        or (
            type <> 'IDENTITY'
            and (
                (select trustcargo_private.has_any_platform_role(array['document_reviewer', 'compliance_analyst', 'dispute_manager']))
                or (transaction_id is not null and trustcargo_private.party_roles(transaction_id) && visible_to_roles)
            )
        )
    );

create policy document_verifications_select on trustcargo.document_verifications for select to authenticated
    using (
        (select trustcargo_private.has_any_platform_role(array['document_reviewer', 'compliance_analyst', 'auditor']))
        or exists (
            select 1 from trustcargo.documents d
            where d.id = document_verifications.document_id and d.owner_user_id = (select auth.uid())
        )
    );

create policy document_access_logs_select on trustcargo.document_access_logs for select to authenticated
    using (
        user_id = (select auth.uid())
        or (select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'auditor']))
    );

-- -----------------------------------------------------------------------------------------------------
-- Risk internals: staff only, never parties
-- -----------------------------------------------------------------------------------------------------

create policy risk_alerts_select on trustcargo.risk_alerts for select to authenticated
    using ((select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'auditor'])));

create policy risk_reviews_select on trustcargo.risk_reviews for select to authenticated
    using ((select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'auditor'])));

create policy screening_results_select on trustcargo.screening_results for select to authenticated
    using ((select trustcargo_private.has_any_platform_role(array['compliance_analyst', 'auditor'])));

-- -----------------------------------------------------------------------------------------------------
-- Payments: SELLER/BUYER of the transaction + finance/audit/compliance. Read only.
-- -----------------------------------------------------------------------------------------------------

create policy payment_instructions_select on trustcargo.payment_instructions for select to authenticated
    using (
        trustcargo_private.is_principal_party(transaction_id)
        or (select trustcargo_private.has_any_platform_role(array['finance_operator', 'auditor', 'compliance_analyst']))
    );

create policy payouts_select on trustcargo.payouts for select to authenticated
    using (
        trustcargo_private.is_principal_party(transaction_id)
        or (select trustcargo_private.has_any_platform_role(array['finance_operator', 'auditor', 'compliance_analyst']))
    );

create policy refunds_select on trustcargo.refunds for select to authenticated
    using (
        trustcargo_private.is_principal_party(transaction_id)
        or (select trustcargo_private.has_any_platform_role(array['finance_operator', 'auditor', 'compliance_analyst']))
    );

-- -----------------------------------------------------------------------------------------------------
-- Provider integration, ledger, reconciliation: finance_operator + auditor, read only.
-- -----------------------------------------------------------------------------------------------------

create policy provider_events_select on trustcargo.provider_events for select to authenticated
    using ((select trustcargo_private.has_any_platform_role(array['finance_operator', 'auditor'])));

create policy provider_connections_select on trustcargo.provider_connections for select to authenticated
    using ((select trustcargo_private.has_any_platform_role(array['finance_operator', 'auditor'])));

create policy ledger_accounts_select on trustcargo.ledger_accounts for select to authenticated
    using ((select trustcargo_private.has_any_platform_role(array['finance_operator', 'auditor'])));

create policy ledger_journals_select on trustcargo.ledger_journals for select to authenticated
    using ((select trustcargo_private.has_any_platform_role(array['finance_operator', 'auditor'])));

create policy ledger_entries_select on trustcargo.ledger_entries for select to authenticated
    using ((select trustcargo_private.has_any_platform_role(array['finance_operator', 'auditor'])));

create policy reconciliations_select on trustcargo.reconciliations for select to authenticated
    using ((select trustcargo_private.has_any_platform_role(array['finance_operator', 'auditor'])));

create policy reconciliation_items_select on trustcargo.reconciliation_items for select to authenticated
    using ((select trustcargo_private.has_any_platform_role(array['finance_operator', 'auditor'])));

-- -----------------------------------------------------------------------------------------------------
-- Audit & notifications
-- -----------------------------------------------------------------------------------------------------

-- Parties see the trail of their transactions, minus internal compliance/risk entities.
create policy audit_events_select on trustcargo.audit_events for select to authenticated
    using (
        (select trustcargo_private.has_any_platform_role(array['auditor', 'compliance_analyst']))
        or (
            transaction_id is not null
            and entity_type not in ('risk_alert', 'risk_review', 'screening_result', 'compliance_hold', 'identity_verification')
            and trustcargo_private.is_transaction_party(transaction_id)
        )
    );

create policy notifications_select on trustcargo.notifications for select to authenticated
    using (user_id = (select auth.uid()));

create policy notifications_update_own on trustcargo.notifications for update to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------------------------------
-- Storage: private bucket `trustcargo-documents`, objects named '<transaction_id>/...'.
-- Guarded so the migration also runs where the storage schema is absent.
-- -----------------------------------------------------------------------------------------------------

do $$
begin
    if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
        raise notice 'storage schema not found: skipping bucket and storage policies';
        return;
    end if;

    insert into storage.buckets (id, name, public)
    values ('trustcargo-documents', 'trustcargo-documents', false)
    on conflict (id) do update set public = false;

    -- Supabase-only bucket limits, applied when the columns exist.
    if exists (select 1 from information_schema.columns
               where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
        execute $sql$
            update storage.buckets
            set file_size_limit = 15728640,
                allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
            where id = 'trustcargo-documents'
        $sql$;
    end if;

    execute 'drop policy if exists trustcargo_documents_select on storage.objects';
    execute 'drop policy if exists trustcargo_documents_insert on storage.objects';

    -- Download: party of the transaction in the path prefix (or document staff) AND the object must be
    -- backed by a documents row the caller can see under documents RLS (role visibility, identity docs).
    execute $sql$
        create policy trustcargo_documents_select on storage.objects for select to authenticated
        using (
            bucket_id = 'trustcargo-documents'
            and (
                trustcargo_private.is_transaction_party(trustcargo_private.try_uuid((storage.foldername(name))[1]))
                or (select trustcargo_private.has_any_platform_role(array['document_reviewer', 'compliance_analyst', 'dispute_manager']))
            )
            and exists (select 1 from trustcargo.documents d where d.storage_key = objects.name)
        )
    $sql$;

    -- Upload: only into a transaction folder the caller is a party of, as themselves.
    -- Uploaded files stay inert until the server scans them and creates the documents row.
    execute $sql$
        create policy trustcargo_documents_insert on storage.objects for insert to authenticated
        with check (
            bucket_id = 'trustcargo-documents'
            and owner = (select auth.uid())
            and trustcargo_private.is_transaction_party(trustcargo_private.try_uuid((storage.foldername(name))[1]))
        )
    $sql$;
    -- No update/delete policies: objects are immutable for end users (new version = new object).
end;
$$;
