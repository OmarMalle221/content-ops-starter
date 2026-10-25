# ADR-0006 — Stockage des documents chiffrés au repos avec accès contrôlé

| Champ  | Valeur                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------- |
| Statut | Accepté, complété par l'ADR-0010 (stockage objet S3-compatible et trousseau de clés, phase 6)           |
| Date   | 2026-10-11                                                                                              |
| Portée | Modèle `Document`, module documents de l'API, `STORAGE_DIR`, `DOCUMENT_ENCRYPTION_KEY`, `MAX_UPLOAD_MB` |

## Contexte

Les utilisateurs téléversent des pièces d'identité, des extraits d'immatriculation, des preuves commerciales (connaissements, factures, photos) et des pièces de litige. Ces fichiers sont parmi les données les plus sensibles de la plateforme (LPRPDE, Loi 25, loi 2008-12). Ils doivent être intègres (preuve), confidentiels (chiffrement, accès restreint), traçables (qui a consulté quoi) et soumis à une rétention définie. La sandbox tourne en local ; la production future utilisera un stockage objet.

## Décision

1. **Validation à la réception** : allowlist MIME (`application/pdf`, `image/jpeg`, `image/png`, `image/webp`), taille maximale `MAX_UPLOAD_MB` (15 Mo) appliquée en flux, vérification des **magic bytes** ; rejet `UNSUPPORTED_FILE`.
2. **Intégrité** : calcul du `sha256` à la réception ; stocké dans `Document.sha256` ; réutilisé par la règle de risque `DOCUMENT_REUSE` (empreinte déjà vue sur d'autres transactions).
3. **Chiffrement au repos** : AES-256-GCM avec `DOCUMENT_ENCRYPTION_KEY` (32 octets), IV aléatoire par fichier, tag d'authentification conservé ; `Document.encrypted = true` ; les octets ne transitent jamais par PostgreSQL.
4. **Nom opaque** : `storageKey` UUID ; le nom d'origine nettoyé n'est conservé qu'en base.
5. **Accès contrôlé** : téléchargement via une route authentifiée qui revérifie l'appartenance à l'organisation ou la qualité de partie à la transaction, puis déchiffre en mémoire et répond en `Content-Disposition: attachment` ; chaque téléchargement est journalisé (`AuditLog`).
6. **Cycle de vie** : revue conformité (`PENDING_REVIEW` → `ACCEPTED` / `REJECTED`), suppression logique (`deletedAt`), rétention (`retentionUntil`) alimentant une tâche d'anonymisation / suppression.
7. **Abstraction** : interface de stockage (`put`, `get`, `delete`) implémentée par un adaptateur local (`STORAGE_DIR`) aujourd'hui, S3-compatible demain, sans changement de modèle.

## Conséquences

Positives : fuite du stockage sans la clé = données inexploitables ; preuve d'intégrité pour les litiges ; détection de fraude documentaire ; conformité facilitée (minimisation, rétention, journal d'accès).

Négatives : la clé unique est un point critique (sauvegarde séparée, rotation documentée : déchiffrer avec l'ancienne, rechiffrer avec la nouvelle) ; déchiffrement en mémoire limite la taille des fichiers (15 Mo acceptable) ; pas d'antivirus en Phase 2 ; `DOCUMENT_ENCRYPTION_KEY` est aussi utilisée pour les secrets MFA — séparation en deux clés et KMS prévus en Phase 3.

## Alternatives

| Alternative                                                                    | Raison du rejet                                                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Fichiers en clair sur disque / S3 avec chiffrement côté fournisseur uniquement | Dépend de la configuration de l'hébergeur ; une erreur d'ACL exposerait des pièces d'identité                                   |
| Stockage des blobs en base (`bytea`)                                           | Alourdit les sauvegardes et la base transactionnelle ; aucun avantage                                                           |
| Chiffrement côté client (navigateur)                                           | La conformité doit pouvoir examiner les documents ; gestion de clés utilisateur trop complexe pour le public visé               |
| URL signées directes vers le stockage                                          | Envisageable en Phase 3 avec S3 + chiffrement serveur et KMS ; aujourd'hui la route API garantit le contrôle d'accès et l'audit |

## Détails de mise en œuvre

| Élément                   | Choix                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | --- | --------------- | --- | ------------------------------------------------------------------------------- |
| Format du blob            | `IV (12 octets)                                                                                             |     | tag (16 octets) |     | chiffré` ; version de format en préfixe pour permettre la rotation d'algorithme |
| Clé                       | `DOCUMENT_ENCRYPTION_KEY` (hex 64 caractères) ; refus de démarrage si valeur d'exemple hors développement   |
| Vérification à la lecture | Tag GCM vérifié ; `sha256` recalculé et comparé à `Document.sha256` ; divergence journalisée comme incident |
| Journal d'accès           | `AuditLog(action = document.downloaded, entityId = documentId)` avec acteur et IP                           |
| Quotas                    | Taille cumulée par organisation surveillée (alerte au-delà de 2 Go en sandbox)                              |
| Antivirus                 | Prévu en file BullMQ ; en attendant, les documents restent `PENDING_REVIEW` jusqu'à revue humaine           |

## Révision

Lors de la migration S3 : conserver le chiffrement applicatif (défense en profondeur) en plus du chiffrement côté serveur, ou documenter explicitement la décision de s'appuyer sur KMS seul.
