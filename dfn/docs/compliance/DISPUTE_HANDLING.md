# Politique de traitement des litiges — Diaspora Protect

> **Ce document est une liste de préparation et ne constitue pas un avis juridique.** La politique de litiges, les conditions d'utilisation et les clauses contractuelles doivent être validées par un conseiller juridique (droit de la consommation et droit des contrats au Québec, droit sénégalais et guinéen pour l'opposabilité aux vendeurs) avant toute activité réelle. Aucune obligation n'est réputée satisfaite parce qu'une fonctionnalité existe dans le produit. En sandbox, les litiges portent sur des montants fictifs.

| Champ                | Valeur                                                                                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code concerné        | `disputeMachine`, `DISPUTABLE_TRANSACTION_STATES` (`packages/shared/src/state-machines/index.ts`) ; schémas `openDisputeSchema`, `disputeMessageSchema`, `disputeDecisionSchema`, `appealDisputeSchema` ; modèles `Dispute`, `DisputeMessage`, `DisputeDecision`, `Evidence` ; champ `Transaction.releaseFrozen` |
| Clause contractuelle | Gabarit `DFN_PROTECT_CONDITIONAL_PAYMENT` v1.0.0-sandbox, section 6 « Litiges »                                                                                                                                                                                                                                  |
| Statut               | Ébauche v0.1                                                                                                                                                                                                                                                                                                     |
| Porte réglementaire  | R9 (`ROADMAP.md` §9)                                                                                                                                                                                                                                                                                             |

---

## 1. Objectifs

1. Protéger l'acheteur contre la non-livraison ou la non-conformité et le vendeur contre la rétention abusive des fonds.
2. Garantir qu'aucune libération n'intervient pendant l'examen d'une contestation.
3. Rendre des décisions **motivées, traçables et contestables**.
4. Rester dans le rôle de la plateforme : DFN tranche la **libération des fonds séquestrés** selon le contrat numérique ; elle ne rend pas de jugement sur la responsabilité civile et n'empêche pas les recours judiciaires ou la médiation externe.

## 2. Conditions d'ouverture

| Condition   | Règle                                                                                                                                                                                                        | Mise en œuvre                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Qui         | L'acheteur ou le vendeur, via une partie acceptée (`TransactionParty.status = ACCEPTED`)                                                                                                                     | `openedByPartyId` ; permission `dispute:open` (`OWNER`, `ADMIN`, `MEMBER`) |
| Quand       | Uniquement lorsque des fonds sont détenus : transaction `FUNDED` ou `IN_PROGRESS`                                                                                                                            | `DISPUTABLE_TRANSACTION_STATES` ; sinon `INVALID_TRANSITION`               |
| Motif       | `NOT_DELIVERED`, `NOT_AS_DESCRIBED`, `DAMAGED`, `DOCUMENT_MISMATCH`, `PAYMENT_ISSUE`, `OTHER`                                                                                                                | `DisputeReason`                                                            |
| Description | 20 à 5 000 caractères                                                                                                                                                                                        | `openDisputeSchema`                                                        |
| Preuves     | 0 à 10 documents à l'ouverture, ajout possible ensuite                                                                                                                                                       | `Evidence(disputeId)`                                                      |
| Unicité     | Un seul litige actif par transaction ; une nouvelle contestation après clôture doit porter sur un fait nouveau                                                                                               | À implémenter (vérification côté service)                                  |
| Fenêtre     | Pendant la fenêtre d'inspection du contrat (`inspectionWindowDays`, 0–30 jours, 5 par défaut) ou tant qu'un jalon n'est pas libéré ; les jalons déjà `RELEASED` ne sont pas remis en cause par la plateforme | Vérification à documenter dans les CGU                                     |

## 3. Gel automatique des libérations

