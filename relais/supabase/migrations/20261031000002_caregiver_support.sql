-- =====================================================================================================
-- Relais — étape 6 (2/2) : charge de l'aidant, demandes d'intervenante, mesures du pilote.
--
-- caregiver_checkins     bilan de la semaine (3 réponses de 1 à 5). PRIVÉ : son auteur seulement, ni la
--                        famille, ni les intervenantes, ni l'admin. Gardé seulement avec le consentement
--                        distinct « caregiver_checkin » ; effacé quand ce consentement est retiré.
-- support_requests       « Parler à une intervenante » : le demandeur voit les siennes ; les intervenantes
--                        (MFA) voient le tableau de suivi. Avis aux intervenantes par courriel sans contenu.
-- support_request_notes  notes internes des intervenantes (invisibles au demandeur).
-- pilot_feedback         2 questions par semaine (consentement « pilot_evaluation »), jamais lues une à
--                        une : l'admin ne voit que des agrégats (pilot_metrics), masqués sous 3 répondants.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------------------------------
create type public.support_origin as enum ('button', 'distress_screen', 'checkin');
create type public.support_status as enum ('new', 'assigned', 'closed');

-- -----------------------------------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------------------------------
create table public.caregiver_checkins (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references public.users (id) on delete cascade,
    week_start date not null check (extract(isodow from week_start) = 1),
    fatigue    smallint not null check (fatigue between 1 and 5),
    overwhelm  smallint not null check (overwhelm between 1 and 5),
    isolation  smallint not null check (isolation between 1 and 5),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, week_start)
);

create table public.support_requests (
    id                 uuid primary key default gen_random_uuid(),
    requester_id       uuid not null references public.users (id) on delete cascade,
    care_file_id       uuid references public.care_files (id) on delete set null,
    origin             public.support_origin not null,
    contact_name       text not null check (char_length(btrim(contact_name)) between 1 and 80),
    preferred_contact  text not null check (preferred_contact in ('phone', 'email')),
    phone              text check (char_length(phone) <= 40),
    email              text check (char_length(email) <= 254),  -- adresse du compte, copiée si choisie
    preferred_times    text check (char_length(preferred_times) <= 240),
    message            text check (char_length(message) <= 2000),
    status             public.support_status not null default 'new',
    assigned_worker_id uuid references public.users (id) on delete set null,
    assigned_at        timestamptz,
    closed_at          timestamptz,
    closed_by          uuid references public.users (id) on delete set null,
    notified_at        timestamptz,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    check (preferred_contact <> 'phone' or coalesce(char_length(btrim(phone)), 0) >= 7),
    check (status <> 'assigned' or assigned_worker_id is not null),
    check ((status = 'closed') = (closed_at is not null))
);
create index support_requests_status on public.support_requests (status, created_at);
create index support_requests_requester on public.support_requests (requester_id);
create index support_requests_file on public.support_requests (care_file_id);
create index support_requests_worker on public.support_requests (assigned_worker_id);
create index support_requests_closed_by on public.support_requests (closed_by);

create table public.support_request_notes (
    id                 uuid primary key default gen_random_uuid(),
    support_request_id uuid not null references public.support_requests (id) on delete cascade,
    author_id          uuid references public.users (id) on delete set null,
    body               text not null check (char_length(btrim(body)) between 1 and 2000),
    created_at         timestamptz not null default now()
);
create index support_request_notes_request on public.support_request_notes (support_request_id, created_at);
create index support_request_notes_author on public.support_request_notes (author_id);

create table public.pilot_feedback (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references public.users (id) on delete cascade,
    week_start   date not null check (extract(isodow from week_start) = 1),
    hours_saved  numeric(3, 1) check (hours_saved between 0 and 80 and hours_saved * 2 = trunc(hours_saved * 2)),
    satisfaction smallint check (satisfaction between 1 and 5),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique (user_id, week_start),
    check (hours_saved is not null or satisfaction is not null)
);

-- -----------------------------------------------------------------------------------------------------
-- Déclencheurs
-- -----------------------------------------------------------------------------------------------------
-- Bilan et évaluation : toujours au nom de la personne connectée.
create function private.own_row() returns trigger
language plpgsql set search_path = ''
as $$
begin
    new.user_id := case when tg_op = 'INSERT' then auth.uid() else old.user_id end;
    if tg_op = 'UPDATE' then
        new.created_at := old.created_at;
        new.updated_at := now();
    end if;
    return new;
end;
$$;
create trigger caregiver_checkins_owner before insert or update on public.caregiver_checkins
    for each row execute function private.own_row();
create trigger pilot_feedback_owner before insert or update on public.pilot_feedback
    for each row execute function private.own_row();

