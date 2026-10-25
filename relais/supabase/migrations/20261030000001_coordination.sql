-- =====================================================================================================
-- Relais — étape 5 : coordination et rendez-vous.
--
-- Tables : tasks (tâches partagées, zone « coordination »), appointments (agenda, zone « coordination »),
--          appointment_questions (questions à poser, zone « santé »), journal_entries (carnet de bord, zone
--          « santé » : les observations du quotidien sont des renseignements de santé), reminder_deliveries
--          (au plus un courriel de rappel par personne et par jour).
-- Rappels : la fonction serveur send-reminders (planifiée, voir supabase/cron/) ne lit que des NOMBRES
-- (reminders_due) : aucun titre, aucun nom, aucun renseignement de santé ne sort de la base.
-- La page « Préparer un rendez-vous » est construite sur le téléphone à partir du dossier, sans IA.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------------------------------
create type public.task_status as enum ('todo', 'done');

-- -----------------------------------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------------------------------
create table public.tasks (
    id                   uuid primary key default gen_random_uuid(),
    care_file_id         uuid not null references public.care_files (id) on delete cascade,
    title                text not null check (char_length(btrim(title)) between 1 and 160),
    details              text check (char_length(details) <= 2000),
    assignee_id          uuid references public.users (id) on delete set null,
    due_on               date,
    status               public.task_status not null default 'todo',
    completed_at         timestamptz,
    completed_by         uuid references public.users (id) on delete set null,
    -- Origine facultative : un « à faire » d'un document, ou une démarche du navigateur de droits.
    source_document_id   uuid,
    care_file_program_id uuid,
    created_by           uuid references public.users (id) on delete set null,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now(),
    unique (id, care_file_id),
    foreign key (source_document_id, care_file_id)
        references public.documents (id, care_file_id) on delete set null (source_document_id),
    foreign key (care_file_program_id, care_file_id)
        references public.care_file_programs (id, care_file_id) on delete set null (care_file_program_id),
    check ((status = 'done') = (completed_at is not null))
);
create index tasks_file_status_due on public.tasks (care_file_id, status, due_on);
create index tasks_assignee on public.tasks (assignee_id);
create index tasks_completed_by on public.tasks (completed_by);
create index tasks_created_by on public.tasks (created_by);
create index tasks_document on public.tasks (source_document_id, care_file_id);
create index tasks_program on public.tasks (care_file_program_id, care_file_id);

create table public.appointments (
    id                 uuid primary key default gen_random_uuid(),
    care_file_id       uuid not null references public.care_files (id) on delete cascade,
    title              text not null check (char_length(btrim(title)) between 1 and 160),
    starts_at          timestamptz not null,
    ends_at            timestamptz,
    location           text check (char_length(location) <= 240),
    contact_id         uuid,
    companion_id       uuid references public.users (id) on delete set null,  -- qui accompagne
    notes              text check (char_length(notes) <= 2000),
    source_document_id uuid,
    created_by         uuid references public.users (id) on delete set null,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    unique (id, care_file_id),
    foreign key (contact_id, care_file_id) references public.contacts (id, care_file_id) on delete set null (contact_id),
    foreign key (source_document_id, care_file_id)
        references public.documents (id, care_file_id) on delete set null (source_document_id),
    check (ends_at is null or ends_at > starts_at)
);
create index appointments_file_start on public.appointments (care_file_id, starts_at);
create index appointments_starts on public.appointments (starts_at);
create index appointments_companion on public.appointments (companion_id);
create index appointments_created_by on public.appointments (created_by);
create index appointments_contact on public.appointments (contact_id, care_file_id);
create index appointments_document on public.appointments (source_document_id, care_file_id);

-- Questions que la famille veut poser pendant le rendez-vous (page « Préparer un rendez-vous »).
create table public.appointment_questions (
    id             uuid primary key default gen_random_uuid(),
    appointment_id uuid not null,
    care_file_id   uuid not null references public.care_files (id) on delete cascade,
    question       text not null check (char_length(btrim(question)) between 1 and 500),
    position       smallint not null default 0,
    created_by     uuid references public.users (id) on delete set null,
    created_at     timestamptz not null default now(),
    foreign key (appointment_id, care_file_id) references public.appointments (id, care_file_id) on delete cascade
);
create index appointment_questions_appointment on public.appointment_questions (appointment_id, care_file_id, position);
create index appointment_questions_file on public.appointment_questions (care_file_id);
create index appointment_questions_created_by on public.appointment_questions (created_by);

