# ADR-0008 — Adaptateurs de partenaires (paiement, KYC, sanctions) derrière des interfaces, sandbox par défaut

| Champ  | Valeur                                                                                                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Statut | Accepté                                                                                                                                                                                      |
| Date   | 2026-10-11                                                                                                                                                                                   |
| Portée | `packages/payment-adapters`, `packages/compliance/src/kyc`, modèles `PaymentProvider`, `ProviderEvent`, `FundingRequest`, variables `PAYMENT_PROVIDER`, `KYC_PROVIDER`, `SANCTIONS_PROVIDER` |

## Contexte

Le principe fondateur de DFN est que **les fonds réels sont toujours détenus et déplacés par un prestataire agréé** et que la vérification d'identité est effectuée par un fournisseur spécialisé. Ces partenaires n'existent pas encore (aucun contrat), mais le produit doit être démontrable et l'intégration future doit être possible sans réécrire les modules. Les partenaires réels diffèrent par leurs API, leurs délais, leurs callbacks et leurs statuts ; le cœur métier doit en être isolé.

## Décision

1. **Interfaces stables** :
   - `PaymentProviderAdapter` : `createFundingInstructions`, `simulateFundingEvent` (sandbox), `executeRelease`, `executeRefund` ; types `FundingInstructions`, `PartnerEvent`, `ExecutionResult`.
   - `KycProvider` (`startIdentityCheck`, `startBusinessCheck`) et `SanctionsProvider` (`screen`), avec `simulated: boolean` obligatoire.
2. **Fabriques pilotées par l'environnement** : `createPaymentProvider(PAYMENT_PROVIDER)`, `createKycProvider(KYC_PROVIDER)`, `createSanctionsProvider(SANCTIONS_PROVIDER)` ; seule la valeur `sandbox` est acceptée ; toute autre valeur lève une exception explicite (voir ADR-0003).
3. **Événements partenaires idempotents** : chaque callback est persisté comme `ProviderEvent` avec `idempotencyKey` unique et statut (`RECEIVED`, `PROCESSED`, `IGNORED`, `FAILED`) avant tout effet métier ; le traitement est rejouable.
4. **Signature** : les webhooks (simulés aujourd'hui, réels et sortants demain) utilisent `HMAC-SHA256(timestamp.rawBody)` avec comparaison en temps constant (`signature.ts`) et fenêtre d'horodatage.
5. **Le cœur ne connaît que des références** : `FundingRequest.reference`, `ProviderEvent.externalRef`, `ExecutionResult.externalRef` ; les écritures comptables (`FUNDING`, `RELEASE`, `REFUND`) sont déclenchées par les événements partenaires, jamais par l'appel sortant seul.
6. **Adaptateur sandbox fidèle** : instructions fictives explicitement marquées, référence `SBXF-…`, expiration 72 h, exécution `EXECUTED_SIMULATED` ; aucune requête réseau.
7. **Ajout d'un adaptateur réel** : nouveau paquet ou module, implémentation des interfaces, enregistrement conditionnel dans la fabrique, tests contractuels, revue de sécurité, et surtout franchissement des portes réglementaires et contractuelles (`AUTHORIZATIONS_CHECKLIST.md`).

## Conséquences

Positives : modules métier indépendants des partenaires ; démonstrations complètes ; chemin d'intégration clair ; idempotence et signature garanties dès maintenant ; traçabilité des échanges partenaires pour l'audit et le rapprochement.

Négatives : les interfaces devront probablement évoluer au contact d'un partenaire réel (statuts intermédiaires, frais, délais de règlement, informations de règle de voyage) ; l'adaptateur sandbox peut masquer des cas d'erreur réels — mitigation : scénarios d'échec simulés (`FAILED`, `EXPIRED`, `SIMULATED_FAIL`) et revue de l'interface à la signature du premier contrat.

## Alternatives

| Alternative                                                  | Raison du rejet                                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Intégrer directement l'API d'un prestataire en « mode test » | Couplage au fournisseur avant tout contrat ; frontière sandbox/réel floue (ADR-0003)                           |
| Plateforme d'orchestration de paiements tierce               | Coût et dépendance prématurés ; les interfaces DFN restent compatibles avec un tel choix ultérieur             |
| Aucune abstraction, « on verra au moment de l'intégration »  | Réécriture des modules Protect/Transfer garantie ; perte de l'idempotence et de la signature dès la conception |

## Détails de mise en œuvre

| Élément                          | Choix                                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enregistrement du fournisseur    | Ligne `PaymentProvider(code = 'SANDBOX_PARTNER', mode = SANDBOX)` créée par le seed ; les événements et demandes de financement y sont rattachés                                                                     |
| Clé d'idempotence des événements | `${providerCode}:${fundingReference}:${outcome}` pour le sandbox ; pour un partenaire réel, l'identifiant d'événement du partenaire                                                                                  |
| Traitement d'un événement        | 1) persister `ProviderEvent(RECEIVED)` ; 2) vérifier la signature et l'horodatage ; 3) appliquer la transition métier et l'écriture comptable dans une transaction ; 4) marquer `PROCESSED` ou `FAILED` avec `error` |
| Expiration                       | `FundingRequest.expiresAt` = création + 72 h ; tâche BullMQ passant les demandes en `EXPIRED` et la transaction en `EXPIRED` si rien n'a été reçu                                                                    |
| Simulation                       | Route administrateur protégée par `sandbox:partner_simulate` appelant `simulateFundingEvent` puis le même pipeline que pour un webhook réel                                                                          |
| Tests contractuels               | Chaque adaptateur doit passer la même suite : instructions valides, événement dupliqué ignoré, signature invalide rejetée, libération et remboursement idempotents                                                   |

## Révision

Revoir les interfaces à la signature du premier contrat partenaire (TR-01) et consigner les changements dans un ADR complémentaire.