| Effet        | Détail                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| État         | Transaction → `DISPUTED` ; `releaseFrozen = true` ; événement `release.frozen`                                    |
| Blocage      | Toute approbation / libération de jalon renvoie `RELEASE_FROZEN` ; les soumissions de preuves restent possibles   |
| Portée       | Tous les jalons non libérés de la transaction ; les montants déjà libérés ne sont pas récupérés par la plateforme |
| Levée        | Uniquement par l'exécution d'une décision finale ou le classement (`DISMISSED`) ; événement `release.unfrozen`    |
| Notification | Les deux parties sont notifiées (in-app, e-mail) de l'ouverture et du gel                                         |

## 4. Preuves

| Type (`DocumentKind`)                            | Usage typique                          | Partie   |
| ------------------------------------------------ | -------------------------------------- | -------- |
| `PROOF_OF_SHIPMENT`, `BILL_OF_LADING`, `CUSTOMS` | Preuve d'expédition et de dédouanement | Vendeur  |
| `INSPECTION_REPORT`, `PHOTO`                     | Conformité ou défaut du bien           | Les deux |
| `INVOICE`, `PROFORMA`, `RECEIPT`, `CONTRACT`     | Conditions convenues                   | Les deux |
| `OTHER`                                          | Échanges, expertises                   | Les deux |

Règles : hash SHA-256 à la réception, contrôle `DOCUMENT_REUSE`, chiffrement, revue conformité (`PENDING_REVIEW` → `ACCEPTED` / `REJECTED`), horodatage ; les preuves sont visibles par les deux parties et par l'équipe de revue.

## 5. Fenêtres de réponse (cibles, à confirmer dans les CGU)

| Étape                                                  | Délai                                                                | Conséquence du dépassement                            |
| ------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------- |
| Réponse de l'autre partie après ouverture              | 5 jours ouvrés                                                       | La revue démarre sur la base des éléments disponibles |
| Prise en charge par l'équipe de revue (`UNDER_REVIEW`) | 2 jours ouvrés après l'ouverture ou la fin de la fenêtre de réponse  | Indicateur de SLA                                     |
| Demande d'informations complémentaires                 | 5 jours ouvrés pour répondre                                         | Décision sur pièces                                   |
| Décision                                               | 10 jours ouvrés après prise en charge                                | Information des parties sur le retard                 |
| Appel / demande de révision                            | Avant `appealDeadline` (par défaut 7 jours civils après la décision) | La décision devient exécutoire                        |
| Décision d'appel                                       | 10 jours ouvrés                                                      | Idem                                                  |

## 6. Revue

| Principe           | Mise en œuvre                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Impartialité       | Agent `COMPLIANCE` sans lien avec les parties ; `assignedToUserId` ; conflit d'intérêts déclaré                        |
| Contradictoire     | Chaque partie voit les messages et preuves de l'autre ; les notes internes (`internal = true`) ne sont jamais exposées |
| Référentiel        | Contrat numérique accepté (`ContractVersion.bodyText`, `terms`), preuves requises par jalon, historique des événements |
| Contexte de risque | Alertes `MULTI_DISPUTE_ACCOUNT`, `DOCUMENT_REUSE` consultées à titre d'information ; elles ne décident pas             |
| Traçabilité        | Chaque consultation et action est journalisée (`AuditLog`)                                                             |
| Escalade interne   | Litiges > seuil interne (par exemple 15 000 CAD équivalents, à définir) ou impliquant une alerte `HIGH` : double revue |

## 7. Décision motivée

| Élément    | Exigence                                                                                                                                                  | Champ                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Issue      | Une des quatre issues                                                                                                                                     | `DisputeDecision.outcome`               |
| Montants   | Pour `SPLIT` : `sellerAmount` et `buyerAmount` obligatoires, somme égale au solde séquestré non libéré ; pour les autres issues, calculés automatiquement | `sellerAmountMinor`, `buyerAmountMinor` |
| Motivation | 20 à 5 000 caractères : faits retenus, clauses appliquées, preuves déterminantes, raisons d'écarter les autres                                            | `rationale`                             |
| Caractère  | `isFinal = false` ouvre un délai d'appel ; `isFinal = true` clôt la voie interne                                                                          | `isFinal`, `appealDeadline`             |
| Auteur     | Agent identifié                                                                                                                                           | `decidedByUserId`                       |
| Exécution  | Horodatée après écriture comptable                                                                                                                        | `executedAt`                            |