-- Carnet de bord : notes datées des membres (visites, humeur, sommeil…). Zone « santé ».
create table public.journal_entries (
    id           uuid primary key default gen_random_uuid(),
    care_file_id uuid not null references public.care_files (id) on delete cascade,
    author_id    uuid references public.users (id) on delete set null,
    body         text not null check (char_length(btrim(body)) between 1 and 4000),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create index journal_entries_file on public.journal_entries (care_file_id, created_at desc);
create index journal_entries_author on public.journal_entries (author_id);

-- Un courriel de rappel par personne et par jour, au plus. Seulement des nombres.
create table public.reminder_deliveries (
    user_id           uuid not null references public.users (id) on delete cascade,
    sent_on           date not null,
    task_count        smallint not null check (task_count >= 0),
    appointment_count smallint not null check (appointment_count >= 0),
    sent_at           timestamptz not null default now(),
    primary key (user_id, sent_on)
);

-- -----------------------------------------------------------------------------------------------------
-- Déclencheurs
-- -----------------------------------------------------------------------------------------------------
create trigger tasks_touch before update on public.tasks
    for each row execute function private.touch_updated_at();
create trigger tasks_author before insert or update on public.tasks
    for each row execute function private.stamp_author();
create trigger appointments_touch before update on public.appointments
    for each row execute function private.touch_updated_at();
create trigger appointments_author before insert or update on public.appointments
    for each row execute function private.stamp_author();
create trigger appointment_questions_author before insert or update on public.appointment_questions
    for each row execute function private.stamp_author();
create trigger journal_entries_touch before update on public.journal_entries
    for each row execute function private.touch_updated_at();

-- Auteur d'une note du carnet : toujours la personne connectée, jamais modifiable.
create function private.journal_author() returns trigger
language plpgsql set search_path = ''
as $$
begin
    new.author_id := case when tg_op = 'INSERT' then auth.uid() else old.author_id end;
    if tg_op = 'UPDATE' then
        new.created_at := old.created_at;
    end if;
    return new;
end;
$$;
create trigger journal_entries_author before insert or update on public.journal_entries
    for each row execute function private.journal_author();

-- Tâche faite : qui et quand, tenus par la base.
create function private.task_completion() returns trigger
language plpgsql set search_path = ''
as $$
begin
    if tg_op = 'INSERT' or new.status is distinct from old.status then
        new.completed_at := case when new.status = 'done' then now() end;
        new.completed_by := case when new.status = 'done' then auth.uid() end;
    else
        new.completed_at := old.completed_at;
        new.completed_by := old.completed_by;
    end if;
    return new;
end;
$$;
create trigger tasks_completion before insert or update on public.tasks
    for each row execute function private.task_completion();

-- Responsable d'une tâche et accompagnateur d'un rendez-vous : membres du dossier seulement.
create function private.check_assignee_is_member() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
    v_user uuid;
begin
    if tg_table_name = 'tasks' then
        v_user := new.assignee_id;
    else
        v_user := new.companion_id;
    end if;
    if v_user is not null and not exists (
        select 1 from public.care_file_members m where m.care_file_id = new.care_file_id and m.user_id = v_user
    ) then
        raise exception 'assignee must be a member of the care file' using errcode = '23514';
    end if;
    return new;
end;
$$;
create trigger tasks_check_assignee before insert or update of assignee_id on public.tasks
    for each row execute function private.check_assignee_is_member();
create trigger appointments_check_companion before insert or update of companion_id on public.appointments
    for each row execute function private.check_assignee_is_member();

-- Un membre retiré du dossier n'est plus responsable de ses tâches ni accompagnateur.
-- (Pendant la suppression du dossier entier, rien à faire : les lignes partent avec lui.)
create function private.unassign_former_member() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
    if exists (select 1 from public.care_files f where f.id = old.care_file_id) then
        update public.tasks set assignee_id = null
        where care_file_id = old.care_file_id and assignee_id = old.user_id;
        update public.appointments set companion_id = null
        where care_file_id = old.care_file_id and companion_id = old.user_id;
    end if;
    return null;
end;
$$;
create trigger care_file_members_unassign after delete on public.care_file_members
    for each row execute function private.unassign_former_member();

-- -----------------------------------------------------------------------------------------------------
-- Rappels quotidiens (fonction serveur seulement)
-- -----------------------------------------------------------------------------------------------------
-- Pour un jour donné (heure du Québec), les personnes qui ont accepté les rappels par courriel et qui
-- n'en ont pas encore reçu, avec seulement des NOMBRES :
--   tâches : à faire, confiées à la personne, échues ou dues d'ici le lendemain ;
--   rendez-vous : aujourd'hui ou demain, si la personne accompagne (ou, sans accompagnateur, si elle est
--   l'aidante principale).
create function public.reminders_due(p_day date)
returns table (user_id uuid, email text, task_count integer, appointment_count integer)
language sql stable security definer set search_path = ''
as $$
    with recipients as (
        select c.user_id
        from public.consents c
        where c.consent_type = 'email_reminders' and c.care_file_id is null and c.revoked_at is null
          and not exists (select 1 from public.reminder_deliveries d where d.user_id = c.user_id and d.sent_on = p_day)
    ),
    task_counts as (
        select t.assignee_id as user_id, count(*)::integer as n
        from public.tasks t
        where t.status = 'todo' and t.due_on is not null and t.due_on <= p_day + 1
          and t.assignee_id in (select r.user_id from recipients r)
        group by t.assignee_id
    ),
    appointment_counts as (
        select m.user_id, count(*)::integer as n
        from public.appointments a
        join public.care_file_members m on m.care_file_id = a.care_file_id
        where a.starts_at >= (p_day::timestamp at time zone 'America/Toronto')
          and a.starts_at < ((p_day + 2)::timestamp at time zone 'America/Toronto')
          and (a.companion_id = m.user_id or (a.companion_id is null and m.access_level = 'owner'))
          and m.user_id in (select r.user_id from recipients r)
        group by m.user_id
    )
    select r.user_id, u.email::text, coalesce(t.n, 0), coalesce(a.n, 0)
    from recipients r
    join auth.users u on u.id = r.user_id
    left join task_counts t on t.user_id = r.user_id
    left join appointment_counts a on a.user_id = r.user_id
    where coalesce(t.n, 0) + coalesce(a.n, 0) > 0 and u.email is not null
    order by r.user_id
$$;

create function public.record_reminder_sent(p_user_id uuid, p_day date, p_task_count integer, p_appointment_count integer)
returns void
language sql security definer set search_path = ''
as $$
    insert into public.reminder_deliveries (user_id, sent_on, task_count, appointment_count)
    values (p_user_id, p_day, p_task_count, p_appointment_count)
    on conflict do nothing
$$;

-- -----------------------------------------------------------------------------------------------------
-- Suppression et export : étendus à la coordination
-- -----------------------------------------------------------------------------------------------------
create or replace function public.delete_care_file(p_care_file_id uuid) returns jsonb
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
        'consents', (select count(*) from public.consents where care_file_id = p_care_file_id),
        'documents', (select count(*) from public.documents where care_file_id = p_care_file_id),
        'extractions', (select count(*) from public.document_extractions where care_file_id = p_care_file_id),
        'medications', (select count(*) from public.medication_mentions where care_file_id = p_care_file_id),
        'timeline_events', (select count(*) from public.timeline_events where care_file_id = p_care_file_id),
        'programs', (select count(*) from public.care_file_programs where care_file_id = p_care_file_id),
        'tasks', (select count(*) from public.tasks where care_file_id = p_care_file_id),
        'appointments', (select count(*) from public.appointments where care_file_id = p_care_file_id),
        'journal_entries', (select count(*) from public.journal_entries where care_file_id = p_care_file_id)
    ) into v_counts;

    insert into public.storage_deletion_queue (bucket_id, object_path)
    select 'documents', d.storage_path from public.documents d where d.care_file_id = p_care_file_id
    on conflict do nothing;

    delete from public.care_files where id = p_care_file_id;
    delete from public.access_log where care_file_id = p_care_file_id;
    insert into public.access_log (actor_id, care_file_id, action, target_type, metadata)
    values (v_actor, p_care_file_id, 'care_file_deleted', 'care_files', v_counts);
    return v_counts;
