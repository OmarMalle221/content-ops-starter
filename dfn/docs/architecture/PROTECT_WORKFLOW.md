# Diaspora Protect — workflow détaillé et endpoints

| Étape           | Acteur                                | Endpoint                                                                   | Effet                                                                                           | Événement                                                                |
| --------------- | ------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1. Création     | acheteur                              | `POST /v1/transactions`                                                    | transaction `PENDING_ACCEPTANCE`, parties, jalons, contrat v1 (hash SHA-256), évaluation risque | `transaction.created`, `contract.generated`, `transaction.party_invited` |
| 2. Invitation   | vendeur (public)                      | `GET /v1/invitations/:token`                                               | aperçu masqué de la transaction                                                                 | —                                                                        |
| 3. Acceptation  | vendeur                               | `POST /v1/invitations/accept` (ou inscription avec `invitationToken`)      | partie `ACCEPTED`, transaction `ACCEPTED`                                                       | `transaction.party_accepted`                                             |
| 4. Conditions   | acheteur + vendeur                    | `POST /v1/transactions/:id/accept-terms`                                   | acceptations horodatées ; contrat `ACCEPTED` après les deux                                     | `contract.accepted`, `verification.required`                             |
| 5. Vérification | chacun                                | `POST /v1/verifications/identity`                                          | KYC **simulée** (`SIMULATED_PASS`/`SIMULATED_FAIL`), filtrage sanctions simulé                  | —                                                                        |
| 6. Financement  | acheteur                              | `POST /v1/transactions/:id/funding/request`                                | `FundingRequest` + instructions fictives, transaction `AWAITING_FUNDING`                        | `funding.requested`                                                      |
| 7. Confirmation | partenaire simulé (acheteur ou staff) | `POST /v1/sandbox/partner/funding-events`                                  | écriture ledger FUNDING, transaction `FUNDED` (idempotent)                                      | `funding.confirmed`                                                      |
| 8. Preuves      | vendeur                               | `POST /v1/transactions/:id/documents` puis `POST …/milestones/:mid/submit` | documents chiffrés, jalon `SUBMITTED`, transaction `IN_PROGRESS`                                | `document.uploaded`, `milestone.submitted`                               |
| 9. Validation   | acheteur                              | `POST …/milestones/:mid/approve` ou `…/request-changes`                    | jalon `RELEASED` + écriture RELEASE atomique, ou `CHANGES_REQUESTED`                            | `milestone.approved`, `milestone.released`                               |
| 10. Clôture     | système                               | automatique                                                                | `SETTLED` quand tous les jalons sont terminaux et le séquestre est à zéro                       | `transaction.settled`                                                    |

## Litiges

| Action            | Acteur         | Endpoint                                                     | Effet                                                                                              |
| ----------------- | -------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Ouvrir            | partie         | `POST /v1/transactions/:id/disputes` (ou `…/refund-request`) | `DISPUTED`, `releaseFrozen=true` ; toute approbation renvoie `RELEASE_FROZEN` (409)                |
| Échanger          | parties, staff | `POST /v1/disputes/:id/messages`                             | messages, pièces, notes internes staff                                                             |
| Prendre en charge | staff          | `POST /v1/disputes/:id/review`                               | `UNDER_REVIEW`                                                                                     |
| Décider           | staff          | `POST /v1/disputes/:id/decide`                               | `DECIDED` ; non finale → fenêtre d'appel 7 jours ; finale → exécution ledger immédiate et `CLOSED` |
| Faire appel       | partie         | `POST /v1/disputes/:id/appeal`                               | `APPEALED` → nouvelle décision obligatoirement finale                                              |
| Clore             | staff          | `POST /v1/disputes/:id/close`                                | exécute la dernière décision si nécessaire, dégèle les libérations                                 |

Issues : `RELEASE_TO_SELLER`, `REFUND_TO_BUYER`, `SPLIT` (montants = solde séquestré restant), `DISMISSED` (dégel sans mouvement).

## Garde-fous

- Rôle calculé côté serveur (`BUYER`/`SELLER`/`STAFF`) ; 404 pour tout tiers.
- Preuves requises par jalon vérifiées par type de document.
- `nextActions` renvoyé par l'API pilote l'interface : aucun bouton décoratif.
