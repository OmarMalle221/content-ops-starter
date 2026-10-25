-- =====================================================================================================
-- Minimal Supabase shim for PLAIN PostgreSQL 16 (local tests / CI only — never apply on Supabase).
--
-- Provides what the migrations rely on: the anon/authenticated/service_role roles, auth.users,
-- auth.uid()/auth.jwt()/auth.role() reading the PostgREST `request.jwt.claims` GUC, and a tiny
-- storage schema (buckets, objects with RLS, foldername()).
-- =====================================================================================================

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin noinherit bypassrls;
    end if;
end;
$$;

-- ---------------------------------------------------------------------------------------- auth
create schema if not exists auth;

create table if not exists auth.users (
    id    uuid primary key,
    email text
);

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
    select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
    select auth.jwt() ->> 'role';
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant all on auth.users to service_role;

-- ---------------------------------------------------------------------------------------- storage
create schema if not exists storage;

create table if not exists storage.buckets (
    id     text primary key,
    name   text not null,
    public boolean not null default false,
    file_size_limit    bigint,
    allowed_mime_types text[]
);

create table if not exists storage.objects (
    id         uuid primary key default gen_random_uuid(),
    bucket_id  text references storage.buckets (id),
    name       text,
    owner      uuid,
    created_at timestamptz default now()
);
create unique index if not exists objects_bucket_name on storage.objects (bucket_id, name);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;

-- Same semantics as Supabase: folders of the path, without the file name.
create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
    select (string_to_array(name, '/'))[1 : greatest(cardinality(string_to_array(name, '/')) - 1, 0)];
$$;

grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated;
grant all on storage.buckets to service_role;
grant execute on all functions in schema storage to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------- public
-- Supabase grants usage on public to the API roles.
grant usage on schema public to anon, authenticated, service_role;
