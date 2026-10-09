# TrustCargo Pay — Supabase database

Schema, integrity rules and Row Level Security for TrustCargo Pay. The TypeScript domain model
(`src/domain/model.ts`, `src/domain/money.ts`, `src/domain/transaction/state-machine.ts`) is the
source of truth; these migrations map it to normalized Postgres tables.

TrustCargo Pay never holds funds. Payment tables only mirror instructions sent to, and events
reported by, a licensed payment partner. The MVP runs in **SIMULATION** mode only.

## Layout

| File | Content |
| --- | --- |
| `migrations/20261009000001_core_schema.sql` | Domains (`currency_code`, `country_code`, `sha256_hex`), enums, the tables, FKs, CHECK/UNIQUE constraints, FK indexes, `updated_at` triggers, the optimistic lock on `transactions.version`, and DB-level guards for the transaction, payout and refund status transitions |
| `migrations/20261009000002_ledger_integrity.sql` | Append-only ledger and audit tables, the deferred per-journal balance check, entry-versus-account currency check, reversal rules, `post_ledger_journal()` (service_role only), immutable `provider_events`, audit hash-chain linkage, and the `ledger_account_balances` view |
| `migrations/20261009000003_rls.sql` | Grants, `app.*` RLS helpers, RLS on every table, policies, the private `transaction-documents` bucket and its storage policies |
| `tests/supabase_shim.sql` | Minimal stand-in for Supabase (roles, `auth`, `storage`) so the migrations run on plain PostgreSQL. **Never apply it to Supabase.** |
| `tests/rls_test.sql` | Self-checking test script that seeds data and asserts RLS, ledger and constraint behaviour |

## Conventions

- Money is always `amount_minor bigint` (integer minor units) plus `currency public.currency_code`
  (`char(3)` limited to CAD/USD/EUR/XOF). No column holds an amount as a float or numeric.
- `payment_accounts` stores only a masked identifier (at most 4 digits, enforced by a CHECK) and the
  partner's vault token. It never stores a raw account number.
- `provider_connections.webhook_secret_ref` stores the **name** of a secret, never its value.
- Audit hash chain: the application computes `hash = SHA-256(previous_hash + canonical event)`. The
  database serializes inserts, assigns `sequence` under a lock and requires `previous_hash` to equal
  the latest `hash`. The genesis event uses 64 zeros. A writer that loses a race gets SQLSTATE
  `40001` and must retry.
- Optimistic locking: `update transactions set ..., version = version + 1 where id = $1 and version = $2`.
  If the writer does not bump `version`, the trigger bumps it. Any other change to `version` is
  rejected.

## Access model

- `anon` has no privileges at all.
- `authenticated` can read rows that RLS allows. It can also make a few self-service updates, each
  limited to specific columns:
  - `users`: `full_name`, `phone`, `city`, `locale`
  - `notifications`: `read_at`
  - `transactions`: `title`, only by the creator and only while the transaction is in `DRAFT`
  - `corridors` and `security_settings`: platform_admin only
- Every business write goes through the server with `service_role`. That includes state
  transitions, payments, ledger, audit, risk, documents and disputes. The server runs the
  TypeScript state machine and writes the audit event in the same database transaction. The
  ledger is written only through `public.post_ledger_journal(...)`.
- RLS helpers `app.has_platform_role`, `app.has_any_platform_role`, `app.is_org_member`,
  `app.party_roles`, `app.party_role`, `app.is_transaction_party` and `app.is_principal_party` are
  `SECURITY DEFINER`, `STABLE`, with `search_path = ''`. Because they read `transaction_parties`
  and `organization_members` outside RLS, the policies cannot recurse. A user is a party to a
  transaction when they have a `JOINED` party row, either directly or as a member of the party's
  organization.
- `INSPECTOR` and `FREIGHT_FORWARDER` parties never see payment instructions, payouts, refunds or
  disputes.
- A party sees a document only if they own it or one of their party roles is in
  `visible_to_roles`. `IDENTITY` documents are visible only to their owner and to
  compliance_analyst.
- Parties never see risk alerts, risk reviews, screening results or compliance holds.

## Apply to a Supabase project

```bash
supabase link --project-ref <project-ref>
supabase db push          # applies supabase/migrations in filename order
```

Locally with the Supabase CLI: `supabase start`, then `supabase db reset`.

These migrations have not been applied to a real Supabase project or the Supabase CLI stack yet.
Run them on a Supabase branch or staging project first.

## Tests (plain PostgreSQL 16)

```bash
npm run test:db           # = bash scripts/test-db.sh
```

Without `DATABASE_URL`, the script:

1. Creates a throwaway cluster in `.tmp/pgdata` on port 54329, with trust auth and the Unix socket
   in the data directory. When run as root it uses the `postgres` system user.
2. Applies `tests/supabase_shim.sql`, then the migrations in filename order.
3. Runs `tests/rls_test.sql` and removes the cluster.

With `DATABASE_URL` set (for example a CI `postgres:16` service), the script uses that database
instead. It must be an **empty** database, and the user must be a superuser so it can create the
roles and switch to them.

The migrations have been verified this way on PostgreSQL 16.15 with the shim: the script ends with
`ALL RLS/LEDGER TESTS PASSED`.
