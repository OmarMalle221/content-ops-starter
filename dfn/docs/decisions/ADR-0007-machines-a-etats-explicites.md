# ADR-0007 — Machines à états explicites pour les entités à cycle de vie

| Champ  | Valeur                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Statut | Accepté                                                                                                                                        |
| Date   | 2026-10-11                                                                                                                                     |
| Portée | `packages/shared/src/state-machines/`, énumérations `TransactionStatus`, `MilestoneStatus`, `DisputeStatus`, `FundingStatus`, `TransferStatus` |

## Contexte

Les entités financières de DFN traversent des états dont l'ordre a des conséquences juridiques et comptables : une libération n'est licite qu'après financement et approbation ; un litige gèle les libérations ; une annulation n'est possible que sans fonds reçus ; un transfert peut nécessiter une revue avant autorisation. Des `if` dispersés dans les services conduisent à des transitions oubliées ou contradictoires, difficiles à auditer et à expliquer à un régulateur ou à un partenaire.

## Décision

1. Chaque cycle de vie est décrit par une **table de transitions déclarative** `defineStateMachine(entity, transitions)` exposant `canTransition`, `assertTransition`, `isTerminal`, `nextStates`.
2. Cinq machines sont définies dans `@dfn/shared` et partagées par l'API et le web : `transactionMachine`, `milestoneMachine`, `disputeMachine`, `fundingMachine`, `transferMachine` (définie dès la Phase 2 pour stabiliser le contrat du module Transfer).
3. Tout changement d'état dans un service passe par `assertTransition` ; une transition invalide lève `InvalidTransitionError` traduite en `409 INVALID_TRANSITION`.
4. Les ensembles métier dérivés sont nommés : `DISPUTABLE_TRANSACTION_STATES` (`FUNDED`, `IN_PROGRESS`), `CANCELLABLE_TRANSACTION_STATES` (`DRAFT`, `PENDING_ACCEPTANCE`, `ACCEPTED`, `AWAITING_FUNDING`).
5. Les règles orthogonales aux états sont des **drapeaux explicites** et non des états supplémentaires : `Transaction.releaseFrozen` (gel des libérations pendant un litige) vérifié indépendamment de l'état.
6. Chaque transition produit un `TransactionEvent` typé (`TransactionEventType`) et, le cas échéant, une évaluation du moteur de risque.
7. Les tables de transitions sont testées unitairement (états terminaux, transitions interdites) et reproduites dans `PRODUCT_REQUIREMENTS.md` §4.3.

## Conséquences

Positives : lisibilité et auditabilité (une table = la politique) ; cohérence web/API (le front n'affiche que `nextStates`) ; détection précoce des régressions ; base pour la documentation réglementaire (quand un litige peut-il être ouvert, quand une annulation est-elle possible).

Négatives : rigidité voulue — ajouter un état exige de modifier la table, l'énumération Prisma, la migration et les tests ; les transitions conditionnelles (par exemple `DISPUTED → SETTLED` seulement si le solde séquestré est nul) restent dans les services, la machine ne vérifiant que la **possibilité** de la transition.

## Alternatives

| Alternative                                        | Raison du rejet                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Conditions ad hoc dans les services                | Source des incohérences que l'on cherche à éliminer                                                |
| Bibliothèque de machines à états complète (XState) | Puissante mais surdimensionnée pour des tables de transitions ; dépendance supplémentaire côté API |
| Workflow engine externe (Temporal, Camunda)        | Infrastructure lourde ; les cycles de vie DFN sont courts et pilotés par des actions humaines      |

## Détails de mise en œuvre

| Élément                      | Choix                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Emplacement                  | `packages/shared/src/state-machines/index.ts` (tables) et `machine.ts` (fabrique générique)                                                                                                          |
| Transactions base de données | La transition d'état, les écritures comptables et l'événement sont écrits dans la même transaction Prisma                                                                                            |
| Verrou                       | La ligne de l'entité est relue avec `FOR UPDATE` avant `assertTransition` pour éviter les transitions concurrentes contradictoires                                                                   |
| Front                        | Les boutons d'action sont dérivés de `nextStates(status)` et des permissions ; jamais de logique d'état dupliquée                                                                                    |
| Erreurs                      | `InvalidTransitionError` → `409 INVALID_TRANSITION` avec `from` et `to` dans `details`                                                                                                               |
| Tests                        | Pour chaque machine : tous les états terminaux n'ont aucune sortie ; chaque transition listée dans `PRODUCT_REQUIREMENTS.md` §4.3 est acceptée ; un échantillon de transitions interdites est refusé |

## Révision

Toute nouvelle machine (par exemple pour les factures du module Business) suit ce modèle ; toute modification de table est accompagnée d'une mise à jour de la documentation produit et de conformité qui la cite.