end;
$$;

create or replace function public.export_care_file(p_care_file_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_export jsonb;
begin
    if not private.can_write(p_care_file_id, 'manage') then
        raise exception 'only the primary caregiver can export the care file' using errcode = '42501';
    end if;
    select jsonb_build_object(
        'format', 'relais-dossier/4',
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
        'documents', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', d.id, 'mime_type', d.mime_type, 'page_count', d.page_count, 'status', d.status,
                'title', d.title, 'doc_type', d.doc_type, 'doc_date', d.doc_date, 'author', d.author,
                'needs_review', d.needs_review, 'uploaded_at', d.uploaded_at,
                'confirmed', (select e.confirmed_data from public.document_extractions e
                              where e.document_id = d.id and e.status = 'confirmed'))
                order by d.uploaded_at)
            from public.documents d where d.care_file_id = p_care_file_id), '[]'::jsonb),
        'medications_as_written', coalesce((
            select jsonb_agg(jsonb_build_object(
                'name_as_written', m.name_as_written, 'dosage_as_written', m.dosage_as_written,
                'frequency_as_written', m.frequency_as_written, 'document_date', m.document_date,
                'source_document_id', m.source_document_id)
                order by m.created_at)
            from public.medication_mentions m where m.care_file_id = p_care_file_id), '[]'::jsonb),
        'timeline_events', coalesce((
            select jsonb_agg(jsonb_build_object(
                'occurred_on', t.occurred_on, 'event_type', t.event_type, 'title', t.title,
                'description', t.description, 'source_type', t.source_type,
                'source_document_id', t.source_document_id)
                order by t.occurred_on, t.created_at)
            from public.timeline_events t where t.care_file_id = p_care_file_id), '[]'::jsonb),
        'benefit_answers', (
            select a.answers from public.benefit_assessments a
            where a.care_file_id = p_care_file_id order by a.created_at desc limit 1),
        'programs', coalesce((
            select jsonb_agg(jsonb_build_object(
                'program', p.name, 'organization', p.organization, 'match_level', c.match_level,
                'status', c.status, 'notes', c.notes, 'letter_draft', c.letter_draft,
                'identified_at', c.identified_at, 'requested_at', c.requested_at, 'decided_at', c.decided_at,
                'checklist', coalesce((
                    select jsonb_agg(jsonb_build_object('label', i.label, 'is_done', i.is_done) order by i.position, i.created_at)
                    from public.program_checklist_items i where i.care_file_program_id = c.id), '[]'::jsonb))
                order by p.sort_order)
            from public.care_file_programs c join public.programs p on p.id = c.program_id
            where c.care_file_id = p_care_file_id), '[]'::jsonb),
        'tasks', coalesce((
            select jsonb_agg(jsonb_build_object(
                'title', t.title, 'details', t.details, 'assignee', u.display_name, 'due_on', t.due_on,
                'status', t.status, 'completed_at', t.completed_at, 'created_at', t.created_at,
                'source_document_id', t.source_document_id)
                order by t.created_at)
            from public.tasks t left join public.users u on u.id = t.assignee_id
            where t.care_file_id = p_care_file_id), '[]'::jsonb),
        'appointments', coalesce((
            select jsonb_agg(jsonb_build_object(
                'title', a.title, 'starts_at', a.starts_at, 'ends_at', a.ends_at, 'location', a.location,
                'contact', c.name, 'companion', u.display_name, 'notes', a.notes,
                'questions', coalesce((
                    select jsonb_agg(q.question order by q.position, q.created_at)
                    from public.appointment_questions q where q.appointment_id = a.id), '[]'::jsonb))
                order by a.starts_at)
            from public.appointments a
            left join public.contacts c on c.id = a.contact_id
            left join public.users u on u.id = a.companion_id
            where a.care_file_id = p_care_file_id), '[]'::jsonb),
        'journal_entries', coalesce((
            select jsonb_agg(jsonb_build_object('author', u.display_name, 'body', j.body, 'created_at', j.created_at)
                order by j.created_at)
            from public.journal_entries j left join public.users u on u.id = j.author_id
            where j.care_file_id = p_care_file_id), '[]'::jsonb),
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

