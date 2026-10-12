# Isolation des organisations (tenancy) — accès du personnel et consentement des liaisons

> **Sandbox uniquement.** Rien de ce qui suit ne déplace de fonds réels : une « liaison » client ne fait
> qu'ouvrir la visibilité des factures / devis et le paiement **fictif** depuis le portefeuille sandbox.

Implémentation : `apps/api/src/modules/organizations/**` (`organizations.service.ts`,
`counterparties.service.ts`), `apps/api/src/modules/business/**`, `apps/api/src/modules/api-platform/ssrf.ts`.
Tests : `apps/api/test/tenancy.test.ts` (et `business.test.ts`). Interface : `apps/web/src/app/(app)/business/clients`
et `apps/web/src/app/(app)/business/links`.

## 1. Accès du personnel (ADMIN / COMPLIANCE) : lecture seule par défaut

Avant la phase 6, un membre du personnel était traité comme `OWNER` implicite de toute organisation.
Désormais :

| Situation                                            | Lecture | Écriture                                                                    |
| ---------------------------------------------------- | ------- | --------------------------------------------------------------------------- |
| Membre réel de l'organisation (personnel ou non)     | Oui     | Selon son **rôle d'organisation** (OWNER / ADMIN / MEMBER / VIEWER)         |
| COMPLIANCE non membre                                | Oui     | **403** (toujours)                                                          |
| ADMIN non membre                                     | Oui     | Accès « support » : `ADMIN_SUPPORT_WRITE` + motif + audit (voir ci-dessous) |
| Utilisateur non membre (ou clé API d'une autre org.) | **404** | **404** (pas de fuite d'existence)                                          |

Les routes `/v1/admin/*` ne sont pas concernées (elles relèvent de `PermissionsGuard`).

### Fonctions d'accès (`OrganizationsService`)

- `assertMember(auth, orgId, permission?, intent?)` — synchrone. L'intention se déduit de la permission
  demandée : aucune permission ou `TRANSACTION_READ` / `WALLET_READ` / `ORG_VIEW_REPORTS` = **lecture**,
  toute autre = **écriture**. Un membre du personnel non membre obtient `{ role: 'VIEWER', via: 'STAFF_READ' }`
  en lecture et un **403** en écriture. Les appelants existants n'ont donc pas eu à changer.
- `authorizeWrite(auth, orgId, permission, req)` — asynchrone, utilisée par toutes les écritures des modules
  Organisations et Business. Pour un ADMIN non membre, elle exige :
  1. la permission globale `ADMIN_SUPPORT_WRITE` (ADMIN uniquement) ;
  2. une permission « support » : `TRANSACTION_CREATE` (fiches clients), `INVOICE_MANAGE` (devis, factures,
     paiements enregistrés), `ORG_MANAGE_MEMBERS`, `ORG_MANAGE_SETTINGS` ;
  3. un motif dans l'en-tête `X-Support-Reason` (10 à 500 caractères, encodé URI s'il contient des
     caractères non ASCII) — sinon **400 `VALIDATION_FAILED`** ;
  4. puis elle écrit l'entrée d'audit `support.write` **avant** l'action (`metadata` : `support: true`,
     `reason`, `permission`, `method`, `path`, rôle global). Les audits métier de l'action portent aussi
     `support: true`.
- `resolveActingOrganization` — inchangée : **membres réels uniquement**. Le personnel n'obtient donc aucun
  accès implicite aux virements, paiements portefeuille, bénéficiaires, clés API / webhooks, transactions
  Protect ou dépôts sandbox d'un tenant (404 comme avant).
- `resolveActingOrganizationForWrite` — variante asynchrone (création de devis / factures) qui délègue à
  `authorizeWrite` lorsqu'une organisation est précisée.

Le **consentement** d'une liaison (`ORG_LINK_DECIDE`) n'est jamais délégable au support : il appartient au
tenant.

Garde-fous ajoutés après la revue adversariale de la phase 6 :

- **Membres** : une écriture de support (`via: 'STAFF_SUPPORT'`) n'invite ni son auteur ni un autre compte du
  personnel, n'accorde **que** le rôle `VIEWER` (lecture seule : `MEMBER` finance et libère le séquestre,
  paie des factures — rôles dérivés de la matrice de permissions), ne modifie ni ne retire un propriétaire,
  et la réponse d'une invitation de support ne contient pas le lien (seul l'invité le reçoit). Chaque
  invitation de support est notifiée aux OWNER / ADMIN de l'organisation et auditée avec son motif ; une
  invitation plus large émise par du personnel non membre est refusée à l'acceptation. Sans cela, un ADMIN
  pouvait faire entrer un compte « prête-nom » et déplacer de l'argent.
