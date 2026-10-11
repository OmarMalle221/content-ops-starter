# Adaptateurs partenaires — contrats de référence et préparation à l'intégration

> **Sandbox uniquement.** Aucun adaptateur décrit ici ne peut être activé dans ce build : `DFN_MODE` reste `sandbox`, toutes les fabriques refusent les codes non sandbox (`PROVIDER_NOT_ACTIVATABLE`) et l'API refuse de démarrer si une variable `*_PROVIDER` en contient un. Les adaptateurs « reference » servent uniquement aux tests contractuels ; ils ne désignent aucun fournisseur réel et ne constituent ni un partenariat ni une intégration validée. Voir ADR-0003, ADR-0008 et ADR-0012.

## 1. Vue d'ensemble

| Type      | Variable             | Interface                | Sandbox (seul activable)                                | Adaptateur de référence (tests uniquement)              | Portes requises avant d'envisager un partenaire |
| --------- | -------------------- | ------------------------ | ------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| KYC/KYB   | `KYC_PROVIDER`       | `KycProvider`            | `SandboxKycProvider` (`SIMULATED_*`)                    | `HttpReferenceKycProvider` (`@dfn/compliance`)          | R1, R2, R7, R8                                  |
| Sanctions | `SANCTIONS_PROVIDER` | `SanctionsProvider`      | `SandboxSanctionsProvider` (`*_SIMULATED`)              | `HttpReferenceSanctionsProvider` (`@dfn/compliance`)    | R1, R2, R7, R8                                  |
| Paiement  | `PAYMENT_PROVIDER`   | `PaymentProviderAdapter` | `SandboxPaymentProvider` (`sandbox`, `sandbox_partner`) | — (aucun)                                               | R1, R3, R4, R5, R6, R7, R8, R9                  |
| Change    | `FX_PROVIDER`        | `FxRateProvider`         | `SandboxFxRateProvider` (taux indicatifs fixes)         | `HttpReferenceFxRateProvider` (`@dfn/payment-adapters`) | R1, R3, R4, R6, R8                              |
| Versement | `PAYOUT_PROVIDER`    | `PayoutProvider`         | `SandboxPayoutProvider` (en mémoire)                    | `HttpReferencePayoutProvider` (`@dfn/payment-adapters`) | R1, R3, R4, R5, R6, R7, R8, R9                  |

La correspondance type → portes est définie une seule fois (`PROVIDER_REQUIRED_GATES`, `packages/shared/src/schemas/gates.ts`) et réutilisée par les fabriques, la garde de l'API et l'écran `/admin/gates`.

### Trois verrous indépendants

1. **Fabriques** (`createKycProvider`, `createSanctionsProvider`, `createPaymentProvider`, `createFxRateProvider`, `createPayoutProvider`) : seul un code sandbox construit un adaptateur ; tout autre code — `reference` compris — lève `ProviderNotActivatableError` (`code = PROVIDER_NOT_ACTIVATABLE`, message « sandbox-only », liste des portes).
2. **Garde au démarrage** (`GatesModule.onModuleInit` → `ProviderActivationService.assertConfiguredProviders`) : les cinq variables sont vérifiées ; un code non sandbox arrête l'API avec le détail des portes et de leur statut. La garde refuse **même si toutes les portes requises sont satisfaites** : le registre est un outil de suivi.
3. **Absence de câblage** : aucun module de l'API n'importe un adaptateur `HttpReference*` ; ils ne sont construits que par `new …(options)` dans les tests des paquets.

## 2. Règles communes des contrats de référence

