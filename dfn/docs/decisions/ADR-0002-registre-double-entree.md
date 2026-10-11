# ADR-0002 — Registre comptable à double entrée, montants entiers, idempotence et contre-passations

| Champ  | Valeur                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Statut | Accepté                                                                                                                                    |
| Date   | 2026-10-11                                                                                                                                 |
| Portée | `packages/financial-ledger`, modèles `LedgerAccount`, `LedgerTransaction`, `LedgerEntry`, `BalanceSnapshot`, `ReconciliationJob`, `Wallet` |

## Contexte

Diaspora Protect séquestre des montants (fictifs en sandbox) et les libère par jalons ; Diaspora Wallet affiche des soldes ; les litiges produisent des libérations partielles et des remboursements. Les régulateurs et partenaires attendent une **traçabilité intégrale** : qui a bougé quoi, quand, pourquoi, et la capacité de prouver qu'aucun montant n'a disparu ni été créé. Les approches « solde stocké dans une colonne » exposent à des incohérences sous concurrence et à des corrections silencieuses. Les nombres flottants sont inadaptés aux montants.

## Décision

1. **Double entrée stricte** : chaque `LedgerTransaction` comporte au moins deux `LedgerEntry` ; la somme des débits égale la somme des crédits ; une seule devise par écriture (`validateEntries`). Le change sera modélisé par deux écritures liées via un compte de compensation.
2. **Montants entiers** : `BigInt` en unités mineures (`amountMinor`) + code ISO 4217 ; exposant par devise (`XOF`, `GNF` = 0). Aucune arithmétique en virgule flottante ; frais calculés en basis points avec arrondi demi-supérieur entier (`computeFeeMinor`).
3. **Soldes dérivés** : un solde est toujours la somme signée des écritures (`computeBalance` selon `normalBalance`) ; `BalanceSnapshot` sert à accélérer et à vérifier la continuité, jamais de source de vérité. `Wallet` pointe vers un `LedgerAccount`, il ne stocke aucun montant.
4. **Idempotence** : `LedgerTransaction.idempotencyKey` unique ; une clé déjà vue renvoie l'écriture existante (`replayed: true`), y compris en cas de course (`P2002` intercepté).
5. **Concurrence** : verrouillage `SELECT … FOR UPDATE` des comptes concernés dans un ordre déterministe (par identifiant) au sein d'une transaction `ReadCommitted` ; projection des soldes pour refuser tout passage négatif d'un compte `allowNegative = false` (`INSUFFICIENT_FUNDS`) ; `version` incrémentée à chaque écriture.
6. **Immutabilité** : aucune mise à jour ni suppression d'écriture ; les corrections sont des **contre-passations** (`reverse()`), écritures miroir liées par `reversesId`, l'original passant à `REVERSED`.
7. **Réconciliation** : `reconcile()` recalcule tous les soldes, vérifie la continuité avec les instantanés, détecte les écritures déséquilibrées et compare débits et crédits globaux par devise ; résultats persistés (`ReconciliationJob`, `ReconciliationDifference`).
8. **Plan comptable stable** : `PROVIDER_SETTLEMENT:<fournisseur>:<ccy>` (actif), `ESCROW:<transaction>:<ccy>` (passif), `WALLET:<organisation>:<ccy>` (passif), `PLATFORM_FEES:<ccy>` (produit).

## Conséquences

Positives : preuve comptable complète pour l'audit et les partenaires ; impossibilité structurelle de double libération ; rejeu sûr des webhooks partenaires ; base directe pour la protection des fonds (LAPD) et le cantonnement (BCEAO) en phase live.

Négatives : coût d'écriture plus élevé (verrous, calculs) ; un compte `ESCROW` par transaction multiplie les comptes (acceptable, indexé par `ownerType, ownerId`) ; nécessité de discipline dans la génération des clés d'idempotence (convention `<domaine>:<entité>:<action>`) ; complexité du change différée à la Phase 4.

## Alternatives

| Alternative                                   | Raison du rejet                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Colonne `balance` mise à jour en place        | Incohérences sous concurrence, pas d'historique, corrections invisibles                                      |
| Montants en `Decimal` / `float`               | Erreurs d'arrondi, sérialisation JSON ambiguë ; `BigInt` + exposant est exact et simple                      |
| Journal d'événements (event sourcing) complet | Puissant mais plus lourd ; la double entrée fournit déjà l'invariant recherché avec des requêtes SQL simples |
| Service de registre externe                   | Dépendance et coût prématurés ; les interfaces restent compatibles avec une externalisation future           |

## Écritures de référence du module Protect

| Événement                   | Clé d'idempotence (convention)         | Débit                                       | Crédit                         |
| --------------------------- | -------------------------------------- | ------------------------------------------- | ------------------------------ |
| Financement confirmé        | `funding:<fundingRequestId>:confirmed` | `PROVIDER_SETTLEMENT:SANDBOX_PARTNER:<ccy>` | `ESCROW:<transactionId>:<ccy>` |
| Libération d'un jalon (net) | `release:<milestoneId>`                | `ESCROW:<transactionId>:<ccy>`              | `WALLET:<sellerOrgId>:<ccy>`   |
| Frais de plateforme         | `fee:<milestoneId>`                    | `ESCROW:<transactionId>:<ccy>`              | `PLATFORM_FEES:<ccy>`          |
| Remboursement               | `refund:<transactionId>:<decisionId>`  | `ESCROW:<transactionId>:<ccy>`              | `WALLET:<buyerOrgId>:<ccy>`    |
| Contre-passation            | `reversal:<ledgerTransactionId>`       | Entrées miroir                              | Entrées miroir                 |

## Points de vérification en revue de code

- Toute écriture passe par `LedgerService.post` ; aucun `prisma.ledgerEntry.create` direct.
- Les clés d'idempotence sont dérivées d'identifiants métier, jamais d'horodatages.
- Les tests de concurrence (N libérations simultanées) restent verts ; `reconcile()` est exécuté en fin de suite d'intégration.
