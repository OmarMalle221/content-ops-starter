# ADR-0003 — Plateforme « sandbox only » : aucun fonds réel, garde `DFN_MODE`

| Champ  | Valeur                                                                                          |
| ------ | ----------------------------------------------------------------------------------------------- |
| Statut | Accepté — non révisable sans franchissement des portes réglementaires                           |
| Date   | 2026-10-11                                                                                      |
| Portée | Ensemble du dépôt ; `packages/shared/src/sandbox.ts` ; fabriques d'adaptateurs ; `.env.example` |

## Contexte

DFN ne dispose d'aucune inscription (CANAFE), d'aucun enregistrement (Banque du Canada), d'aucun permis (AMF), d'aucun partenariat agréé (BCEAO, BCRG) et d'aucun fournisseur KYC contractualisé. Opérer des flux réels, même minimes, exposerait l'équipe et les utilisateurs à des risques juridiques et financiers. Pourtant, démontrer le produit (workflow de paiement conditionnel, litiges, registre) exige des parcours complets et réalistes. Il faut donc une démonstration **fidèle** et une impossibilité **structurelle** de manipuler de l'argent réel.

## Décision

1. La base de code ne connaît qu'un mode : `DFN_MODE=sandbox`. L'API refuse de démarrer pour toute autre valeur ; aucune valeur `production` n'existe.
2. Toute surface rappelle la nature fictive : bandeau permanent « Données fictives — Aucun fonds réel » (`SANDBOX_DISCLAIMER`), en-tête HTTP `x-dfn-mode`, description OpenAPI, instructions de paiement fictives (« Do not send money »), contrat numérique portant la mention de démonstration.
3. Les fabriques `createPaymentProvider`, `createKycProvider`, `createSanctionsProvider` lèvent une exception pour tout code non sandbox. Aucun adaptateur réel n'existe dans le dépôt.
4. Les résultats simulés ont des statuts dédiés et non ambigus : `SIMULATED_PASS`, `SIMULATED_FAIL`, `CLEAR_SIMULATED`, `POTENTIAL_MATCH_SIMULATED`, `EXECUTED_SIMULATED`, méthodes `*_SIMULATED`.
5. La simulation du partenaire (confirmation de financement, dépôts) est réservée au rôle global `ADMIN` via la permission `sandbox:partner_simulate` et journalisée.
6. Le schéma prépare l'avenir (`ProviderMode.LIVE`, variables `KYC_PROVIDER_API_KEY`, etc.) sans l'activer : préparer n'est pas autoriser.
7. Toute modification du garde ou des fabriques exige deux approbateurs, un ADR dédié et le franchissement des portes R1–R10 (`ROADMAP.md` §9, `AUTHORIZATIONS_CHECKLIST.md`).

## Conséquences

Positives : risque juridique et financier maîtrisé ; démonstrations complètes et honnêtes ; les partenaires et conseils évaluent un produit fonctionnel ; les documents de conformité peuvent décrire précisément ce que le produit prépare.

Négatives : certains comportements réels (délais bancaires, rejets, taux de change) ne sont que simulés ; risque de confusion si un utilisateur ignore le bandeau — mitigé par la redondance des mentions ; dette d'intégration à prévoir pour les adaptateurs réels (interfaces déjà définies).

## Alternatives

| Alternative                                                      | Raison du rejet                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Drapeau `production` désactivé par défaut                        | Un simple changement de variable pourrait activer des flux réels sans autorisation ; inacceptable |
| Intégration réelle en « mode test » d'un prestataire de paiement | Nécessite déjà des contrats et parfois des inscriptions ; brouille la frontière sandbox / réel    |
| Démonstration par maquettes statiques                            | Ne permet pas de valider le registre, la concurrence, les litiges ni les files de revue           |

## Points de vérification

| Vérification                                                                                            | Fréquence           |
| ------------------------------------------------------------------------------------------------------- | ------------------- |
| Démarrage de l'API avec `DFN_MODE=production` échoue (test d'intégration)                               | Chaque CI           |
| Chaque page web affiche le bandeau (test e2e)                                                           | Chaque CI           |
| Chaque réponse API porte `x-dfn-mode: sandbox` (test d'intégration)                                     | Chaque CI           |
| Les fabriques rejettent tout code non sandbox (tests unitaires)                                         | Chaque CI           |
| Aucune dépendance réseau vers un prestataire de paiement ou KYC dans le lockfile                        | Revue trimestrielle |
| Relecture des textes utilisateur contenant « vérifié », « payé », « fonds » pour éviter toute ambiguïté | À chaque version    |

## Révision

Cet ADR ne peut être remplacé que par un ADR de « sortie du mode sandbox » signé par la direction, le responsable conformité et le responsable sécurité, référençant les lignes « Obtenu » de `AUTHORIZATIONS_CHECKLIST.md` pour le module et le corridor concernés.
