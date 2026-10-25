-- =====================================================================================================
-- Relais — étape 2 : dossier familial et membres.
--
-- Tables : care_files, care_file_members, care_file_invitations, care_recipients, care_needs, contacts.
-- Matrice d'accès par zone de données (private.can_read / private.can_write) :
--   lecture  : profile = tous les membres ; coordination = tous sauf rien ; health et benefits = owner,
--              full, read_only ; manage = owner.
--   écriture : manage = owner ; profile, health, benefits = owner, full ; coordination = owner, full,
--              coordination. Toute écriture (hors manage) exige le consentement actif de la personne
--              aidée ; une écriture de santé exige aussi le consentement `health_information` de l'auteur.
-- Intervenantes : membres seulement si l'aidant les invite, et seulement avec la MFA (aal2).
-- Admin : jamais membre d'un dossier par défaut, donc aucun accès.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------------------------------
create type public.member_role as enum ('primary_caregiver', 'family_member', 'care_recipient', 'relais_worker');
create type public.access_level as enum ('owner', 'full', 'coordination', 'read_only');
create type public.data_area as enum ('profile', 'coordination', 'health', 'benefits', 'manage');
create type public.living_setting as enum ('home', 'rpa', 'intermediate_resource', 'chsld', 'hospital', 'other');
create type public.contact_kind as enum (
    'clsc', 'social_worker', 'physician', 'pharmacy', 'notary', 'residence', 'home_care', 'other'
);