- **Transactions Protect** : seules les parties les annulent ; le personnel n'a aucune écriture. Une action
  de partie exige en plus la permission de son rôle dans l'organisation : `TRANSACTION_MANAGE` (conditions,
  financement et sa confirmation simulée, soumission / validation de jalon — libération du séquestre —,
  annulation, relance), `DISPUTE_OPEN` (litiges, messages, appel), `DOCUMENT_UPLOAD` (documents de la
  transaction). Un `VIEWER` de l'un ou l'autre côté lit, sans rien modifier.
- **Documents** : supprimer le document d'un autre utilisateur exige `ADMIN_SUPPORT_WRITE`, le motif
  `X-Support-Reason` et l'audit `support.write` (permission `document:delete`), même pour un ADMIN membre ;
  un appelant qui ne voit pas le document reçoit `404`.
- **`REQUIRE_STAFF_MFA=true`** : un compte du personnel sans MFA est résolu avec les droits `USER` sur
  **tous** les chemins (lectures de tenants, écritures de support, routes `/v1/admin/*` qui répondent
  `403 STAFF_MFA_REQUIRED`).

Côté interface, les `nextActions` d'un document vu par le personnel non membre se limitent à
`VIEW_DOCUMENT`, et l'espace Entreprise (`resolveWorkspace`) ne donne plus de droits implicites au
personnel : seul le rôle réel dans l'organisation compte.

## 2. Consentement des liaisons de fiches clients

Une fiche client (`Counterparty`) de l'organisation A peut être reliée à une organisation B. Une fois la
liaison **acceptée par B**, B voit les factures / devis que A lui adresse (vue « Reçues »), reçoit les
notifications correspondantes et peut payer depuis son portefeuille sandbox.

### États

```
            création avec e-mail / organisation explicite
NONE ───────────────────────────────────────────────▶ PENDING (compte éligible trouvé)
  │                                                      │  B accepte          B refuse
  │ (aucun compte : NONE + linkRequestedAt)              ▼                     ▼
  │                                                  ACCEPTED              DECLINED
  │                                                      │ A révoque            │
  └──── A retire la demande, A ou B met fin ────▶ REVOKED ◀────────────────────┘ (nouvelle demande
                                                      │                              après 24 h)
                                                      └── nouvelle demande après 24 h ──▶ PENDING / NONE
```

Invariant : `linkedOrganizationId` n'est renseigné **que** dans l'état `ACCEPTED`
(`linkRequestedOrganizationId` conserve la cible de la demande). Les liaisons antérieures à la phase 6
avaient été posées par simple correspondance d'e-mail, sans accord de la cible : la migration
`20261012040000_legacy_links_need_consent` les remet en `PENDING` (toute liaison `ACCEPTED` sans décideur
enregistré), la cible doit donc les accepter. Les liaisons acceptées par le flux de consentement ne sont pas
touchées.

### Aucune énumération des comptes

- Créer une fiche avec un e-mail renvoie **exactement la même réponse** que l'adresse corresponde ou non à un
  compte actif : `linkRequest: "SENT_IF_ELIGIBLE"`, `link.status: "REQUESTED"` (libellé « Demande envoyée si
  un compte correspond »). `NONE` et `PENDING` sont fusionnés en `REQUESTED` côté demandeur ;
  `linkRequestedOrganizationId` et le statut brut ne sont jamais exposés au demandeur.
- Le quota (**20 demandes / 24 h glissantes par organisation**, erreur `429 RATE_LIMITED`) compte **toutes**
  les tentatives, correspondance ou non (horodatage `linkRequestedAt`), sous verrou consultatif PostgreSQL.
- Seuls les OWNER / ADMIN de l'organisation cible sont notifiés (« <organisation> souhaite vous relier comme
  client — accepter/refuser ») ; l'audit `counterparty.link_requested` est rattaché à l'organisation cible
  (journal visible du seul personnel).
- Les états `DECLINED` / `ACCEPTED` sont visibles du demandeur : ils résultent d'une décision explicite de la
  cible.
- Le délai de 24 h après un refus ou une fin de liaison vaut pour **le couple demandeur / cible**, quelle
  que soit la fiche : créer une nouvelle fiche avec le même e-mail ne rouvre pas la décision. La demande
  n'est alors simplement pas envoyée, avec la même réponse que pour toute autre adresse.