-- Export personnel : ajoute les rappels reçus (dates et nombres).
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
        'reminder_emails', coalesce((
            select jsonb_agg(jsonb_build_object(
                'sent_on', d.sent_on, 'task_count', d.task_count, 'appointment_count', d.appointment_count)
                order by d.sent_on)
            from public.reminder_deliveries d where d.user_id = v_uid), '[]'::jsonb),
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
        'public.reminders_due(date)',
        'public.record_reminder_sent(uuid,date,integer,integer)'
    ] loop
        execute format('revoke all on function %s from public, anon, authenticated', fn);
        execute format('grant execute on function %s to service_role', fn);
    end loop;
end;
$$;
revoke all on function private.journal_author(), private.task_completion(), private.check_assignee_is_member(),
    private.unassign_former_member() from public;

-- -----------------------------------------------------------------------------------------------------
-- Privilèges
-- -----------------------------------------------------------------------------------------------------
revoke all on public.tasks, public.appointments, public.appointment_questions, public.journal_entries,
    public.reminder_deliveries from anon, authenticated;
grant all on public.tasks, public.appointments, public.appointment_questions, public.journal_entries,
    public.reminder_deliveries to service_role;

grant select, insert, delete on public.tasks to authenticated;
grant update (title, details, assignee_id, due_on, status) on public.tasks to authenticated;
grant select, insert, delete on public.appointments to authenticated;
grant update (title, starts_at, ends_at, location, contact_id, companion_id, notes) on public.appointments to authenticated;
grant select, insert, delete on public.appointment_questions to authenticated;
grant update (question, position) on public.appointment_questions to authenticated;
grant select, insert, delete on public.journal_entries to authenticated;
grant update (body) on public.journal_entries to authenticated;
grant select on public.reminder_deliveries to authenticated;

