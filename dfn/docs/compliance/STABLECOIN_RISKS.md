# Diaspora Digital Asset (DDA) — Analyse de risques d'un actif numérique de recherche

> **Ce document est une liste de préparation et ne constitue pas un avis juridique.** Il s'agit d'une analyse de recherche interne. Le DDA est une **simulation comptable** confinée au sandbox : aucune unité n'existe en dehors de la base de données de démonstration, aucune unité n'est échangeable, aucun jeton n'est déployé, aucun fonds réel n'est impliqué. L'hypothèse de travail « 1 DDA = 1 USD » est une convention de simulation et **n'est jamais présentée comme une garantie**. Toute évolution vers une émission réelle exigerait des avis juridiques dans chaque juridiction, des autorisations et une décision formelle de la direction (porte R10).

| Champ               | Valeur                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code concerné       | Modèle `DigitalAssetSimulation` (`unitsMinor`, `status` : `MINTED`, `TRANSFERRED`, `REDEEMED`, `VOID`, `note`) — schéma réservé, aucune logique métier en Phases 0–2 |
| Priorité            | P3 — recherche                                                                                                                                                       |
| Statut              | Analyse v0.1                                                                                                                                                         |
| Porte réglementaire | R10 — bloquante absolue                                                                                                                                              |

---

## 1. Lignes rouges (non négociables)

| #   | Ligne rouge                                                                                                                                                           | Mise en œuvre                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| LR1 | **Aucun déploiement de jeton sur une blockchain publique ou privée**                                                                                                  | Aucune dépendance blockchain dans le monorepo ; revue de dépendances en CI                                  |
| LR2 | **Aucun fonds réel**                                                                                                                                                  | `DFN_MODE=sandbox` ; aucune réserve, aucun compte bancaire                                                  |
| LR3 | **Aucun échange d'unités fictives contre un actif réel** (fiat, crypto, bien, service)                                                                                | Aucune route d'échange ; `DigitalAssetSimulation` n'est relié ni au registre financier ni aux portefeuilles |
| LR4 | **Aucune annonce d'émission de stablecoin**, aucune communication laissant croire à une valeur, un rendement ou une garantie                                          | Vocabulaire « simulation de recherche », bandeau sandbox, aucune page marketing                             |
| LR5 | Aucune collecte de fonds, précommande ou liste d'attente liée au DDA                                                                                                  | —                                                                                                           |
| LR6 | Aucune unité attribuée à un utilisateur hors organisation de test consentante                                                                                         | Seed et tests uniquement                                                                                    |
| LR7 | Toute levée d'une ligne rouge requiert : avis juridiques écrits (Canada, Québec, UEMOA, Guinée), décision de la direction consignée en ADR, autorisations applicables | `AUTHORIZATIONS_CHECKLIST.md`                                                                               |

## 2. Objet de la recherche

Étudier si un actif numérique de règlement référencé au dollar américain pourrait, à long terme, réduire les frictions des règlements Afrique–diaspora (délais, coûts, opacité du change), et à quelles conditions de sécurité, de réserve et de conformité. La recherche produit des **analyses**, pas des produits.

## 3. Architectures de gestion des réserves (options étudiées)

