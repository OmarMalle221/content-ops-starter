-- Droits de la clé de service sur les objets du site.
--
-- Selon le projet Supabase, les tables créées en SQL ne sont pas toujours
-- ouvertes d'office au rôle `service_role`. Sans ces droits, les fonctions
-- Netlify reçoivent « permission denied » malgré la clé de service.
-- Les rôles `anon` et `authenticated` restent sans aucun accès.

grant usage on schema public to service_role;

grant select, insert, update, delete
  on table quote_requests, shipments, shipment_events, admin_users, rate_limits
  to service_role;

grant usage, select on sequence quote_ref_seq to service_role;

grant execute on function check_rate_limit(text, text, integer, integer) to service_role;