| Sujet              | Règle                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport          | HTTPS obligatoire (`http://` accepté seulement sur `localhost`/`127.0.0.1` pour les serveurs de test) ; redirections refusées ; corps JSON ≤ 1 Mo                                                               |
| Authentification   | `Authorization: Bearer <clé API>` sur chaque appel ; clé d'au moins 8 caractères, fournie par le coffre de secrets (jamais en dur)                                                                              |
| Idempotence        | `Idempotency-Key` sur chaque `POST`, identique à chaque nouvelle tentative ; KYC/sanctions : clé dérivée (SHA-256) de l'opération et de la charge utile ; versements : clé fournie par l'appelant par tentative |
| Délais et reprises | Délai par tentative (5 s par défaut) ; 2 reprises par défaut avec attente exponentielle (200 ms, 400 ms…) plafonnée ; `Retry-After` respecté (plafonné) ; un `POST` n'est repris qu'avec une clé d'idempotence  |
| Erreurs            | 400/422 → `INVALID_REQUEST` ; 401/403 → `AUTH_FAILED` ; 404 → `NOT_FOUND` ; 409 → `CONFLICT` ; 429 → `RATE_LIMITED` (repris) ; 5xx → `UNAVAILABLE` (repris) ; délai → `TIMEOUT` ; réseau → `NETWORK`            |
| Réponses           | Toute réponse non JSON, incomplète, incohérente (autre demandeur, autre paire, autre montant) → `BAD_RESPONSE` ; rien n'est deviné                                                                              |
| Webhooks / rappels | En-têtes `X-Reference-Timestamp` (secondes Unix) et `X-Reference-Signature: v1=<hex>` = HMAC-SHA256 de `"<timestamp>.<corps brut>"` ; comparaison à temps constant ; plusieurs signatures acceptées (rotation)  |
| Rejeu              | Horodatage hors de ± 300 s → `SIGNATURE_EXPIRED` ; signature absente, mal formée ou fausse → `SIGNATURE_INVALID` ; l'identifiant d'événement sert de clé de dédoublonnage                                       |
| Montants et taux   | Montants en unités mineures, sérialisés en chaînes d'entiers ; taux en chaînes décimales ou rationnels `{numerator, denominator}` ; aucun nombre flottant JSON accepté                                          |

## 3. KYC/KYB et sanctions (`packages/compliance/src/kyc/http-reference.ts`)

| Étape                      | Requête                                                                                                                                                                                                                         | Réponse attendue                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Créer le demandeur         | `POST /v1/applicants` — personne : `{externalId, kind: "PERSON", firstName, lastName, country, dateOfBirth?}` ; entreprise : `{externalId, kind: "BUSINESS", legalName, registrationNumber, registrationCountry, businessType}` | `{id}`                                                                                           |
| Soumettre la vérification  | `POST /v1/applicants/{id}/checks` — `{checkType: "IDENTITY_DOCUMENT", documentType, issuingCountry, documentRef?}` ou `{checkType: "BUSINESS_REGISTRY", documentRef?}`                                                          | `{checkId, status}`                                                                              |
| Lire la décision           | `GET /v1/applicants/{id}/decision`                                                                                                                                                                                              | `{applicantId, decision: PENDING \| NEEDS_REVIEW \| APPROVED \| REJECTED, reasons?, decidedAt?}` |
| Décision poussée (webhook) | Corps `{eventId, type: "applicant.decision", applicantId, decision, reasons?, occurredAt}` signé                                                                                                                                | Vérifié par `parseDecisionWebhook`                                                               |
| Criblage sanctions         | `POST /v1/screenings` — `{fullName, country?, dateOfBirth?}`                                                                                                                                                                    | `{screeningId, status: CLEAR \| POTENTIAL_MATCH, matches: [{list, name, score ∈ [0,1]}]}`        |

**Correspondance des statuts** : `APPROVED` et `NEEDS_REVIEW` → `PENDING` ; `REJECTED` → `REJECTED` ; aucun statut « réussi » n'est jamais produit : `requiresManualReview: true` sur chaque résultat, `simulated: false`. Une correspondance potentielle de sanctions exige une revue manuelle. Le paramètre `sandboxOutcome` n'est jamais transmis.

`documentRef` est une référence opaque de la plateforme : une intégration réelle devra définir le transfert des pièces (canal chiffré, durée de conservation chez le fournisseur, sous-traitance) dans le contrat et l'EFVP.

## 4. Change (`packages/payment-adapters/src/fx-http-reference.ts`)

`GET /v1/rates?base=CAD&quote=XOF` → `{base, quote, rate, asOf}` où `rate` vaut `"440.25"` ou `{"numerator": "44025", "denominator": "100"}` (taux médian, unité majeure → unité majeure).

Contrôles avant tout usage :