| Option                                                 | Description                                                                                     | Avantages                                                        | Risques / limites                                                       | Exigences réglementaires probables                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| A. Réserve fiduciaire 1:1 en dépôts bancaires          | Chaque unité est adossée à 1 USD en dépôt dans une ou plusieurs banques                         | Simplicité, liquidité immédiate                                  | Risque de contrepartie bancaire, concentration, rendement faible        | Comptes séparés, attestations, encadrement spécifique (voir §7)   |
| B. Réserve 1:1 en dépôts + titres d'État à court terme | Mélange de dépôts et de bons du Trésor très liquides                                            | Diversification du risque bancaire, rendement couvrant les coûts | Risque de taux, de liquidité en cas de rachats massifs, de valorisation | Limites de composition, échéance maximale, règles de valorisation |
| C. Comptes séparés / fiducie au profit des porteurs    | Réserves détenues en fiducie, hors bilan de l'émetteur, insaisissables par ses créanciers       | Protection en cas de faillite de l'émetteur                      | Coût, complexité juridique transfrontalière                             | Exigences de protection des fonds (LAPD), droit des fiducies      |
| D. Attestations et audits                              | Attestations mensuelles par un cabinet indépendant, audit annuel, publication de la composition | Transparence, confiance                                          | Décalage temporel, périmètre de l'attestation                           | Souvent exigé par les régulateurs                                 |
| E. Rachat à la valeur nominale                         | Droit du porteur d'obtenir 1 USD par unité dans un délai défini                                 | Ancrage crédible                                                 | Besoin de liquidité, frais, KYC au rachat                               | Obligations contractuelles et prudentielles                       |
| F. Sur-collatéralisation ou algorithmique              | Réserves en actifs volatils ou mécanismes algorithmiques                                        | —                                                                | Historique d'échecs ; dé-ancrage systémique                             | **Écartée** par la recherche DFN                                  |

Architecture de référence retenue pour l'analyse : **A + C + D + E** (dépôts 1:1, fiducie, attestations, rachat au pair). Aucune mise en œuvre.

## 4. Risque de liquidité

| Scénario                                      | Description                                                           | Indicateurs                                                             | Mitigations étudiées                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Rachats massifs (« run »)                     | Demande de rachat supérieure aux liquidités immédiatement disponibles | Ratio liquidités immédiates / encours ; concentration des porteurs      | 100 % de la réserve en actifs convertibles sous T+1 ; limites de concentration ; délais de rachat contractuels transparents |
| Indisponibilité bancaire                      | Banque dépositaire défaillante ou gelée                               | Nombre de dépositaires ; notation                                       | Multi-dépositaires ; fiducie ; assurance-dépôts (plafonds limités)                                                          |
| Désalignement horaire et de change            | Rachats en CAD, XOF ou GNF alors que la réserve est en USD            | Exposition par devise                                                   | Rachat en USD uniquement ; conversion par le partenaire aux conditions du marché, hors promesse de parité en devise locale  |
| Frictions de change dans l'UEMOA et en Guinée | Impossibilité de convertir ou de rapatrier                            | Réglementation des changes (`SENEGAL_BCEAO.md` §4, `GUINEE_BCRG.md` §3) | Le DDA ne résoudrait pas ces contraintes ; tout rachat local resterait soumis au contrôle des changes                       |

## 5. Risque de dé-ancrage (de-peg)

| Cause                              | Mécanisme                                                                                                     | Exemple historique (générique)                                                                  | Mitigations étudiées                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Perte de confiance dans la réserve | Rumeur ou révélation d'une réserve insuffisante ou illiquide → vente sous le pair sur les marchés secondaires | Dé-ancrages de stablecoins adossés à des actifs commerciaux ou exposés à une banque défaillante | Attestations fréquentes, composition conservatrice, communication                         |
| Marché secondaire mince            | Peu d'acheteurs → écarts de prix                                                                              | —                                                                                               | Absence de marché secondaire (pas de jeton public) rend la question théorique pour le DDA |
| Défaillance opérationnelle         | Impossibilité de traiter les rachats (panne, compromission)                                                   | —                                                                                               | Continuité, séparation des clés, procédures manuelles                                     |
| Action réglementaire               | Gel des comptes de réserve, interdiction                                                                      | —                                                                                               | Conformité préalable, dialogue avec les autorités, plan de liquidation ordonnée           |
| Modèle algorithmique               | Boucles de rétroaction                                                                                        | Effondrements de stablecoins algorithmiques                                                     | Modèle écarté (§3 F)                                                                      |

Dans la simulation DFN, le « prix » est une constante (1 unité = 1 USD fictif) : **la simulation ne modélise pas le marché et ne peut pas servir à démontrer la stabilité d'un actif réel**. Toute communication contraire est interdite (LR4).

## 6. Risques opérationnels, de conservation et de contrat intelligent

