-- =====================================================================================================
-- Relais — planification de la purge de Storage (à exécuter UNE fois dans le projet Supabase, éditeur SQL).
--
-- Pas une migration : pg_cron, pg_net et Vault n'existent que sur Supabase (et les tests utilisent une
-- base sans eux). Mêmes secrets Vault que les rappels (voir send_reminders.sql) :
--   relais_functions_url : https://<référence-du-projet>.supabase.co/functions/v1
--   relais_cron_secret   : la même valeur que le secret RELAIS_CRON_SECRET des fonctions Edge
--
-- Toutes les heures, à la 17e minute : la fonction purge-storage reprend les fichiers inscrits pour
-- effacement, efface les dépôts abandonnés depuis plus de 24 h et les fichiers sans document.
-- =====================================================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('relais-purge-storage')
where exists (select 1 from cron.job where jobname = 'relais-purge-storage');

select cron.schedule(
    'relais-purge-storage',
    '17 * * * *',
    $$
    select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'relais_functions_url') || '/purge-storage',
        headers := jsonb_build_object(
            'content-type', 'application/json',
            'x-relais-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'relais_cron_secret')),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
    )
    $$
);
