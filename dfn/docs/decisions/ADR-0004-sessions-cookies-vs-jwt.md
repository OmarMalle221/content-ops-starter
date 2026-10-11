# ADR-0004 — Sessions persistées en base et cookies httpOnly plutôt que JWT

| Champ  | Valeur                                                                      |
| ------ | --------------------------------------------------------------------------- |
| Statut | Accepté                                                                     |
| Date   | 2026-10-11                                                                  |
| Portée | Authentification web (`apps/api` module auth, `apps/web`), modèle `Session` |

## Contexte

La plateforme manipule des décisions financières (libérations, remboursements) et des données sensibles (pièces d'identité). Les exigences : révocation immédiate (déconnexion, changement de mot de passe, suspension par un administrateur), élévation de session après MFA, traçabilité des sessions (IP, user-agent, dernière activité), protection contre le vol de jeton côté client. Les JWT sans état sont populaires mais rendent la révocation et l'élévation MFA difficiles sans réintroduire un état serveur.

## Décision

1. **Sessions côté serveur** : à la connexion, l'API génère un jeton aléatoire à haute entropie, stocke uniquement son hachage (`Session.tokenHash`), avec `userId`, `expiresAt` (TTL `SESSION_TTL_HOURS`, 12 h par défaut), `revokedAt`, `mfaVerified`, `ip`, `userAgent`, `lastSeenAt`.
2. **Transport par cookie** : `dfn_session`, `httpOnly`, `SameSite=Lax`, `Secure` dès `COOKIE_SECURE=true`, `Path=/`. Aucun jeton en `localStorage`, aucun en-tête `Authorization` pour le web.
3. **Révocation** : `revokedAt` renseigné à la déconnexion ; toutes les sessions révoquées au changement de mot de passe ou à la suspension (`User.status`).
4. **MFA** : `mfaVerified = false` jusqu'à validation TOTP ; les routes sensibles exigent une session élevée (`MFA_REQUIRED`).
5. **CSRF** : `SameSite=Lax` + vérification de l'en-tête `Origin` sur les méthodes non sûres.
6. **API publique (Phase 5)** : clés API hachées (`ApiCredential.keyHash`) transmises en en-tête, distinctes des sessions web ; les JWT ne sont pas retenus non plus pour ce canal.

## Conséquences

Positives : révocation instantanée ; liste des sessions actives consultable par l'utilisateur et l'administration ; élévation MFA naturelle ; surface d'attaque XSS réduite (cookie inaccessible au script) ; audit par session.

Négatives : une lecture en base par requête (indexée sur `tokenHash` unique ; cache court possible) ; nettoyage périodique des sessions expirées (tâche BullMQ) ; cookies et CORS à configurer avec soin entre `WEB_PUBLIC_URL` et `API_PUBLIC_URL` (`CORS_ORIGINS`, `credentials: true`).

## Alternatives

| Alternative                            | Raison du rejet                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JWT sans état (access + refresh)       | Révocation impossible avant expiration sans liste noire (donc état serveur) ; élévation MFA complexe ; stockage côté client tentant (`localStorage`) et exposé au XSS |
| JWT courts + liste de révocation Redis | Réintroduit l'état tout en ajoutant la complexité de signature/rotation de clés ; aucun avantage net pour un monolithe                                                |
| Sessions en Redis uniquement           | Perte de la piste d'audit durable et dépendance à Redis (optionnel en développement) ; PostgreSQL suffit aux volumes visés                                            |
| Fournisseur d'identité externe (OIDC)  | Dépendance et coût prématurés ; envisageable plus tard pour le SSO des organisations `BUSINESS`                                                                       |

## Détails de mise en œuvre

| Élément              | Choix                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --- | -------------------------------------------------------------------- |
| Génération du jeton  | 32 octets aléatoires (`crypto.randomBytes`), encodés en base64url                                                                     |
| Stockage             | `sha256(SESSION_SECRET                                                                                                                |     | token)`dans`Session.tokenHash` ; le jeton brut n'est jamais persisté |
| Expiration glissante | `lastSeenAt` mis à jour au plus une fois par minute ; `expiresAt` fixe (12 h) ; renouvellement par reconnexion                        |
| Nettoyage            | Tâche BullMQ quotidienne supprimant les sessions expirées ou révoquées depuis plus de 90 jours                                        |
| Erreurs              | `401 UNAUTHENTICATED` (absence/expiration/révocation), `403 MFA_REQUIRED` (session non élevée), `423`/`ACCOUNT_LOCKED` (verrouillage) |
| Liste des sessions   | Route utilisateur listant ses sessions actives (IP tronquée, user-agent, dernière activité) avec révocation individuelle              |

## Révision

Réévaluer lorsque l'API publique (Phase 5) ou un SSO d'entreprise sera mis en place ; les sessions web restent le mécanisme du navigateur.
