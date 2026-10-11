# Diaspora Digital Asset (DDA) — simulation de recherche

> **Ce prototype n'émet aucun actif et ne constitue pas une annonce d'émission.** Le DDA est une unité
> **fictive** confinée au bac à sable de recherche : aucune blockchain, aucun jeton, aucun fonds réel,
> aucune convertibilité. La parité « 1 DDA = 1 USD » est une **hypothèse en cours d'étude — non garantie**.
> Analyse de risques et porte réglementaire : `docs/compliance/STABLECOIN_RISKS.md` (porte R10, bloquante).

Implémentation : `apps/api/src/modules/dda/**` (tests : `apps/api/test/dda.test.ts`), interface
`apps/web/src/app/(app)/admin/dda/**` et `apps/web/src/components/dda/**`.

## 1. Objectifs

- Étudier, **sans rien émettre**, la mécanique comptable d'un actif de règlement référencé au dollar :
  registre d'unités, émission / transfert / rachat, réserve, couverture, scénarios de stress.
- Produire des **analyses** reproductibles (traçabilité complète de chaque opération simulée), pas un produit.
- Fournir à la direction et à la conformité un support concret pour la décision de porte R10, sans
  préjuger de son issue.

## 2. Lignes rouges (appliquées dans le code et dans les textes)

| #   | Ligne rouge                                             | Mise en œuvre technique                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Aucune blockchain publique ni privée, aucun jeton       | Aucune dépendance ni intégration chaîne ; le « registre » est le registre comptable interne (PostgreSQL).                                                                                                                                                     |
| 2   | Aucun fonds réel                                        | Devise `DDA` de type `SIMULATED_ASSET` ; la réserve USD est **déclarative** et persistée hors registre fiat (§5).                                                                                                                                             |
| 3   | Aucune conversion du DDA en fiat ou en tout autre actif | Aucune route d'échange ; tous les comptes DDA sont libellés en `DDA` et `LedgerService.validateEntries` refuse toute écriture multi-devise — une écriture DDA ↔ fiat est **structurellement impossible**. `assertDdaCurrency` refuse `currencyCode ≠ 'DDA'`. |
| 4   | Aucune exposition aux utilisateurs non administrateurs  | Routes `v1/admin/dda/*` sous `Permission.ADMIN_DDA` (rôle ADMIN uniquement) ; page web `/admin/dda` → `notFound()` pour tout autre rôle ; `WalletsService` itère `CURRENCIES` (fiat) et ignore le DDA ; notifications aux seuls administrateurs.              |
| 5   | Parité 1 DDA = 1 USD = hypothèse, jamais une garantie   | Chaque réponse API porte `{ simulated: true, disclaimer, hypothesis }` ; chaque écriture, ligne et entrée d'audit porte `metadata.hypothesis = '1 DDA = 1 USD (non garantie)'` ; bandeau permanent sur l'interface.                                           |
| 6   | Aucune annonce d'émission                               | Vocabulaire « simulation de recherche » partout ; ce document et la page admin le rappellent explicitement.                                                                                                                                                   |

## 3. Registre des unités fictives

### Devise

`Currency { code: 'DDA', name: 'Diaspora Digital Asset (unité fictive)', exponent: 2, kind: SIMULATED_ASSET, isActive: true }`,
upsertée par `DdaRegistryService.onModuleInit()` et avant chaque opération (`ensure()`).
`ReferenceDataService.ensure()` ne touche que les devises fiat : le `kind` du DDA est préservé (test dédié).

### Plan de comptes (codes dans `@dfn/financial-ledger` `account-codes.ts`)

| Compte                             | Type                 | Sens normal | Négatif autorisé | Propriétaire | Rôle                                                 |
| ---------------------------------- | -------------------- | ----------- | ---------------- | ------------ | ---------------------------------------------------- |
| `DDA_ISSUANCE:DDA`                 | ASSET (contrepartie) | DEBIT       | oui              | PLATFORM     | unités fictives en circulation (solde = encours)     |
| `DDA_HOLDING:<organizationId>:DDA` | LIABILITY            | CREDIT      | **non**          | ORGANIZATION | unités fictives détenues par une organisation (lazy) |

### Écritures types (toujours équilibrées, toujours en `DDA`)

| Opération  | Débit                 | Crédit                | `kind` registre | Statut de la ligne |
| ---------- | --------------------- | --------------------- | --------------- | ------------------ |
| `MINT`     | `DDA_ISSUANCE`        | `DDA_HOLDING:<org>`   | `DEPOSIT`       | `MINTED`           |
| `TRANSFER` | `DDA_HOLDING:<org A>` | `DDA_HOLDING:<org B>` | `ADJUSTMENT`    | `TRANSFERRED`      |
| `REDEEM`   | `DDA_HOLDING:<org>`   | `DDA_ISSUANCE`        | `WITHDRAWAL`    | `REDEEMED`         |

