# Sécurité

Ce document distingue **ce qui est implémenté et testé** de **ce qui reste à faire** avant une mise en production. Rien de ce qui figure dans la colonne « à faire » ne doit être présenté comme acquis.

## Modèle de menace (résumé)

| Menace | Contrôle implémenté | Preuve (test) |
| --- | --- | --- |
| Faux versement par manipulation de l'interface ou de l'API | Aucune route ne modifie un statut financier. Les transitions financières sont réservées à l'acteur `PROVIDER`, utilisé uniquement après vérification HMAC | `state-machine.test.ts` (« never lets a party… »), `security.test.ts` |
| Webhook falsifié ou rejoué | HMAC-SHA256 sur `timestamp.body`, tolérance de 5 min, comparaison à temps constant, unicité `(provider, external_event_id)` en mémoire et en SQL | `security.test.ts` (unit + intégration), `security.spec.ts` (E2E), `rls_test.sql` |
| Montant reçu différent du montant attendu | Aucun passage à `FUNDS_CONFIRMED` ; alerte critique et mise en file de revue ; écart visible en réconciliation | `security.test.ts` (« never confirms funding… ») |
| Double traitement | Clés d'idempotence : journaux, instructions, versements, remboursements ; requête partenaire idempotente | Test de rejeu (`replay`) |
| Accès à la transaction d'un tiers (IDOR) | Contrôle central `accessTransaction` ; réponse 404 indistinguable ; RLS en base | `security.test.ts`, `security.spec.ts`, `rls_test.sql` |
| Accès aux documents d'un tiers | `canView` (rôle de partie dans `visible_to_roles`), URL signée liée à l'utilisateur et valable 5 min, ré-autorisation au téléchargement, journal d'accès (y compris les refus), contrôle d'intégrité SHA-256 | `security.test.ts`, `transaction-flow.spec.ts` |
| Isolation entre organisations | Accès en lecture pour les membres, écriture réservée à la partie nommée ; politiques RLS | `security.test.ts` (« organisation members… »), `rls_test.sql` |
| Privilèges excessifs du personnel | Rôles distincts ; `platform_admin` sans accès aux transactions ; auditeur sans accès au contenu des fichiers | `security.test.ts` (« least privilege »), `security.spec.ts` |
| Vol de session / action sensible | Cookie de session HMAC, `HttpOnly`, `SameSite=Lax`, `Secure` en production, durée de 12 h ; MFA TOTP pour le back-office (12 h) et pour les actions sensibles (15 min) : décision de litige, coordonnées de versement, gel, contrepassation, configuration | `payments-disputes.test.ts` (`MFA_REQUIRED`), `security.spec.ts` |
| Changement frauduleux de bénéficiaire | MFA, délai de carence de 72 h, alertes bloquantes, notification de sécurité | `payments-disputes.test.ts` |
| CSRF | Server Actions (contrôle d'origine par Next.js) ; API REST : `Origin` = hôte et `Content-Type: application/json` obligatoires | `security.spec.ts` |
| XSS / clickjacking | CSP avec nonce par requête et `strict-dynamic`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` ; React échappe le contenu | `security.spec.ts` (en-têtes) |
| Fichiers malveillants | Type détecté par signature binaire (le type déclaré n'est pas cru), liste blanche PDF/PNG/JPEG/WEBP, 10 Mo max, nom de fichier assaini, analyse **avant** stockage (quarantaine), téléchargement avec CSP `sandbox` | `security.test.ts` (« document intake controls ») |
| Énumération / force brute | Limitation de débit : connexion, MFA (5 essais / 5 min), invitations, téléversements, API, webhook ; jetons d'invitation de 256 bits stockés hachés | Unit `rate-limiter` |
| Altération de l'historique | Journal d'audit chaîné SHA-256 et vérifiable ; tables en ajout seul en base | `demo-seed.test.ts` (`chain.valid`), `rls_test.sql` |
| Signalement prématuré (tipping-off) | Les parties ne voient ni les alertes, ni les gels, ni la conformité ; seulement un message générique « en revue » | `security.test.ts` |
| Fuite de secrets ou de données bancaires | Aucun numéro de carte ni de compte stocké (identifiant masqué + jeton) ; secrets via variables d'environnement ; seule la référence du secret partenaire est stockée ; logs JSON sans données sensibles | Revue de code, CHECK SQL sur `masked_identifier` |
| Données de démonstration | Profils fictifs, domaine `.test`, fichiers marqués « FICTIF » ; le mode production refuse le fournisseur simulé | `config.ts` |
| Confusion entre partenaire simulé et livres de TrustCargo | Enregistrements du faux partenaire isolés dans `trustcargo_sim` (aucune clé étrangère vers `trustcargo`, références et montants uniquement) ; `service_role` seul, aucun privilège pour `anon` / `authenticated`, RLS active, montants et relevé non modifiables ; écritures hors unité de travail | `rls_test.sql`, `simulated-partner.test.ts` |

## Ce qui reste à faire (bloquant pour la production)

1. **Authentification réelle** : Supabase Auth (vérification d'e-mail, MFA AAL2, rotation des sessions, verrouillage de compte), en remplacement des profils de démonstration.
2. **Adaptateur Postgres** : branché (transactions SQL, `service_role`, verrou global). Reste à le valider sur un projet Supabase de staging et à remplacer le verrou global par des verrous ciblés avant une charge réelle. Le client Supabase est réservé aux lectures sous RLS.
3. **Limitation de débit distribuée** (Redis/Upstash) : l'implémentation actuelle est en mémoire.
4. **Antivirus réel** (ClamAV, ou service géré) : l'implémentation actuelle détecte seulement la signature EICAR.
5. **Stockage chiffré** : Supabase Storage privé + URLs signées. Politiques déjà écrites en SQL, non testées sur Supabase réel.
6. **Gestion des secrets** (coffre, rotation) et clés distinctes par environnement.
7. **Chiffrement applicatif** des champs KYC sensibles si des données d'identité sont conservées hors du fournisseur KYC.
8. **Politique de rétention et suppression** conforme aux obligations applicables (LCB-FT, protection des données). À définir avec un conseil juridique.
9. **Sauvegardes et tests de restauration** (PITR Supabase) avec procédure documentée et exercée.
10. **Tests d'intrusion** et revue de sécurité indépendante ; programme de divulgation responsable.
11. **Supervision** : alertes sur les événements partenaires en échec, la balance du registre, la rupture de la chaîne d'audit, les écarts de réconciliation.
12. **CSP** : les styles inline sont autorisés pour Radix UI. Évaluer une alternative.