### Issues et effets comptables

| Issue               | Signification                               | Écritures                                                                                             | États résultants                                                                                      |
| ------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `RELEASE_TO_SELLER` | La prestation est jugée conforme au contrat | `RELEASE` : débit `ESCROW:<tx>`, crédit `WALLET:<vendeur>` (net) + `FEE` vers `PLATFORM_FEES`         | Jalons concernés `RELEASED` ; transaction `SETTLED` si plus rien n'est séquestré, sinon `IN_PROGRESS` |
| `REFUND_TO_BUYER`   | Non-livraison ou non-conformité établie     | `REFUND` : débit `ESCROW:<tx>`, crédit `WALLET:<acheteur>` (ou compte de remboursement du partenaire) | Jalons `REFUNDED` ; transaction `REFUNDED`                                                            |
| `SPLIT`             | Conformité partielle                        | `RELEASE` partiel + `REFUND` partiel                                                                  | Selon les montants ; `SETTLED` ou `REFUNDED`                                                          |
| `DISMISSED`         | Contestation non fondée ou retirée          | Aucune                                                                                                | `releaseFrozen = false` ; transaction revient à `IN_PROGRESS` (ou `FUNDED`) ; le cycle normal reprend |

Les frais de plateforme (`feeBps`) sont prélevés sur la part libérée au vendeur ; la politique de frais en cas de remboursement (remboursement intégral des frais à l'acheteur en sandbox) doit être confirmée dans les CGU.

## 8. Appel et révision

1. La partie qui conteste la décision dépose des motifs (20–5 000 caractères, `appealDisputeSchema`) avant `appealDeadline`.
2. Le litige passe `APPEALED` ; la décision initiale n'est pas exécutée.
3. Un agent différent (lorsque l'effectif le permet) réexamine le dossier ; des pièces nouvelles peuvent être admises.
4. Une nouvelle `DisputeDecision` est rendue, normalement `isFinal = true`.
5. Toutes les décisions successives sont conservées ; aucune n'est modifiée ou supprimée.
6. Au-delà de la voie interne : médiation externe (§10) et tribunaux compétents ; la plateforme exécute toute décision de justice ou de l'autorité compétente qui lui est notifiée.

## 9. Conservation

| Élément                              | Durée                                                               | Remarque                                                                           |
| ------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Litige, messages, décisions, preuves | 5 ans après clôture (à confirmer ; aligné sur `DATA_PROTECTION.md`) | Anonymisation des textes en fin de rétention ; conservation des montants et issues |
| Événements de transaction            | Identique à la transaction                                          | Immuables                                                                          |
| Notes internes                       | Identique                                                           | Jamais communiquées aux parties, communicables aux autorités                       |

## 10. Protection du consommateur et recours externes

| Thème                                                                                                        | Analyse préliminaire                                                                                                                                                                                                                                                                                                                                                     | À confirmer par le conseil                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Loi sur la protection du consommateur (Québec, LPC)** et **Office de la protection du consommateur (OPC)** | Lorsque l'acheteur est un consommateur résidant au Québec, les règles sur les contrats à distance, les divulgations préalables, la résolution et les recours peuvent s'appliquer à la relation acheteur–vendeur et à la relation acheteur–plateforme ; les CGU doivent être rédigées en conséquence (langue française, clauses interdites, information précontractuelle) | Qualification du contrat de plateforme ; applicabilité des règles sur les contrats à distance lorsque le vendeur est à l'étranger ; obligations de DFN comme intermédiaire |
| Rétrofacturation                                                                                             | La LPC prévoit un mécanisme de rétrofacturation pour les paiements par carte de crédit ; DFN n'accepte pas de carte en sandbox                                                                                                                                                                                                                                           | Impact si un partenaire accepte des cartes                                                                                                                                 |
| Clauses de la convention                                                                                     | Choix de la loi applicable (« Canada (Québec) » par défaut), clause d'arbitrage/médiation, langue                                                                                                                                                                                                                                                                        | Validité des clauses face aux consommateurs québécois et aux vendeurs sénégalais/guinéens                                                                                  |
| Information précontractuelle                                                                                 | Frais (150 bps), délais, procédure de litige, caractère sandbox                                                                                                                                                                                                                                                                                                          | Présente dans le contrat numérique ; à aligner avec la LPC                                                                                                                 |
| Code civil du Québec                                                                                         | Règles générales des contrats, mandat, dépôt ; qualification du séquestre                                                                                                                                                                                                                                                                                                | Avis attendu                                                                                                                                                               |
| Sénégal / Guinée                                                                                             | Opposabilité du contrat électronique et des décisions de la plateforme aux vendeurs ; droit OHADA des contrats commerciaux ; Acte uniforme OHADA relatif à la médiation (2017) et à l'arbitrage                                                                                                                                                                          | Avis local                                                                                                                                                                 |
| Médiation externe                                                                                            | Proposer une médiation volontaire avant toute action : Québec — organismes de médiation reconnus (par exemple l'Institut de médiation et d'arbitrage du Québec) ; Sénégal — Centre d'Arbitrage, de Médiation et de Conciliation de la Chambre de commerce de Dakar ; Guinée — centre d'arbitrage local (à identifier)                                                    | Sélection et convention                                                                                                                                                    |
| Autorités                                                                                                    | OPC (Québec), autorités de protection des consommateurs au Sénégal et en Guinée ; coordonnées à afficher                                                                                                                                                                                                                                                                 | —                                                                                                                                                                          |

## 11. Indicateurs

| Indicateur                                                  | Cible                                |
| ----------------------------------------------------------- | ------------------------------------ |
| Délai médian ouverture → décision                           | ≤ 15 jours ouvrés                    |
| Décisions sans `rationale` substantielle (< 100 caractères) | 0                                    |
| Taux d'appel                                                | Suivi ; analyse si > 20 %            |
| Décisions infirmées en appel                                | Suivi ; revue des critères si > 25 % |
| Litiges par 100 transactions financées                      | Suivi par corridor                   |

## 12. Checklist

- [ ] Faire valider la politique, les CGU et la clause 6 du contrat numérique par le conseil (Québec, Sénégal, Guinée).
- [ ] Fixer et publier les fenêtres de réponse et le délai d'appel ; les coder (`appealDeadline`).
- [ ] Implémenter la règle « un seul litige actif par transaction » et la limite de la fenêtre d'inspection.
- [ ] Définir la politique de frais en cas de remboursement et l'intégrer au contrat.
- [ ] Mettre en place la double revue au-delà du seuil interne.
- [ ] Sélectionner les organismes de médiation externe et rédiger la clause correspondante.
- [ ] Afficher les coordonnées des autorités de protection des consommateurs.
- [ ] Former les agents à la rédaction de décisions motivées ; grille de motivation type.
- [ ] Mesurer les indicateurs et les revoir trimestriellement.

## 13. Questions ouvertes pour le conseil

1. Le mécanisme de paiement conditionnel et la décision de la plateforme sur la libération des fonds sont-ils compatibles avec la LPC lorsque l'acheteur est un consommateur québécois ?
2. La clause de médiation/arbitrage est-elle opposable à un consommateur québécois et à un vendeur sénégalais ou guinéen ?
3. Quelles mentions précontractuelles minimales la LPC impose-t-elle pour un contrat à distance conclu via la plateforme ?
4. Les décisions de la plateforme peuvent-elles être exécutées (remboursement sortant) sans ordonnance lorsque le vendeur conteste devant un tribunal local ?
5. Quelle durée de conservation des dossiers de litiges est requise ou recommandée ?
