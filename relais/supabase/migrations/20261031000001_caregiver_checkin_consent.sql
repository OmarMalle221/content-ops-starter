-- =====================================================================================================
-- Relais — étape 6 (1/2) : consentement distinct « Mon bilan de la semaine » (caregiver_checkin).
-- Migration séparée : PostgreSQL n'accepte l'usage d'une nouvelle valeur d'énumération qu'après la
-- validation de la transaction qui l'ajoute (la migration suivante s'en sert dans ses politiques).
-- =====================================================================================================
alter type public.consent_type add value if not exists 'caregiver_checkin' after 'pilot_evaluation';