-- Consentement retiré (et non remplacé par une nouvelle version) : les réponses gardées sont effacées.
-- Vérifié à la fin de la transaction, car grant_consent clôt l'ancienne version avant d'insérer la nouvelle.
create function private.purge_after_consent_withdrawal() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
    if new.revoked_at is null or old.revoked_at is not null or new.care_file_id is not null then
        return null;
    end if;
    if exists (
        select 1 from public.consents c
        where c.user_id = new.user_id and c.consent_type = new.consent_type and c.care_file_id is null and c.revoked_at is null
    ) then
        return null;
    end if;
    if new.consent_type = 'caregiver_checkin' then
        delete from public.caregiver_checkins where user_id = new.user_id;
    elsif new.consent_type = 'pilot_evaluation' then
        delete from public.pilot_feedback where user_id = new.user_id;
    end if;
    return null;
end;
$$;
create constraint trigger consents_purge_on_withdrawal after update of revoked_at on public.consents
    deferrable initially deferred
    for each row execute function private.purge_after_consent_withdrawal();

-- Demande : au nom de la personne connectée, état initial imposé, adresse du compte copiée si choisie.
create function private.support_request_defaults() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
    new.requester_id := auth.uid();
    new.status := 'new';
    new.assigned_worker_id := null;
    new.assigned_at := null;
    new.closed_at := null;
    new.closed_by := null;
    new.notified_at := null;
    new.contact_name := btrim(new.contact_name);
    new.email := case when new.preferred_contact = 'email' then (select u.email::text from auth.users u where u.id = auth.uid()) end;
    if new.preferred_contact = 'email' and new.email is null then
        raise exception 'no email address on the account' using errcode = '22023';
    end if;
    return new;
end;
$$;
create trigger support_requests_defaults before insert on public.support_requests
    for each row execute function private.support_request_defaults();

-- Suivi par les intervenantes : une intervenante ne prend une demande que pour elle-même ; dates tenues
-- par la base.
create function private.support_request_transitions() returns trigger
language plpgsql set search_path = ''
as $$
begin
    if new.assigned_worker_id is distinct from old.assigned_worker_id
       and new.assigned_worker_id is not null and new.assigned_worker_id <> auth.uid() then
        raise exception 'a worker can only take a request for herself' using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
        if new.status = 'new' then
            raise exception 'a request cannot go back to new' using errcode = '22023';
        end if;
        if new.status = 'assigned' then
            new.assigned_worker_id := coalesce(new.assigned_worker_id, auth.uid());
            new.closed_at := null;
            new.closed_by := null;
        elsif new.status = 'closed' then
            new.closed_at := now();
            new.closed_by := auth.uid();
        end if;
    end if;
    if new.assigned_worker_id is distinct from old.assigned_worker_id then
        new.assigned_at := case when new.assigned_worker_id is not null then now() end;
    end if;
    new.updated_at := now();
    return new;
end;
$$;
create trigger support_requests_transitions before update on public.support_requests
    for each row execute function private.support_request_transitions();

create function private.support_note_author() returns trigger
language plpgsql set search_path = ''
as $$
begin
    new.author_id := auth.uid();
    new.created_at := now();
    return new;
end;
$$;
create trigger support_request_notes_author before insert on public.support_request_notes
    for each row execute function private.support_note_author();