- Phase 7 — **résolution après la réponse** : pour un e-mail, la requête ne fait que vérifier le quota,
  enregistrer la fiche (`linkRequestedAt`, `linkResolvedAt` vide) et son audit, travail identique qu'un
  compte corresponde ou non. La recherche du compte, le délai de 24 h, le passage en `PENDING`, l'audit
  côté cible et la notification ont lieu **après** la réponse (`resolveLinkRequest`, transaction à
  comparaison-échange sur `linkResolvedAt` : une demande retirée ou renouvelée entre-temps n'est jamais
  résolue). Une demande restée non résolue (arrêt du processus entre les deux) est reprise une minute plus
  tard par n'importe quelle réplique. Une cible explicite (organisation dont l'appelant est membre) est
  résolue immédiatement : elle ne révèle rien.

### Points d'API

| Côté      | Route                                                                        | Droit                                   |
| --------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| Demandeur | `GET /v1/organizations/:id/counterparties`                                   | lecture (membres, personnel)            |
| Demandeur | `POST /v1/organizations/:id/counterparties`                                  | `TRANSACTION_CREATE` (support possible) |
| Demandeur | `POST /v1/organizations/:id/counterparties/:cpId/link/request`               | `TRANSACTION_CREATE` (support possible) |
| Demandeur | `POST /v1/organizations/:id/counterparties/:cpId/link/revoke`                | `TRANSACTION_CREATE` (support possible) |
| Cible     | `GET /v1/organizations/:id/link-requests?status=PENDING\|ACCEPTED\|DECLINED` | `ORG_LINK_DECIDE` (personnel : lecture) |
| Cible     | `POST /v1/organizations/:id/link-requests/:cpId/accept` / `…/decline`        | `ORG_LINK_DECIDE` (membres réels)       |
| Cible     | `POST /v1/organizations/:id/link-requests/:cpId/revoke` (fin de liaison)     | `ORG_LINK_DECIDE` (membres réels)       |

Erreurs : `LINK_NOT_PENDING` (409) pour une décision ou une révocation sans demande / liaison active,
`CONFLICT` (409) pour une nouvelle demande alors qu'une demande ou une liaison est en cours,
`RATE_LIMITED` (429, `details.retryAt`) pour le quota et le délai de 24 h après refus / révocation.
Chaque étape est auditée (`counterparty.created`, `…link_requested`, `…link_rerequested`,
`…link_accepted`, `…link_declined`, `…link_revoked`).

### Effets tant que la liaison n'est pas acceptée

- `documentAccessFor` ne donne le rôle `CUSTOMER` qu'avec une liaison `ACCEPTED` : la cible obtient **404**
  sur les factures / devis et ne les voit pas dans la vue `RECEIVED`.
- Aucune notification de facture / devis (envoi, annulation, paiement) n'atteint la cible ; une simple adresse
  e-mail saisie sur un document ne notifie plus personne sur la plateforme.
- Le paiement `WALLET_SIMULATED` est refusé (404 / `WALLET_PAYMENT_NOT_AVAILABLE`), et l'événement webhook
  `invoice.paid` n'est adressé à l'organisation cliente qu'après acceptation.
- Une révocation coupe immédiatement ces accès (y compris sur les factures déjà payées).

## 3. Taux de taxe persisté

`Invoice.taxBps` / `Quote.taxBps` sont enregistrés à la création, à la modification et lors de la conversion
devis → facture. Une modification qui ne renvoie pas `taxBps` conserve **exactement** le taux stocké. La
déduction depuis les montants arrondis (`deriveTaxBps`) ne sert plus qu'en **lecture** pour les lignes
historiques (`taxBps = 0` avec `taxMinor > 0`) — elle est inexacte (1333 pb sur 1,00 relu comme 1300 pb).

## 4. Liste blanche des destinations webhook

`WEBHOOK_ALLOWED_HOSTS` (facultatif) : liste séparée par des virgules d'hôtes exacts ou de motifs
`*.suffixe` (sous-domaines uniquement, pas le suffixe nu ; sans port ; insensible à la casse). Lorsqu'elle
est définie, tout autre hôte est refusé à l'abonnement (création / modification, `422 WEBHOOK_URL_FORBIDDEN`)
et à l'envoi (`unsafeDestinationReason`), **y compris en `NODE_ENV=test`**. Elle ne lève jamais les
contrôles d'adresses privées existants.
