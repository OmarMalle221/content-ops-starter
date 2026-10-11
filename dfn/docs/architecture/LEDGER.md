# Registre financier à double entrée

Implémentation : `packages/financial-ledger/src/ledger.service.ts` (tests : `packages/financial-ledger/test/ledger.test.ts`).

## Plan de comptes sandbox

| Compte                                      | Type      | Sens normal | Négatif autorisé | Rôle                                            |
| ------------------------------------------- | --------- | ----------- | ---------------- | ----------------------------------------------- |
| `PROVIDER_SETTLEMENT:SANDBOX_PARTNER:<ccy>` | ASSET     | DEBIT       | oui              | fonds fictifs détenus chez le partenaire simulé |
| `ESCROW:<transactionId>:<ccy>`              | LIABILITY | CREDIT      | non              | fonds séquestrés d'une transaction Protect      |
| `WALLET:<organizationId>:<ccy>`             | LIABILITY | CREDIT      | non              | solde fictif dû à une organisation              |
| `PLATFORM_FEES:<ccy>`                       | REVENUE   | CREDIT      | non              | commissions simulées                            |

## Écritures types

| Événement                | Débit                                 | Crédit                                   |
| ------------------------ | ------------------------------------- | ---------------------------------------- |
| Financement confirmé     | PROVIDER_SETTLEMENT (montant + frais) | ESCROW (montant) + PLATFORM_FEES (frais) |
| Libération d'un jalon    | ESCROW                                | WALLET vendeur                           |
| Remboursement (décision) | ESCROW                                | WALLET acheteur                          |
| Dépôt sandbox            | PROVIDER_SETTLEMENT                   | WALLET                                   |
| Contrepassation          | entrées miroir                        | entrées miroir                           |

## Garanties

- **Équilibre** : `validateEntries` refuse toute écriture déséquilibrée, multi-devise ou à montant ≤ 0 avant tout accès base ; la réconciliation re-vérifie en SQL.
- **Idempotence** : `idempotencyKey` unique ; un rejeu renvoie l'écriture existante (`replayed: true`) y compris en cas de course (gestion de `P2002`).
- **Concurrence** : `SELECT … FOR UPDATE` sur les comptes concernés, triés par id (pas d'interblocage) ; le solde est recalculé sous verrou avant de refuser un passage en négatif. Test : 25 débits concurrents de 100 sur un solde de 1 000 → exactement 10 réussissent.
- **Atomicité métier** : `post(instruction, tx)` s'exécute dans la transaction Prisma de l'appelant (approbation de jalon + libération = une seule unité).
- **Immutabilité** : aucune mise à jour/suppression d'entrée ; corrections par `reverse()` qui marque l'original `REVERSED`.
- **Réconciliation** : `reconcile()` compare chaque solde au dernier `BalanceSnapshot` + entrées postérieures, vérifie l'équilibre de chaque écriture et l'égalité globale débits/crédits par devise, et persiste `ReconciliationJob`/`ReconciliationDifference`.

## Limites connues (sandbox)

- Les snapshots sont pris à la demande (endpoint admin) ; un job périodique est prévu en phase 3.
- Les conversions de devises (phase 4) seront modélisées par deux écritures liées via un compte de compensation FX.