-- -----------------------------------------------------------------------------------------------------
-- RPC
-- -----------------------------------------------------------------------------------------------------
-- Le demandeur peut retirer sa demande (« je n'en ai plus besoin »).
create function public.cancel_support_request(p_request_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
    update public.support_requests
    set status = 'closed', closed_at = now(), closed_by = auth.uid(), updated_at = now()
    where id = p_request_id and requester_id = auth.uid() and status <> 'closed';
    if not found then
        raise exception 'request not found or already closed' using errcode = '22023';
    end if;
end;
$$;

-- Serveur seulement : réserve l'avis d'une nouvelle demande (une seule fois) et donne les adresses des
-- intervenantes. Aucun contenu de la demande n'est renvoyé : seulement son origine.
create function public.claim_support_notification(p_request_id uuid, p_requester uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_origin public.support_origin;
begin
    update public.support_requests set notified_at = now()
    where id = p_request_id and requester_id = p_requester and notified_at is null
    returning origin into v_origin;
    if not found then
        return null;
    end if;
    return jsonb_build_object(
        'origin', v_origin,
        'emails', coalesce((
            select jsonb_agg(a.email::text order by a.email)
            from public.users u join auth.users a on a.id = u.id
            where u.app_role = 'relais_worker' and a.email is not null), '[]'::jsonb));
end;
$$;

-- Admin (MFA) seulement : mesures du pilote, en agrégats. Réponses hebdomadaires masquées sous 3
-- répondants ; programmes comptés seulement dans les dossiers dont l'aidante principale a accepté
-- l'évaluation du pilote (sans lire le contenu) ; rien du bilan de la semaine.
create function public.pilot_metrics() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
    v_min integer := 3;
    v_result jsonb;
begin
    if not private.is_admin() then
        raise exception 'admin only' using errcode = '42501';
    end if;
    with consenting as (
        select distinct c.user_id from public.consents c
        where c.consent_type = 'pilot_evaluation' and c.care_file_id is null and c.revoked_at is null
    ),
    feedback as (
        select f.* from public.pilot_feedback f join consenting using (user_id)
    ),
    weeks as (
        select f.week_start, count(distinct f.user_id) as respondents,
               avg(f.hours_saved) as hours_avg, avg(f.satisfaction) as satisfaction_avg
        from feedback f group by f.week_start
    ),
    file_programs as (
        select p.* from public.care_file_programs p
        join public.care_files f on f.id = p.care_file_id
        join consenting c on c.user_id = f.owner_id
    )
    select jsonb_build_object(
        'generated_at', now(),
        'minimum_respondents', v_min,
        'participation', jsonb_build_object(
            'care_files', (select count(*) from public.care_files),
            'members', (select count(distinct user_id) from public.care_file_members where role <> 'relais_worker'),
            'pilot_consents', (select count(*) from consenting)),
        'feedback', (
            select case when count(distinct f.user_id) < v_min
                then jsonb_build_object('respondents', count(distinct f.user_id), 'suppressed', true)
                else jsonb_build_object(
                    'respondents', count(distinct f.user_id),
                    'responses', count(*),
                    'suppressed', false,
                    'hours_saved_avg', round(avg(f.hours_saved), 1),
                    'satisfaction_avg', round(avg(f.satisfaction), 1),
                    'satisfaction', jsonb_build_object(
                        '1', count(*) filter (where f.satisfaction = 1), '2', count(*) filter (where f.satisfaction = 2),
                        '3', count(*) filter (where f.satisfaction = 3), '4', count(*) filter (where f.satisfaction = 4),
                        '5', count(*) filter (where f.satisfaction = 5)))
                end
            from feedback f),
        'feedback_by_week', coalesce((
            select jsonb_agg(case when w.respondents < v_min
                then jsonb_build_object('week_start', w.week_start, 'respondents', w.respondents, 'suppressed', true)
                else jsonb_build_object('week_start', w.week_start, 'respondents', w.respondents, 'suppressed', false,
                    'hours_saved_avg', round(w.hours_avg, 1), 'satisfaction_avg', round(w.satisfaction_avg, 1))
                end order by w.week_start)
            from weeks w), '[]'::jsonb),
        'programs', (
            select jsonb_build_object(
                'files', count(distinct p.care_file_id),
                'identified', count(*),
                'requested', count(*) filter (where p.requested_at is not null),
                'obtained', count(*) filter (where p.status = 'obtained'),
                'refused', count(*) filter (where p.status = 'refused'),
                'median_days_to_request', round((percentile_cont(0.5) within group (
                    order by extract(epoch from p.requested_at - p.identified_at) / 86400)
                    filter (where p.requested_at is not null))::numeric, 1))
            from file_programs p),
        'support', (
            select jsonb_build_object(
                'total', count(*),
                'new', count(*) filter (where s.status = 'new'),
                'assigned', count(*) filter (where s.status = 'assigned'),
                'closed', count(*) filter (where s.status = 'closed'),
                'from_button', count(*) filter (where s.origin = 'button'),
                'from_distress_screen', count(*) filter (where s.origin = 'distress_screen'),
                'from_checkin', count(*) filter (where s.origin = 'checkin'),
                'median_hours_to_assignment', round((percentile_cont(0.5) within group (
                    order by extract(epoch from s.assigned_at - s.created_at) / 3600)
                    filter (where s.assigned_at is not null))::numeric, 1))
            from public.support_requests s)
    ) into v_result;
    return v_result;
end;
$$;

-- Export personnel : ajoute le bilan gardé, les réponses d'évaluation et les demandes d'intervenante
-- (sans les notes internes des intervenantes).
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
        'format', 'relais-export/2',
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
        'reminder_emails', coalesce((
            select jsonb_agg(jsonb_build_object(
                'sent_on', d.sent_on, 'task_count', d.task_count, 'appointment_count', d.appointment_count)
                order by d.sent_on)
            from public.reminder_deliveries d where d.user_id = v_uid), '[]'::jsonb),
        'caregiver_checkins', coalesce((
            select jsonb_agg(jsonb_build_object(
                'week_start', k.week_start, 'fatigue', k.fatigue, 'overwhelm', k.overwhelm, 'isolation', k.isolation)
                order by k.week_start)
            from public.caregiver_checkins k where k.user_id = v_uid), '[]'::jsonb),
        'pilot_feedback', coalesce((
            select jsonb_agg(jsonb_build_object(
                'week_start', p.week_start, 'hours_saved', p.hours_saved, 'satisfaction', p.satisfaction)
                order by p.week_start)
            from public.pilot_feedback p where p.user_id = v_uid), '[]'::jsonb),
        'support_requests', coalesce((
            select jsonb_agg(jsonb_build_object(
                'created_at', s.created_at, 'origin', s.origin, 'contact_name', s.contact_name,
                'preferred_contact', s.preferred_contact, 'phone', s.phone, 'email', s.email,
                'preferred_times', s.preferred_times, 'message', s.message, 'status', s.status,
                'closed_at', s.closed_at)
                order by s.created_at)
            from public.support_requests s where s.requester_id = v_uid), '[]'::jsonb),
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
    foreach fn in array array['public.cancel_support_request(uuid)', 'public.pilot_metrics()'] loop
        execute format('revoke all on function %s from public, anon', fn);
        execute format('grant execute on function %s to authenticated', fn);
    end loop;
    execute 'revoke all on function public.claim_support_notification(uuid,uuid) from public, anon, authenticated';
    execute 'grant execute on function public.claim_support_notification(uuid,uuid) to service_role';
end;
$$;
revoke all on function private.own_row(), private.purge_after_consent_withdrawal(), private.support_request_defaults(),
    private.support_request_transitions(), private.support_note_author() from public;

-- -----------------------------------------------------------------------------------------------------
-- Privilèges
-- -----------------------------------------------------------------------------------------------------
revoke all on public.caregiver_checkins, public.support_requests, public.support_request_notes, public.pilot_feedback
    from anon, authenticated;
grant all on public.caregiver_checkins, public.support_requests, public.support_request_notes, public.pilot_feedback
    to service_role;

grant select, insert, delete on public.caregiver_checkins to authenticated;
grant update (fatigue, overwhelm, isolation) on public.caregiver_checkins to authenticated;
grant select, insert, delete on public.pilot_feedback to authenticated;
grant update (hours_saved, satisfaction) on public.pilot_feedback to authenticated;
grant select on public.support_requests to authenticated;
grant insert (care_file_id, origin, contact_name, preferred_contact, phone, preferred_times, message)
    on public.support_requests to authenticated;
grant update (status, assigned_worker_id) on public.support_requests to authenticated;  -- RLS : intervenantes
grant select, insert on public.support_request_notes to authenticated;                  -- RLS : intervenantes

-- -----------------------------------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------------------------------
alter table public.caregiver_checkins enable row level security;
alter table public.support_requests enable row level security;
alter table public.support_request_notes enable row level security;
alter table public.pilot_feedback enable row level security;

-- Bilan : son auteur seulement, et seulement avec le consentement « caregiver_checkin ».
create policy caregiver_checkins_select on public.caregiver_checkins for select to authenticated
    using (user_id = (select auth.uid()));
create policy caregiver_checkins_insert on public.caregiver_checkins for insert to authenticated
    with check (private.user_consent_active('caregiver_checkin'));
create policy caregiver_checkins_update on public.caregiver_checkins for update to authenticated
    using (user_id = (select auth.uid())) with check (private.user_consent_active('caregiver_checkin'));
create policy caregiver_checkins_delete on public.caregiver_checkins for delete to authenticated
    using (user_id = (select auth.uid()));

-- Évaluation du pilote : son auteur seulement (l'admin ne voit que pilot_metrics).
create policy pilot_feedback_select on public.pilot_feedback for select to authenticated
    using (user_id = (select auth.uid()));
create policy pilot_feedback_insert on public.pilot_feedback for insert to authenticated
    with check (private.user_consent_active('pilot_evaluation'));
create policy pilot_feedback_update on public.pilot_feedback for update to authenticated
    using (user_id = (select auth.uid())) with check (private.user_consent_active('pilot_evaluation'));
create policy pilot_feedback_delete on public.pilot_feedback for delete to authenticated
    using (user_id = (select auth.uid()));

-- Demandes : le demandeur voit les siennes ; les intervenantes (rôle + MFA) voient et suivent toutes les
-- demandes. Un dossier n'est mentionné que par l'un de ses membres.
create policy support_requests_select on public.support_requests for select to authenticated
    using (requester_id = (select auth.uid()) or private.is_relais_worker());
create policy support_requests_insert on public.support_requests for insert to authenticated
    with check (care_file_id is null or private.member_access(care_file_id) is not null);
create policy support_requests_update on public.support_requests for update to authenticated
    using (private.is_relais_worker()) with check (private.is_relais_worker());

create policy support_request_notes_select on public.support_request_notes for select to authenticated
    using (private.is_relais_worker());
create policy support_request_notes_insert on public.support_request_notes for insert to authenticated
    with check (private.is_relais_worker());
