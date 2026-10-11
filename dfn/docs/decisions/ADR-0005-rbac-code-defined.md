# ADR-0005 — Matrice RBAC définie en code ; tables `Role` / `Permission` différées

| Champ  | Valeur                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| Statut | Accepté (révision prévue Phase 3)                                                                          |
| Date   | 2026-10-11                                                                                                 |
| Portée | `packages/shared/src/permissions.ts`, énumérations `GlobalRole`, `OrgRole`, gardes d'autorisation de l'API |

## Contexte

Les autorisations doivent être **évaluées côté serveur pour chaque opération**, auditées facilement et partagées avec le front (pour masquer les contrôles inutiles, jamais comme frontière de sécurité). Deux dimensions coexistent : le rôle global (`USER`, `COMPLIANCE`, `ADMIN`) et le rôle dans chaque organisation (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`). Les besoins actuels sont stables et peu nombreux (16 permissions). Un modèle de rôles dynamiques en base (tables `Role`, `Permission`, `RolePermission`) apporterait de la flexibilité, mais aussi un risque de dérive (permissions accordées sans revue) et une complexité de test.

## Décision

1. La matrice est une **constante TypeScript** : `Permission` (chaînes stables `domaine:action`), `ORG_ROLE_PERMISSIONS`, `GLOBAL_ROLE_PERMISSIONS`, helpers `orgRoleHas`, `globalRoleHas`, `isStaff`.
2. Les gardes NestJS déclarent la permission requise par route et évaluent le rôle global **et** le rôle dans l'organisation ciblée (résolu depuis `OrganizationMember` ou la qualité de partie à la transaction).
3. Isolation multi-organisation : un accès à une ressource d'une autre organisation renvoie `404` et non `403`.
4. Toute modification de la matrice passe par une revue de code, des tests d'intégration (chaque permission × chaque rôle) et une mise à jour de `SECURITY.md` §4.
5. Les tables `Role` / `Permission` en base sont **différées** : elles seront introduites si des organisations exigent des rôles personnalisés (Phase 3+), avec la matrice en code conservée comme plancher de sécurité (aucune permission personnalisée ne peut dépasser `OWNER`).

## Conséquences

Positives : source unique, versionnée, relue ; impossibilité d'accorder une permission par simple écriture en base ; typage fort partagé web/API ; tests exhaustifs triviaux ; documentation générée à partir du code.

Négatives : tout nouveau rôle exige un déploiement ; pas de rôles personnalisés par organisation à ce stade ; le staff (`COMPLIANCE`, `ADMIN`) ne peut pas recevoir de permissions d'organisation ad hoc (voulu : séparation des rôles).

## Alternatives

| Alternative                                      | Raison du rejet                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Rôles et permissions en base dès maintenant      | Risque de dérive, surface d'administration à sécuriser, tests combinatoires ; aucun besoin exprimé |
| ABAC / moteur de politiques externe (OPA, Cedar) | Puissant mais dépendance et courbe d'apprentissage ; la matrice actuelle tient en 90 lignes        |
| Vérification côté client uniquement              | Inacceptable ; le client ne fait que masquer des contrôles                                         |

## Détails de mise en œuvre

| Élément                      | Choix                                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Déclaration                  | Décorateur `@RequirePermission(Permission.X)` sur chaque gestionnaire ; absence de décorateur = refus par défaut sur les routes authentifiées                                                                              |
| Résolution de l'organisation | Paramètre de route, corps ou appartenance via la transaction (`buyerOrganizationId`, `sellerOrganizationId`) ; le serveur recalcule toujours, il ne fait pas confiance à l'identifiant fourni sans vérifier l'appartenance |
| Combinaison des rôles        | Une permission `admin:*` ou `sandbox:*` est évaluée sur le rôle global ; les autres sur le rôle d'organisation ; aucun cumul implicite                                                                                     |
| Tests                        | Matrice générée : pour chaque route × chaque rôle, résultat attendu `200/201`, `403` ou `404`                                                                                                                              |
| Documentation                | `SECURITY.md` §4 est régénéré à partir de `permissions.ts` lors de la revue de sécurité                                                                                                                                    |

## Révision

Introduire des rôles personnalisés uniquement si au moins deux organisations `BUSINESS` en expriment le besoin ; conserver la matrice en code comme plafond.
