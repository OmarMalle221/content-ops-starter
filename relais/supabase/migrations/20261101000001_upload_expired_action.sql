-- =====================================================================================================
-- Relais — purge planifiée de Storage (1/2) : action « upload_expired » du journal des accès.
-- Migration séparée : PostgreSQL n'accepte l'usage d'une nouvelle valeur d'énumération qu'après la
-- validation de la transaction qui l'ajoute (la migration suivante s'en sert).
-- =====================================================================================================
alter type public.access_action add value if not exists 'upload_expired' after 'document_deleted';
