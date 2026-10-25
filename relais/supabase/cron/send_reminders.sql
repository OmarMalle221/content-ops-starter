-- =====================================================================================================
-- Relais — planification des rappels quotidiens (à exécuter UNE fois dans le projet Supabase, éditeur SQL).
--
-- Pas une migration : pg_cron, pg_net et Vault n'existent que sur Supabase (et les tests utilisent une
-- base sans eux). Avant d'exécuter ce script, enregistrer dans Vault (Project Settings → Vault) :
--   relais_functions_url : https://<référence-du-projet>.supabase.co/functions/v1
--   relais_cron_secret   : la même valeur que le secret RELAIS_CRON_SECRET des fonctions Edge
--
-- Heure : pg_cron est en UTC. 12 h UTC = 8 h à Montréal l'été, 7 h l'hiver. La fonction calcule elle-même
-- le jour au Québec et n'envoie qu'un courriel par personne et par jour.
-- =====================================================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('relais-send-reminders')
where exists (select 1 from cron.job where jobname = 'relais-send-reminders');

select cron.schedule(
    'relais-send-reminders',
    '0 12 * * *',
    $$
    select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'relais_functions_url') || '/send-reminders',
        headers := jsonb_build_object(
            'content-type', 'application/json',
            'x-relais-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'relais_cron_secret')),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
    )
    $$
);