### Invariant

**encours = solde(`DDA_ISSUANCE`) = Σ solde(`DDA_HOLDING:*`)**. Il découle mécaniquement de l'équilibre
de chaque écriture (chaque débit du compte d'émission est crédité à une détention, et réciproquement).
`GET overview` et `GET holdings` renvoient `invariantHolds` (vérification SQL agrégée) ; les tests
d'intégration le contrôlent après chaque simulateur. Les détentions ne peuvent jamais devenir négatives :
le registre refuse (`INSUFFICIENT_FUNDS` → HTTP 409) sous verrou `SELECT … FOR UPDATE`.

### Chaque opération

- référence stable `DDA-<YYYY>-<XXXXXX>` ; clé d'idempotence registre `dda:<reference>` ;
- écriture registre **et** ligne `DigitalAssetSimulation` dans la **même** transaction Prisma (`$transaction`) ;
- entrée d'audit `dda.mint` / `dda.transfer` / `dda.redeem` / `dda.reserve_adjustment` (`entityType: DigitalAssetSimulation`) ;
- notification `dda.operation` aux administrateurs actifs uniquement ;
- métadonnées `{ simulated: true, hypothesis: '1 DDA = 1 USD (non garantie)', operation, … }` sur l'écriture, la ligne et l'audit.

## 4. Lignes `DigitalAssetSimulation`

| Champ                        | MINT                       | TRANSFER           | REDEEM           | RESERVE_ADJUSTMENT                               |
| ---------------------------- | -------------------------- | ------------------ | ---------------- | ------------------------------------------------ |
| `unitsMinor`                 | unités émises              | unités transférées | unités détruites | 0                                                |
| `reserveDeltaUsdMinor`       | `reserveUsd` déclaré (≥ 0) | 0                  | 0                | delta signé (±)                                  |
| `organizationId`             | bénéficiaire               | source             | détenteur        | espace de travail de l'admin (contrainte schéma) |
| `counterpartyOrganizationId` | —                          | destination        | —                | —                                                |
| `ledgerTransactionId`        | écriture DDA               | écriture DDA       | écriture DDA     | **null** (hors registre, §5)                     |
| `status`                     | `MINTED`                   | `TRANSFERRED`      | `REDEEMED`       | `MINTED` (dépôt) / `REDEEMED` (retrait)          |

Un ajustement de réserve est **de portée plateforme** : le schéma exigeant une organisation sur chaque
ligne, l'espace personnel de l'administrateur agissant sert d'espace de comptabilisation et n'est pas exposé
comme « organisation de l'opération » (`scope: 'PLATFORM'`, `organization: null` dans le DTO, audit sans
`organizationId`).

## 5. Modèle de réserve simulée — et ses limites

**Réserve simulée (USD fictifs) = Σ `reserveDeltaUsdMinor`** des lignes de simulation (mints avec
`reserveUsd` + ajustements ±). Elle ne peut pas devenir négative (`DDA_RESERVE_NEGATIVE` → 409, sérialisé
par un verrou consultatif PostgreSQL).

**Choix de conception : la réserve n'est jamais inscrite sur le registre fiat.** Un compte
`DDA_RESERVE_SIM:USD` existe dans `account-codes.ts` mais n'est volontairement **pas** utilisé :

- inscrire des USD « de réserve » sur le registre fiat reviendrait à créer un compte libellé dans une
  devise réelle adossé à un actif fictif — le premier maillon d'un chemin de conversion, ce que la ligne
  rouge 3 interdit ;
- la réserve d'un stablecoin est, dans la réalité, un portefeuille d'actifs externes (dépôts, titres)
  attesté par des tiers : la modéliser par un simple solde interne serait trompeur ;
- l'invariant du registre (§3) reste alors purement DDA, et la réconciliation fiat
  (`docs/architecture/LEDGER.md`) n'est pas polluée par des montants qui n'existent pas.

Limites assumées du modèle :

- la réserve est **déclarative** (saisie par un administrateur), sans composition d'actifs, sans
  valorisation, sans rendement ni échéance — les options A à E de `STABLECOIN_RISKS.md` §3 ne sont pas
  modélisées ;
- un rachat (`REDEEM`) **ne libère pas** la réserve automatiquement : il n'y a aucun versement, donc la
  couverture monte mécaniquement. Un scénario réaliste exigerait un ajustement de réserve explicite ;