- paire renvoyée identique à la paire demandée ;
- `asOf` ISO-8601, âge ≤ 60 s (configurable) et pas plus de 30 s dans le futur → sinon `STALE_RATE` ;
- conversion exacte en rationnel `bigint` (aucun flottant) ; zéro, négatif, notation exponentielle, virgule, nombre JSON → `INVALID_RATE` ;
- bornes absolues ]10⁻⁷ ; 10⁷[ et, si des taux de référence sont fournis, écart maximal (2 000 pb par défaut) → `INVALID_RATE`.

La marge de la plateforme est ensuite appliquée exactement comme dans le sandbox (`taux × (1 − spreadBps)`), ce qui garantit que `convertMinor` reste l'unique fonction de conversion.

## 5. Versements (`packages/payment-adapters/src/payout.ts`, `payout-http-reference.ts`)

| Opération       | Contrat                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Créer           | `POST /v1/payouts` + `Idempotency-Key` — `{clientReference, amount: {minor: "43340", currency}, destinationCountry, beneficiary: {name, method: BANK_ACCOUNT \| MOBILE_MONEY, accountToken}, reference}` → `{id, clientReference, status, amount, createdAt}` |
| Rejouer         | Même clé + même contenu → même versement ; même clé + autre contenu → 409 `CONFLICT`                                                                                                                                                                          |
| Contrôle d'écho | Le partenaire doit renvoyer la même référence client, le même montant et la même devise, sinon `BAD_RESPONSE`                                                                                                                                                 |
| Consulter       | `GET /v1/payouts/{id}`                                                                                                                                                                                                                                        |
| Rappel signé    | `{eventId, type: "payout.status", payoutId, externalRef, status: ACCEPTED \| PROCESSING \| COMPLETED \| FAILED \| RETURNED, occurredAt, failureReason?}` ; clé de dédoublonnage `<code fournisseur>:<eventId>`                                                |

`accountToken` est un jeton opaque (coffre du partenaire ou de la plateforme), jamais un numéro de compte en clair : les identifiants de bénéficiaires restent scellés dans le trousseau (`BENEFICIARIES`). `SandboxPayoutProvider` simule ce contrat en mémoire (références `sbx_po_…`, rappels signés via `simulateStatusCallback`) sans aucun appel réseau.

Comme pour le paiement (ADR-0008), un effet comptable ne pourra être déclenché que par un événement partenaire vérifié et persisté, jamais par la seule réponse à l'appel sortant.

## 6. Tests contractuels

| Fichier                                                    | Couverture                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/compliance/test/kyc-http-reference.test.ts`      | Forme des requêtes, en-tête d'authentification, clés d'idempotence stables, correspondance des décisions, signatures (valide, altérée, mauvais secret, expirée, future, rotation), délais, reprises, `Retry-After`, erreurs HTTP, réponses incohérentes, fabriques |
| `packages/payment-adapters/test/fx-http-reference.test.ts` | Requête, rationnels exacts, taux périmés ou futurs refusés, taux négatifs / nuls / absurdes / hors référence / flottants refusés, paire incohérente, reprises et délais                                                                                            |
| `packages/payment-adapters/test/payout.test.ts`            | Requête et en-têtes, idempotence (rejeu, conflit), reprise après 503 et délai avec la même clé, contrôle d'écho, rappels signés (valide, altéré, expiré), sandbox                                                                                                  |
| `packages/payment-adapters/test/factories.test.ts`         | Refus de tout code non sandbox par les trois fabriques avec les portes attendues                                                                                                                                                                                   |
| `apps/api/test/gates.test.ts`                              | Garde d'activation (y compris portes toutes satisfaites), échec du démarrage avec `KYC_PROVIDER=reference` ou `PAYOUT_PROVIDER=reference`                                                                                                                          |

Les tests utilisent un serveur `node:http` en mémoire sur `127.0.0.1` (port aléatoire) : aucun appel sortant.

## 7. Ce qu'exigerait une intégration réelle

Rien de ce qui suit n'est engagé ; la liste sert de rappel des prérequis.

1. **Juridique** : avis écrit sur la qualification des activités (R1) et franchissement des portes du type concerné (tableau §1), consignés dans le registre `/admin/gates` avec double approbation et références de preuve archivées dans le coffre de la conformité.
2. **Contrats** : contrat signé avec un fournisseur agréé (TR-01 à TR-03), accord de sous-traitance des données, EFVP (R7), clauses de localisation, de conservation et de réversibilité ; vérification de l'agrément du partenaire.
3. **Sécurité** : revue de sécurité de l'adaptateur réel et audit indépendant (R8) ; secrets (clé API, secret de webhook) dans le coffre de secrets, rotation documentée ; liste d'autorisation des hôtes sortants.
4. **Code** : un adaptateur dédié au contrat réel (le contrat de référence sert de gabarit, pas d'implémentation finale), la même suite de tests contractuels adaptée, la persistance idempotente des événements (`ProviderEvent`) avant tout effet, et la revue à deux personnes exigée par TR-10.
5. **Sortie du sandbox** : décision distincte, consignée dans un ADR signé (§9 de `AUTHORIZATIONS_CHECKLIST.md`) ; elle supposerait une modification revue du garde `DFN_MODE` et des fabriques — ce dépôt ne contient volontairement aucun chemin permettant de le faire par configuration.