-- -----------------------------------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------------------------------
create table public.care_files (
    id         uuid primary key default gen_random_uuid(),
    owner_id   uuid not null references public.users (id),  -- suppression du dossier avant celle du compte
    title      text not null check (char_length(btrim(title)) between 1 and 80),  -- ex. « Maman »
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index care_files_owner on public.care_files (owner_id);

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
create index care_file_members_invited_by on public.care_file_members (invited_by);

-- Invitation liée à une adresse : le lien ne fonctionne que pour le compte de cette adresse.
-- Seule l'empreinte du jeton est stockée.
create table public.care_file_invitations (
    id           uuid primary key default gen_random_uuid(),
    care_file_id uuid not null references public.care_files (id) on delete cascade,
    email        text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    role         public.member_role not null check (role <> 'primary_caregiver'),
    access_level public.access_level not null check (access_level <> 'owner'),
    token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
    invited_by   uuid not null references public.users (id) on delete cascade,
    created_at   timestamptz not null default now(),
    expires_at   timestamptz not null default now() + interval '7 days',
    accepted_at  timestamptz,
    accepted_by  uuid references public.users (id) on delete set null,
    revoked_at   timestamptz,
    check (role <> 'care_recipient' or access_level = 'read_only'),
    check (accepted_at is null or revoked_at is null)
);
create index care_file_invitations_file on public.care_file_invitations (care_file_id);
create index care_file_invitations_invited_by on public.care_file_invitations (invited_by);
create index care_file_invitations_accepted_by on public.care_file_invitations (accepted_by);

-- Zone « profile » : le strict nécessaire pour coordonner (année de naissance, pas la date).
create table public.care_recipients (
    care_file_id         uuid primary key references public.care_files (id) on delete cascade,
    first_name           text not null check (char_length(btrim(first_name)) between 1 and 60),
    last_name            text check (char_length(last_name) <= 60),
    birth_year           smallint check (birth_year between 1900 and 2100),
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
create index care_needs_updated_by on public.care_needs (updated_by);

-- Zone « coordination » : CLSC, travailleuse sociale, médecin, pharmacie, notaire…
create table public.contacts (
    id           uuid primary key default gen_random_uuid(),
    care_file_id uuid not null references public.care_files (id) on delete cascade,
    kind         public.contact_kind not null,
    name         text not null check (char_length(btrim(name)) between 1 and 120),
    organization text check (char_length(organization) <= 120),
    phone        text check (char_length(phone) <= 40),
    email        text check (char_length(email) <= 254),
    address      text check (char_length(address) <= 240),
    notes        text check (char_length(notes) <= 1000),
    created_by   uuid references public.users (id) on delete set null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique (id, care_file_id)
);
create index contacts_file on public.contacts (care_file_id);
create index contacts_created_by on public.contacts (created_by);

-- Clés étrangères annoncées à l'étape 1.
alter table public.consents
    add constraint consents_care_file_fk foreign key (care_file_id) references public.care_files (id) on delete cascade;
create index consents_care_file on public.consents (care_file_id);
alter table public.ai_calls
    add constraint ai_calls_care_file_fk foreign key (care_file_id) references public.care_files (id) on delete set null;
create index ai_calls_care_file on public.ai_calls (care_file_id);

-- -----------------------------------------------------------------------------------------------------
-- Fonctions d'accès
-- -----------------------------------------------------------------------------------------------------
-- Niveau d'accès de l'utilisateur courant au dossier (null si non-membre ou intervenante sans MFA).
create function private.member_access(p_care_file_id uuid) returns public.access_level
language sql stable security definer set search_path = ''
as $$
    select m.access_level
    from public.care_file_members m
    where m.care_file_id = p_care_file_id
      and m.user_id = auth.uid()
      and (m.role <> 'relais_worker' or private.is_relais_worker())
$$;

create function private.file_consent_active(p_care_file_id uuid, p_type public.consent_type) returns boolean
language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.consents c
        where c.care_file_id = p_care_file_id and c.consent_type = p_type and c.revoked_at is null
    )
$$;

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

revoke all on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- Déclencheurs
-- -----------------------------------------------------------------------------------------------------
create trigger care_files_touch before update on public.care_files
    for each row execute function private.touch_updated_at();
create trigger care_recipients_touch before update on public.care_recipients
    for each row execute function private.touch_updated_at();
create trigger care_needs_touch before update on public.care_needs
    for each row execute function private.touch_updated_at();
create trigger contacts_touch before update on public.contacts
    for each row execute function private.touch_updated_at();

-- Auteur imposé par la base : le client ne peut pas écrire au nom d'un autre membre.
create function private.stamp_author() returns trigger
language plpgsql set search_path = ''
as $$
begin
    if tg_table_name = 'care_needs' then
        new.updated_by := auth.uid();
    elsif tg_op = 'INSERT' then
        new.created_by := auth.uid();
    else
        new.created_by := old.created_by;
    end if;
    return new;
end;
$$;
create trigger care_needs_author before insert or update on public.care_needs
    for each row execute function private.stamp_author();
create trigger contacts_author before insert or update on public.contacts
    for each row execute function private.stamp_author();

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

-- Journal automatique : arrivée, départ et changement de niveau d'un membre ; invitations.
create function private.audit_membership() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
    if tg_op = 'INSERT' then
        insert into public.access_log (actor_id, care_file_id, action, target_type, target_id, metadata)
        values (auth.uid(), new.care_file_id, 'member_joined', 'care_file_members', new.user_id,
                jsonb_build_object('role', new.role, 'access_level', new.access_level));
    elsif tg_op = 'DELETE' then
        insert into public.access_log (actor_id, care_file_id, action, target_type, target_id, metadata)
        values (auth.uid(), old.care_file_id, 'member_removed', 'care_file_members', old.user_id,
                jsonb_build_object('role', old.role));
    elsif new.access_level is distinct from old.access_level then
        insert into public.access_log (actor_id, care_file_id, action, target_type, target_id, metadata)
        values (auth.uid(), new.care_file_id, 'member_access_changed', 'care_file_members', new.user_id,
                jsonb_build_object('from', old.access_level, 'to', new.access_level));
    end if;
    return null;
end;
$$;
create trigger care_file_members_audit after insert or update or delete on public.care_file_members
    for each row execute function private.audit_membership();

create function private.audit_invitation() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
    insert into public.access_log (actor_id, care_file_id, action, target_type, target_id, metadata)
    values (auth.uid(), new.care_file_id, 'member_invited', 'care_file_invitations', new.id,
            jsonb_build_object('role', new.role, 'access_level', new.access_level));
    return null;
end;
$$;
create trigger care_file_invitations_audit after insert on public.care_file_invitations
    for each row execute function private.audit_invitation();

-- -----------------------------------------------------------------------------------------------------
-- Fonctions appelables (RPC)
-- -----------------------------------------------------------------------------------------------------
-- Création d'un dossier (après acceptation de la politique). Passe par une fonction : l'insertion
-- directe avec RETURNING échouerait, l'appartenance du créateur n'existant qu'après le déclencheur.
create function public.create_care_file(p_title text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
    v_id uuid;
begin
    if auth.uid() is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    if not private.user_consent_active('privacy_policy') then
        raise exception 'privacy policy must be accepted first' using errcode = '42501';
    end if;
    insert into public.care_files (owner_id, title) values (auth.uid(), btrim(p_title)) returning id into v_id;
    return v_id;
end;
$$;

-- Consentement de portée « dossier » (personne aidée), avec son fondement :
--   care_recipient_in_app      : la personne aidée elle-même, depuis son compte membre ;
--   care_recipient_signed_form : la personne aidée a signé le formulaire ; l'aidant principal l'enregistre ;
--   legal_representative       : mandataire (mandat homologué), tuteur ou autre représentant ; enregistré par
--                                l'aidant principal, nom du représentant obligatoire.
-- Idempotent pour une même version et un même fondement ; sinon, l'accord précédent est clos.
create function public.record_file_consent(
    p_care_file_id uuid,
    p_type public.consent_type,
    p_version text,
    p_granted_by public.consent_grantor,
    p_legal_basis public.legal_basis,
    p_representative_name text default null
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
    v_id uuid;
begin
    if auth.uid() is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    if p_type not in ('care_recipient_data', 'ai_document_processing') then
        raise exception 'not a care-file consent' using errcode = '22023';
    end if;
    if p_granted_by = 'care_recipient_in_app' then
        if not private.is_care_recipient_member(p_care_file_id) then
            raise exception 'only the care recipient can consent in the app' using errcode = '42501';
        end if;
    elsif private.member_access(p_care_file_id) is distinct from 'owner' then
        raise exception 'only the primary caregiver can record this consent' using errcode = '42501';
    end if;
    if p_granted_by = 'self'
       or (p_granted_by in ('care_recipient_in_app', 'care_recipient_signed_form') and p_legal_basis <> 'person_consents')
       or (p_granted_by = 'legal_representative'
           and (p_legal_basis = 'person_consents' or coalesce(btrim(p_representative_name), '') = '')) then
        raise exception 'inconsistent consent grantor and legal basis' using errcode = '22023';
    end if;

    -- Si la personne aidée a elle-même retiré son consentement, l'aidant ne peut pas le rétablir par un
    -- formulaire : seule la personne (dans l'application) ou un représentant légal le peut.
    if p_granted_by = 'care_recipient_signed_form' and exists (
        select 1 from (
            select c.revoked_by, c.revoked_at from public.consents c
            where c.care_file_id = p_care_file_id and c.consent_type = p_type
            order by c.granted_at desc limit 1
        ) latest
        join public.care_file_members m
          on m.care_file_id = p_care_file_id and m.user_id = latest.revoked_by and m.role = 'care_recipient'
        where latest.revoked_at is not null
    ) then
        raise exception 'the care recipient withdrew this consent' using errcode = '42501';
    end if;

    select c.id into v_id from public.consents c
    where c.care_file_id = p_care_file_id and c.consent_type = p_type and c.revoked_at is null
      and c.text_version = p_version and c.granted_by = p_granted_by and c.legal_basis = p_legal_basis;
    if found then
        return v_id;
    end if;
    update public.consents set revoked_at = now(), revoked_by = auth.uid()
    where care_file_id = p_care_file_id and consent_type = p_type and revoked_at is null;
    insert into public.consents
        (user_id, care_file_id, consent_type, text_version, granted_by, legal_basis, representative_name)
    values
        (auth.uid(), p_care_file_id, p_type, p_version, p_granted_by, p_legal_basis,
         nullif(btrim(p_representative_name), ''))
    returning id into v_id;
    return v_id;
end;
$$;

-- Retrait : ses propres consentements ; pour un dossier, l'aidant principal ou la personne aidée.
create or replace function public.revoke_consent(p_consent_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_consent public.consents%rowtype;
begin
    select * into v_consent from public.consents c where c.id = p_consent_id and c.revoked_at is null;
    if not found
       or (v_consent.care_file_id is null and v_consent.user_id is distinct from auth.uid())
       or (v_consent.care_file_id is not null
           and private.member_access(v_consent.care_file_id) is distinct from 'owner'
           and not private.is_care_recipient_member(v_consent.care_file_id)) then
        raise exception 'consent not found or not revocable by this user' using errcode = '42501';
    end if;
    if v_consent.consent_type = 'privacy_policy' then
        raise exception 'privacy_policy cannot be revoked; delete the account instead' using errcode = '22023';
    end if;
    update public.consents set revoked_at = now(), revoked_by = auth.uid() where id = p_consent_id;
end;
$$;

-- Invitation : renvoie le jeton en clair une seule fois (le lien est partagé par l'aidant).
-- Une invitation en attente pour la même adresse est remplacée.
create function public.create_invitation(
    p_care_file_id uuid, p_email text, p_role public.member_role, p_access_level public.access_level
) returns text
language plpgsql security definer set search_path = ''
as $$
declare
    v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    v_email text := lower(btrim(p_email));
begin
    if not private.can_write(p_care_file_id, 'manage') then
        raise exception 'only the primary caregiver can invite' using errcode = '42501';
    end if;
    if exists (
        select 1 from public.care_file_members m join auth.users a on a.id = m.user_id
        where m.care_file_id = p_care_file_id and lower(a.email) = v_email
    ) then
        raise exception 'already a member of this care file' using errcode = '23505';
    end if;
    update public.care_file_invitations set revoked_at = now()
    where care_file_id = p_care_file_id and email = v_email and accepted_at is null and revoked_at is null;
    insert into public.care_file_invitations (care_file_id, email, role, access_level, token_hash, invited_by)
    values (p_care_file_id, v_email, p_role, p_access_level, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid());
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
    where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
    for update;
    if not found or v_inv.accepted_at is not null or v_inv.revoked_at is not null or v_inv.expires_at < now() then
        raise exception 'invitation invalid or expired' using errcode = '22023';
    end if;
    if v_inv.email <> lower(coalesce(auth.jwt() ->> 'email', '')) then
        raise exception 'invitation was sent to another address' using errcode = '42501';
    end if;
    if exists (select 1 from public.care_file_members where care_file_id = v_inv.care_file_id and user_id = auth.uid()) then
        raise exception 'already a member of this care file' using errcode = '23505';
    end if;
    insert into public.care_file_members (care_file_id, user_id, role, access_level, invited_by)
    values (v_inv.care_file_id, auth.uid(), v_inv.role, v_inv.access_level, v_inv.invited_by);
    update public.care_file_invitations set accepted_at = now(), accepted_by = auth.uid() where id = v_inv.id;
    return v_inv.care_file_id;
end;
$$;

-- Lectures notées par l'interface (ouverture du dossier, consultation, impression, export).
create function public.log_access(
    p_care_file_id uuid, p_action public.access_action, p_target_type text default null, p_target_id uuid default null
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
    if p_action not in ('file_opened', 'extraction_viewed', 'prep_sheet_printed') then
        raise exception 'action % cannot be logged by clients', p_action using errcode = '22023';
    end if;
    if not private.can_read(p_care_file_id, 'profile') then
        raise exception 'no access to this care file' using errcode = '42501';
    end if;
    insert into public.access_log (actor_id, care_file_id, action, target_type, target_id)
    values (auth.uid(), p_care_file_id, p_action, p_target_type, p_target_id);
end;
$$;

-- Droit d'accès et portabilité pour le dossier (aidant principal) : tout le dossier en JSON structuré.
create function public.export_care_file(p_care_file_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_export jsonb;
begin
    if not private.can_write(p_care_file_id, 'manage') then
        raise exception 'only the primary caregiver can export the care file' using errcode = '42501';
    end if;
    select jsonb_build_object(
        'format', 'relais-dossier/1',
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

-- Suppression d'un dossier par l'aidant principal : tout est effacé par cascade ; le journal du dossier
-- est purgé et ne garde que la trace de la suppression (acteur, date, nombres d'éléments).
-- (Étape 3 : la fonction serveur `delete-care-file` efface d'abord les fichiers dans Storage.)
create function public.delete_care_file(p_care_file_id uuid) returns jsonb
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
        'consents', (select count(*) from public.consents where care_file_id = p_care_file_id)
    ) into v_counts;

    delete from public.care_files where id = p_care_file_id;           -- cascade sur les tables liées
    delete from public.access_log where care_file_id = p_care_file_id;  -- y compris les entrées de la cascade
    insert into public.access_log (actor_id, care_file_id, action, target_type, metadata)
    values (v_actor, p_care_file_id, 'care_file_deleted', 'care_files', v_counts);
    return v_counts;
end;
$$;

-- Suppression du compte : refusée tant que la personne est aidante principale d'un dossier.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    if exists (select 1 from public.care_files where owner_id = v_uid) then
        raise exception 'delete your care files first' using errcode = '55006';
    end if;
    insert into public.access_log (actor_id, action, target_type) values (v_uid, 'account_deleted', 'account');
    delete from auth.users where id = v_uid;
end;
$$;

-- Export personnel : ajoute les dossiers dont la personne est membre.
create or replace function public.export_my_data() returns jsonb
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
        'memberships', coalesce((
            select jsonb_agg(jsonb_build_object(
                'care_file_id', m.care_file_id, 'title', f.title, 'role', m.role,
                'access_level', m.access_level, 'joined_at', m.joined_at)
                order by m.joined_at)
            from public.care_file_members m join public.care_files f on f.id = m.care_file_id
            where m.user_id = v_uid), '[]'::jsonb),
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

do $$
declare
    fn text;
begin
    foreach fn in array array[
        'public.create_care_file(text)',
        'public.record_file_consent(uuid,public.consent_type,text,public.consent_grantor,public.legal_basis,text)',
        'public.create_invitation(uuid,text,public.member_role,public.access_level)',
        'public.accept_invitation(text)',
        'public.log_access(uuid,public.access_action,text,uuid)',
        'public.export_care_file(uuid)',
        'public.delete_care_file(uuid)'
    ] loop
        execute format('revoke all on function %s from public, anon', fn);
        execute format('grant execute on function %s to authenticated', fn);
    end loop;
end;
$$;

-- -----------------------------------------------------------------------------------------------------
-- Privilèges
-- -----------------------------------------------------------------------------------------------------
revoke all on public.care_files, public.care_file_members, public.care_file_invitations,
    public.care_recipients, public.care_needs, public.contacts from anon, authenticated;
grant all on public.care_files, public.care_file_members, public.care_file_invitations,
    public.care_recipients, public.care_needs, public.contacts to service_role;

grant select on public.care_files to authenticated;               -- création et suppression par RPC
grant update (title) on public.care_files to authenticated;
grant select, delete on public.care_file_members to authenticated;  -- arrivée par invitation (RPC)
grant update (access_level) on public.care_file_members to authenticated;
grant select on public.care_file_invitations to authenticated;      -- création par RPC
grant update (revoked_at) on public.care_file_invitations to authenticated;
grant select, insert, update, delete on public.care_recipients, public.care_needs, public.contacts to authenticated;

-- -----------------------------------------------------------------------------------------------------
-- Politiques RLS
-- -----------------------------------------------------------------------------------------------------
alter table public.care_files enable row level security;
alter table public.care_file_members enable row level security;
alter table public.care_file_invitations enable row level security;
alter table public.care_recipients enable row level security;
alter table public.care_needs enable row level security;
alter table public.contacts enable row level security;

-- Tables de dossier au CRUD uniforme : (table, zone).
do $$
declare
    r record;
begin
    for r in select * from (values
        ('care_recipients', 'profile'),
        ('care_needs', 'health'),
        ('contacts', 'coordination')
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

create policy care_files_select on public.care_files for select to authenticated
    using (private.can_read(id, 'profile'));
create policy care_files_update on public.care_files for update to authenticated
    using (private.can_write(id, 'manage')) with check (private.can_write(id, 'manage'));

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

-- Politiques de l'étape 1 élargies aux dossiers partagés.
drop policy users_select on public.users;
create policy users_select on public.users for select to authenticated
    using (id = (select auth.uid()) or private.shares_care_file(id));

drop policy consents_select on public.consents;
create policy consents_select on public.consents for select to authenticated
    using (
        (care_file_id is null and user_id = (select auth.uid()))
        or (care_file_id is not null and private.can_read(care_file_id, 'profile'))
    );

drop policy access_log_select on public.access_log;
create policy access_log_select on public.access_log for select to authenticated
    using (actor_id = (select auth.uid()) or private.can_read(care_file_id, 'manage'));