-- -----------------------------------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------------------------------
alter table public.tasks enable row level security;
alter table public.appointments enable row level security;
alter table public.appointment_questions enable row level security;
alter table public.journal_entries enable row level security;
alter table public.reminder_deliveries enable row level security;

-- Tâches et agenda : zone « coordination ». Une tâche liée à un document ou à une démarche ne peut être
-- créée que par quelqu'un qui voit ce document ou cette démarche.
create policy tasks_select on public.tasks for select to authenticated
    using (private.can_read(care_file_id, 'coordination'));
create policy tasks_insert on public.tasks for insert to authenticated
    with check (
        private.can_write(care_file_id, 'coordination')
        and (source_document_id is null or private.can_read(care_file_id, 'health'))
        and (care_file_program_id is null or private.can_read(care_file_id, 'benefits')));
create policy tasks_update on public.tasks for update to authenticated
    using (private.can_write(care_file_id, 'coordination')) with check (private.can_write(care_file_id, 'coordination'));
create policy tasks_delete on public.tasks for delete to authenticated
    using (private.can_write(care_file_id, 'coordination'));

create policy appointments_select on public.appointments for select to authenticated
    using (private.can_read(care_file_id, 'coordination'));
create policy appointments_insert on public.appointments for insert to authenticated
    with check (
        private.can_write(care_file_id, 'coordination')
        and (source_document_id is null or private.can_read(care_file_id, 'health')));
create policy appointments_update on public.appointments for update to authenticated
    using (private.can_write(care_file_id, 'coordination')) with check (private.can_write(care_file_id, 'coordination'));
create policy appointments_delete on public.appointments for delete to authenticated
    using (private.can_write(care_file_id, 'coordination'));

-- Questions à poser et carnet de bord : zone « santé ».
create policy appointment_questions_select on public.appointment_questions for select to authenticated
    using (private.can_read(care_file_id, 'health'));
create policy appointment_questions_insert on public.appointment_questions for insert to authenticated
    with check (private.can_write(care_file_id, 'health'));
create policy appointment_questions_update on public.appointment_questions for update to authenticated
    using (private.can_write(care_file_id, 'health')) with check (private.can_write(care_file_id, 'health'));
create policy appointment_questions_delete on public.appointment_questions for delete to authenticated
    using (private.can_write(care_file_id, 'health'));

-- Carnet : chacun modifie ou retire seulement ses propres notes.
create policy journal_entries_select on public.journal_entries for select to authenticated
    using (private.can_read(care_file_id, 'health'));
create policy journal_entries_insert on public.journal_entries for insert to authenticated
    with check (private.can_write(care_file_id, 'health'));
create policy journal_entries_update on public.journal_entries for update to authenticated
    using (author_id = (select auth.uid()) and private.can_write(care_file_id, 'health'))
    with check (author_id = (select auth.uid()) and private.can_write(care_file_id, 'health'));
create policy journal_entries_delete on public.journal_entries for delete to authenticated
    using (author_id = (select auth.uid()) and private.can_read(care_file_id, 'health'));

create policy reminder_deliveries_select on public.reminder_deliveries for select to authenticated
    using (user_id = (select auth.uid()));