- aucune notion de délai de rachat, de file d'attente, de frais ni de KYC au rachat.

## 6. Ratio de couverture

`coverageRatioBps = floor(max(réserve, 0) × 10 000 / encours)` ; `null` si l'encours est nul
(aucune division par zéro). Arithmétique BigInt en unités mineures ; DDA et USD ayant tous deux
l'exposant 2, une unité mineure de DDA correspond à un cent de USD fictif **sous l'hypothèse de parité**.
Exemples : encours 1 000,00 / réserve 800,00 → 8 000 bps (80 %) ; encours 400,00 / réserve 1 000,00 →
25 000 bps (250 %).

## 7. Test de résistance (dé-ancrage / liquidité)

Entrées : `redemptionPercent` ∈ [0, 100] (défaut 30), `reserveHaircutPercent` ∈ [0, 100] (défaut 0),
converties en points de base (deux décimales). Calcul **pur** sur l'état courant (`dda-stress.ts`) :

```
redeemed              = supply × redemptionBps / 10 000
remainingSupply       = supply − redeemed
reserveAfterHaircut   = reserve × (10 000 − haircutBps) / 10 000
reserveAfterRedemptions = reserveAfterHaircut − redeemed          (rachats servis au pair : hypothèse)
shortfall             = max(0, −reserveAfterRedemptions)
coverageBefore        = coverageRatioBps(supply, reserve)
coverageAfter         = coverageRatioBps(remainingSupply, reserveAfterRedemptions)
verdict               = shortfall > 0 ? SHORTFALL : COVERED
```

Le verdict est accompagné de notes rappelant que la parité n'est pas garantie, qu'aucun marché
secondaire n'existe (aucun jeton) et qu'un déficit imposerait, dans la réalité, des délais contractuels de
rachat, une réserve plus liquide ou une sur-couverture. Rien n'est écrit en base.

## 8. Traçabilité

`GET v1/admin/dda/trace/:reference` renvoie, pour une référence `DDA-YYYY-XXXXXX` : la ligne de simulation
(organisation, contrepartie, auteur, note, métadonnées), l'écriture de registre complète (clé
d'idempotence, type, statut, lignes avec compte / sens / montant en `DDA`) et le journal d'audit
(`entityType: DigitalAssetSimulation`). Les ajustements de réserve n'ont pas d'écriture (§5) et le
renvoient explicitement (`ledgerTransaction: null`). Une référence inconnue ou mal formée → 404.

## 9. Surface d'administration

- API : `v1/admin/dda/{overview, operations?page=, holdings, organizations, trace/:reference}` (GET) et
  `{mint, transfer, redeem, reserve-adjustments, stress-test}` (POST), toutes sous `Permission.ADMIN_DDA` ;
  validation `zod` (`packages/shared/src/schemas/dda.ts`) ; erreurs métier `DomainError`
  (`DDA_CURRENCY_REQUIRED` 400, `INSUFFICIENT_FUNDS` 409, `DDA_RESERVE_NEGATIVE` 409, `NOT_FOUND` 404).
- Web : `/admin/dda` (ADMIN uniquement, sinon 404) — bandeau permanent, tuiles encours / réserve /
  couverture / détenteurs, simulateurs, testeur de résistance, détentions, opérations paginées avec liens de
  trace (`/admin/dda/trace/<reference>`), chemins de la documentation. Affichage monétaire déterministe
  (`formatMoney`, sans `Intl`).

## 10. Prérequis avant toute émission réelle (hors périmètre, non planifiée)

Aucune des conditions ci-dessous n'est remplie ni engagée ; elles sont listées pour mémoire et détaillées
dans `docs/compliance/STABLECOIN_RISKS.md` et `docs/compliance/AUTHORIZATIONS_CHECKLIST.md` :

1. avis juridiques écrits par juridiction (Canada / Québec, UEMOA, Guinée) et qualification de l'actif ;
2. autorisations et enregistrements applicables (ESM, CANAFE, BCEAO, BCRG…) ;
3. architecture de réserve réelle (comptes séparés / fiducie, attestations indépendantes, audit) ;
4. droit de rachat au pair contractuel, gestion de la liquidité, plans de résolution ;
5. gouvernance : décision formelle de la direction consignée en ADR (porte R10), revue sécurité, revue
   conformité ;
6. retrait explicite de toutes les mentions « simulation » et « non garantie » **uniquement** après les
   points 1 à 5.

Tant que ces prérequis ne sont pas réunis, **ce prototype n'émet aucun actif et ne constitue pas une
annonce d'émission**.