| Catégorie               | Risque                                                                                        | Mitigation étudiée                                                                          | Pertinence sandbox                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Conservation des clés   | Perte ou vol des clés de signature d'un émetteur on-chain                                     | HSM, multi-signature, séparation des rôles, procédures de récupération                      | Aucune clé n'existe (LR1)                                                                                |
| Contrat intelligent     | Bogue, faille de réentrance, fonctions d'administration abusives, mise à niveau non contrôlée | Audits indépendants, vérification formelle, limites de frappe, pause d'urgence gouvernée    | Aucun contrat (LR1)                                                                                      |
| Dépendance à une chaîne | Congestion, forks, réorganisations, frais                                                     | Choix de chaîne, abstraction, plan de migration                                             | N/A                                                                                                      |
| Frappe / destruction    | Erreur de frappe (mint) ou de destruction (burn) décorrélée de la réserve                     | Rapprochement en temps réel réserve ↔ encours ; double contrôle ; registre à double entrée | La simulation réutiliserait les principes du registre (`LedgerService`) : idempotence, contre-passations |
| Fraude interne          | Émission non adossée                                                                          | Séparation des tâches, journal d'audit, attestations externes                               | `AuditLog`                                                                                               |
| Blanchiment             | Transferts pseudonymes                                                                        | KYC des porteurs, règle de voyage, analyse de chaîne                                        | `KYC_KYB.md`, `AML_POLICY.md`                                                                            |
| Continuité              | Panne prolongée empêchant les rachats                                                         | Plans testés, procédures hors ligne                                                         | `SECURITY.md` §12                                                                                        |
| Juridique               | Qualification en valeur mobilière, en monnaie électronique ou en dépôt                        | Avis par juridiction                                                                        | §7                                                                                                       |

## 7. Paysage réglementaire (à confirmer par le conseil)

| Juridiction / organisme                                               | Position ou texte                                                                                                                                                                                                                                                                                                                                               | Implication pour un éventuel DDA réel                                                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Canada — Autorités canadiennes en valeurs mobilières (ACVM / CSA)** | Encadrement des « cryptoactifs arrimés à une valeur » (value-referenced crypto assets, VRCA) : conditions pour que des plateformes de négociation permettent l'achat de stablecoins adossés à une monnaie fiduciaire (réserve, droits de rachat, divulgation, émetteur acceptable) ; les stablecoins peuvent être qualifiés de valeurs mobilières ou de dérivés | Un DDA échangeable relèverait potentiellement du droit des valeurs mobilières ; engagements de l'émetteur, attestations, divulgation |
| **Canada — BSIF / OSFI**                                              | Lignes directrices sur l'exposition des institutions fédérales aux cryptoactifs (traitement en capital et liquidité)                                                                                                                                                                                                                                            | Pertinent pour les banques dépositaires de réserves ; influence la disponibilité des partenaires                                     |
| **Canada — cadre fédéral des stablecoins**                            | Annonce d'un cadre législatif pour les stablecoins adossés à une monnaie fiduciaire (réserves, rachat, supervision) — contenu et calendrier **à confirmer**                                                                                                                                                                                                     | Suivre l'adoption ; conditionne toute étude de faisabilité                                                                           |
| **Canada — CANAFE**                                                   | Les opérations en monnaie virtuelle relèvent des ESM : inscription, KYC, LVCTR (10 000 CAD), règle de voyage (1 000 CAD, à confirmer)                                                                                                                                                                                                                           | Un DDA réel ferait de DFN une ESM en monnaie virtuelle (`CANADA_CANAFE.md` §3.7)                                                     |
| **Canada — Banque du Canada (LAPD)**                                  | La LAPD vise les fonds en monnaie fiduciaire ; les cryptoactifs non adossés sont hors champ, mais un stablecoin adossé peut soulever des questions                                                                                                                                                                                                              | Analyse spécifique                                                                                                                   |
| **Québec — AMF**                                                      | Encadrement des plateformes de cryptoactifs (valeurs mobilières, dérivés) ; catégorie « monnaie virtuelle » de la LESM (à confirmer)                                                                                                                                                                                                                            | Permis potentiels (`QUEBEC_ESM.md`)                                                                                                  |
| **UEMOA — BCEAO**                                                     | Les cryptoactifs n'ont pas cours légal ; mises en garde publiques ; réflexions sur la monnaie numérique de banque centrale ; absence de cadre d'autorisation pour des stablecoins privés (à confirmer)                                                                                                                                                          | Émission ou distribution d'un DDA dans l'UEMOA : **non envisageable** en l'état                                                      |
| **Guinée — BCRG**                                                     | Pas de cadre connu pour les stablecoins privés ; contrôle des changes strict                                                                                                                                                                                                                                                                                    | Idem                                                                                                                                 |
| **GAFI**                                                              | Recommandation 15 et guide sur les actifs virtuels et les prestataires de services d'actifs virtuels (PSAV) ; **règle de voyage** (transmission des informations donneur d'ordre / bénéficiaire)                                                                                                                                                                | Un émetteur ou intermédiaire de DDA serait un PSAV                                                                                   |
| **Comité de Bâle, CSF, BRI**                                          | Standards prudentiels pour l'exposition bancaire aux cryptoactifs ; recommandations du Conseil de stabilité financière sur les « global stablecoins »                                                                                                                                                                                                           | Référence pour l'architecture de réserve                                                                                             |
| **Union européenne — MiCA**                                           | Régime des jetons se référant à des actifs et des jetons de monnaie électronique (autorisation, réserves, rachat au pair)                                                                                                                                                                                                                                       | Référence comparative pour un corridor Europe → Afrique                                                                              |

