-- =====================================================================================================
-- Relais — purge planifiée de Storage (2/2), pour la fonction serveur `purge-storage` que pg_cron appelle
-- toutes les heures (supabase/cron/purge_storage.sql).
--
-- Supprimer un document ou un dossier inscrit ses fichiers dans storage_deletion_queue, et la fonction
-- serveur les efface aussitôt. Si cet appel échoue (réseau coupé, application fermée), le fichier reste
-- inscrit : la purge reprend la file. Elle rattrape aussi deux cas :
--   - dépôt abandonné : document « pending_upload » de plus de 24 h (envoi interrompu). Le document est
--     supprimé, son fichier partiel est inscrit, et le journal du dossier note « upload_expired » (sans
--     auteur : c'est Relais qui l'efface) ;
--   - fichier orphelin : objet du bucket `documents` de plus de 24 h sans document ni inscription.
-- Réservées au rôle service : storage_purge_prepare, storage_purge_claim, storage_purge_done.
-- =====================================================================================================

-- Inscrit ce qu'il faut effacer ; renvoie des nombres seulement.
create function public.storage_purge_prepare() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_expired integer;
    v_orphans integer;
begin
    with expired as (
        delete from public.documents
        where status = 'pending_upload' and uploaded_at < now() - interval '24 hours'
        returning id, care_file_id, storage_path
    ), queued as (
        insert into public.storage_deletion_queue (bucket_id, object_path)
        select 'documents', storage_path from expired
        on conflict do nothing
    ), logged as (
        insert into public.access_log (care_file_id, action, target_type, target_id)
        select care_file_id, 'upload_expired', 'documents', id from expired
    )
    select count(*) into v_expired from expired;

    -- Après les dépôts abandonnés : leurs fichiers sont déjà inscrits, donc pas comptés ici.
    insert into public.storage_deletion_queue (bucket_id, object_path)
    select o.bucket_id, o.name
    from storage.objects o
    where o.bucket_id = 'documents'
      and o.created_at < now() - interval '24 hours'
      and not exists (select 1 from public.documents d where d.storage_path = o.name)
    on conflict do nothing;
    get diagnostics v_orphans = row_count;

    return jsonb_build_object('expired_uploads', v_expired, 'orphans', v_orphans);
end;
$$;

-- Réserve un lot de fichiers à effacer (les moins essayés d'abord ; deux exécutions simultanées ne
-- prennent pas les mêmes lignes). Chaque réservation compte un essai.
create function public.storage_purge_claim(p_limit integer) returns table (id bigint, object_path text)
language sql security definer set search_path = ''
as $$
    update public.storage_deletion_queue q
    set attempts = q.attempts + 1
    where q.id in (
        select c.id from public.storage_deletion_queue c
        where c.bucket_id = 'documents'
        order by c.attempts, c.enqueued_at, c.id
        limit least(greatest(p_limit, 1), 1000)
        for update skip locked
    )
    returning q.id, q.object_path
$$;

-- Fichiers effacés de Storage : leurs inscriptions sont retirées.
create function public.storage_purge_done(p_ids bigint[]) returns integer
language sql security definer set search_path = ''
as $$
    with gone as (
        delete from public.storage_deletion_queue where id = any(p_ids) returning 1
    )
    select count(*)::integer from gone
$$;

-- -----------------------------------------------------------------------------------------------------
-- Privilèges
-- -----------------------------------------------------------------------------------------------------
do $$
declare
    fn text;
begin
    foreach fn in array array[
        'public.storage_purge_prepare()',
        'public.storage_purge_claim(integer)',
        'public.storage_purge_done(bigint[])'
    ] loop
        execute format('revoke all on function %s from public, anon, authenticated', fn);
        execute format('grant execute on function %s to service_role', fn);
    end loop;
end;
$$;