## 8. Mécanisme de traçabilité envisagé pour la simulation

| Élément   | Conception                                                                                                                                                                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registre  | Chaque frappe, transfert, rachat ou annulation est une écriture dans `DigitalAssetSimulation` **et** une écriture équilibrée dans un registre de simulation séparé (comptes `DDA_RESERVE_SIM:USD` et `DDA_ISSUED_SIM:USD`), avec clé d'idempotence et contre-passation — même modèle que `LedgerService` |
| Invariant | Encours simulé émis = réserve simulée, vérifié par un job de réconciliation dédié ; tout écart bloque la simulation                                                                                                                                                                                      |
| Identité  | Chaque unité appartient à une organisation de test identifiée ; aucun porteur anonyme                                                                                                                                                                                                                    |
| Journal   | `AuditLog` pour chaque action ; explication des règles de risque appliquées aux transferts simulés                                                                                                                                                                                                       |
| Export    | Rapport de recherche : volumes simulés, scénarios de stress (rachats massifs, défaillance d'un dépositaire fictif), temps de réconciliation                                                                                                                                                              |
| Isolation | Aucune relation de clé étrangère entre `DigitalAssetSimulation` et `LedgerAccount` / `Wallet` : les unités fictives ne peuvent pas créditer un portefeuille                                                                                                                                              |

## 9. Scénarios de stress à simuler (programme de recherche)

| Scénario                                                  | Paramètres                    | Résultat attendu de la simulation                                                            |
| --------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| Rachat de 40 % de l'encours en 24 h                       | Réserve 100 % liquide         | Rachats honorés ; mesure de la charge sur la réconciliation                                  |
| Gel de 30 % de la réserve (dépositaire fictif défaillant) | Multi-dépositaires            | Identification du déficit de liquidité, déclenchement du plan de liquidation ordonnée simulé |
| Erreur de frappe non adossée                              | Injection volontaire          | Détection par l'invariant ; blocage ; contre-passation                                       |
| Pic de transferts                                         | 10 000 transferts simulés / h | Performance du registre, détection de vélocité par le moteur de risque                       |

## 10. Conditions minimales pour envisager une sortie du mode recherche (non planifiée)

1. Cadre juridique explicite dans la juridiction d'émission et avis écrits dans chaque juridiction de distribution.
2. Autorisations obtenues (valeurs mobilières, ESM, FSP, permis AMF selon qualification) et partenaires bancaires dépositaires engagés.
3. Réserve 1:1 en fiducie, attestations mensuelles, audit annuel, droit de rachat au pair.
4. Audit de sécurité indépendant de toute infrastructure on-chain et off-chain.
5. Programme LBC/FT étendu aux PSAV (règle de voyage).
6. Plan de liquidation ordonnée approuvé.
7. Décision formelle de la direction, ADR dédié, mise à jour de toutes les CGU.

Tant que ces conditions ne sont pas réunies, **le DDA reste une simulation sans valeur**.

## 11. Checklist recherche

- [ ] Vérifier à chaque version qu'aucune dépendance blockchain n'est introduite (LR1).
- [ ] Vérifier l'absence de relation entre `DigitalAssetSimulation` et le registre financier / portefeuilles (LR3).
- [ ] Faire relire toute communication mentionnant le DDA par la conformité (LR4).
- [ ] Documenter les scénarios de stress et leurs résultats.
- [ ] Suivre l'évolution du cadre fédéral canadien et des positions BCEAO / BCRG ; mettre à jour §7 trimestriellement.
- [ ] Soumettre toute proposition de sortie du mode recherche à la porte R10.

## 12. Questions ouvertes pour le conseil

1. Un actif de règlement interne non transférable hors plateforme, adossé 1:1 à des dépôts et rachetable au pair, serait-il qualifié au Canada de valeur mobilière, de monnaie électronique, de dépôt ou d'instrument de paiement ?
2. Quel est l'état exact du cadre fédéral canadien sur les stablecoins et son calendrier d'application ?
3. La BCEAO ou la BCRG disposent-elles d'un cadre, même expérimental, pour des actifs numériques privés adossés à une monnaie fiduciaire ?
4. La simulation interne, telle que décrite au §8, soulève-t-elle une quelconque obligation (communication, inscription) tant qu'aucune unité n'est échangeable ?
5. Quelles contraintes de communication s'appliquent à la publication de résultats de recherche mentionnant une parité hypothétique ?

---

## Annexe A — Simulation DDA vs stablecoin réel : ce que la sandbox ne démontre pas

| Dimension               | Simulation DDA (sandbox)                             | Stablecoin réel                                                      |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| Existence des unités    | Lignes dans `DigitalAssetSimulation`                 | Jetons sur un registre distribué ou comptes chez un émetteur         |
| Réserve                 | Constante fictive                                    | Actifs réels, dépositaires, attestations                             |
| Prix                    | 1 USD fictif par construction                        | Déterminé par le marché secondaire ; peut dévier du pair             |
| Rachat                  | Opération comptable fictive                          | Obligation contractuelle, liquidité, KYC, délais                     |
| Risques démontrables    | Invariants comptables, charge, détection de vélocité | Liquidité, dé-ancrage, custody, contrat intelligent, réglementaire   |
| Communication autorisée | « Simulation de recherche »                          | Soumise au droit des valeurs mobilières / de la publicité financière |

## Annexe B — Glossaire

| Terme                                               | Définition de travail                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Stablecoin / cryptoactif arrimé à une valeur (VRCA) | Actif numérique dont la valeur est censée suivre un actif de référence (souvent une monnaie fiduciaire) |
| Réserve                                             | Actifs détenus pour adosser les unités en circulation                                                   |
| Dé-ancrage (de-peg)                                 | Écart durable entre le prix de marché et la valeur de référence                                         |
| Attestation                                         | Rapport d'un tiers indépendant confirmant la composition et le montant de la réserve à une date donnée  |
| PSAV / VASP                                         | Prestataire de services d'actifs virtuels au sens du GAFI                                               |
| Règle de voyage                                     | Transmission des informations donneur d'ordre / bénéficiaire avec les transferts d'actifs virtuels      |
| MiCA                                                | Règlement européen sur les marchés de cryptoactifs                                                      |
| Frappe / destruction (mint / burn)                  | Création / annulation d'unités en contrepartie d'un dépôt / rachat                                      |
