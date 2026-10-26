# Histoires Vraies — chaîne YouTube 100 % IA, 100 % sourcée

Pipeline qui transforme un nom (« Wangari Maathai », « Marie Curie »…) en vidéo YouTube prête à publier, en français, **sans rien inventer** : chaque fait raconté vient d'une source réelle et vérifiable, citée en description.

```
recherche ─► écriture ─► vérification ─► voix off ─► montage ─► publication
Wikipédia     Claude      contrôles +     voix         ffmpeg      YouTube
Wikidata      (script     relecture IA    neuronale    (Ken Burns, (privée par
Commons       sourcé)     indépendante    française    sous-titres) défaut)
```

## Ce qui garantit les « vraies infos »

1. **Dossier de sources** (`dossier.json`) : l'article Wikipédia français *et* anglais (texte intégral, version exacte consultée), les faits structurés de Wikidata (dates, lieux, distinctions…) et vos propres sources (articles, interviews) si vous en ajoutez. Tout est découpé en passages numérotés (`S1-P12`).
2. **L'IA n'écrit qu'à partir du dossier** : chaque fait du script est relié aux passages qui le prouvent. Interdits : dialogues inventés, pensées prêtées à la personne, détails dramatisés, citations reformulées.
3. **Vérification automatique avant tout montage** :
   - contrôles mécaniques : toute citation entre « » doit exister mot pour mot dans les sources ; tout nombre ou date doit y figurer ; les passages et images cités doivent exister ;
   - relecture par l'IA en vérificateur indépendant, affirmation par affirmation (confirmé / non confirmé / contredit) ;
   - les scènes fautives sont réécrites puis revérifiées ; s'il reste un doute, **le montage est bloqué**.
4. **Rapport lisible** (`verification.md`) : chaque affirmation, son verdict et le lien vers la source.
5. **Images réelles uniquement** : photos d'archives de Wikimedia Commons sous licence libre (auteur et licence affichés à l'écran et en description). Aucune image de la personne générée par IA.
6. **Description transparente** : sources avec liens vers la version exacte consultée, crédits photos, mention de l'usage de l'IA et de la voix de synthèse.

> La vérification compare le script aux sources ; elle ne rend pas Wikipédia infaillible. Choisissez des sujets avec des articles solides (labels « Bon article » ou « Article de qualité »), relisez `verification.md`, et soyez particulièrement prudent avec les personnes vivantes.

## Installation

Prérequis : Python 3.10+, [ffmpeg](https://ffmpeg.org/download.html) et une clé API Anthropic ([console.anthropic.com](https://console.anthropic.com)).

```bash
cd youtube-histoires
python -m venv .venv
source .venv/bin/activate          # Windows : .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # puis renseignez ANTHROPIC_API_KEY
```

## Utilisation

### Tout en une commande

```bash
python -m histoires tout "Wangari Maathai"
```

Résultat dans `projets/wangari-maathai/` :

| Fichier | Contenu |
| --- | --- |
| `video.mp4` | la vidéo 1920×1080 |
| `miniature.jpg` | miniature 1280×720 |
| `sous-titres.srt` | sous-titres à importer sur YouTube |
| `description.txt` | description avec chapitres, sources et crédits |
| `youtube.json` | titre, titres alternatifs, tags, catégorie |
| `script.json` | le script scène par scène, avec ses sources |
| `verification.md` | le rapport de vérification à relire |
| `dossier.json`, `images/` | les sources brutes |

### Étape par étape (recommandé : vous gardez la main)

```bash
python -m histoires recherche "Wangari Maathai"        # 1. vérifiez que c'est la bonne personne
python -m histoires ecrire wangari-maathai             # 2. script + vérification automatique
#    relisez verification.md, modifiez script.json si besoin, puis :
python -m histoires verifier wangari-maathai           # 3. revérifie vos modifications
python -m histoires video wangari-maathai --brouillon  # 4. aperçu rapide en 720p
python -m histoires video wangari-maathai              # 5. version finale
```

Options utiles :

- `recherche "Q47755"` : désigner la personne par son identifiant Wikidata (évite les homonymes) ;
- `recherche "…" --source article.txt` : ajouter vos sources (en tête du fichier, lignes facultatives `Titre:`, `URL:`, `Date:`, puis le texte) ;
- `ecrire … --duree 10` : durée visée en minutes ;
- `ecrire … --format court` : YouTube Shorts vertical (≈ 50 s) ;
- `video … --voix fr-FR-DeniseNeural` : autre voix (`python -m histoires voix` pour la liste) ;
- `video … --musique fond.mp3` : musique libre de droits mixée en fond ;
- `video … --incruster-sous-titres` : sous-titres gravés dans l'image (utile pour les Shorts) ;
- `video … --muet` : sans voix, pour tester le montage hors ligne.

### Publier sur YouTube

1. Dans [Google Cloud Console](https://console.cloud.google.com/) : créez un projet, activez **YouTube Data API v3**, créez des identifiants OAuth de type « Application de bureau » et téléchargez le fichier `client_secret.json` dans `youtube-histoires/`.
2. `pip install -r requirements-youtube.txt`
3. `python -m histoires publier wangari-maathai`

La vidéo est envoyée **en privé** avec sa miniature et ses sous-titres : vérifiez-la dans YouTube Studio avant de la rendre publique (ou `--visibilite unlisted|public`). Tant que votre projet Google n'a pas passé l'[audit de l'API YouTube](https://support.google.com/youtube/contact/yt_api_form), les vidéos envoyées par l'API restent privées : vous les publiez alors à la main dans YouTube Studio.

## Réglages (`.env`)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | clé API Claude |
| `HISTOIRES_MODELE` | `claude-opus-5-5` | modèle de rédaction et de vérification |
| `HISTOIRES_EFFORT` | `high` | profondeur de réflexion (`medium` pour réduire le coût) |
| `HISTOIRES_VOIX` | `fr-FR-HenriNeural` | voix off |
| `HISTOIRES_DEBIT_VOIX` | `-4%` | débit de la voix |
| `HISTOIRES_CHAINE` | `Histoires Vraies` | nom affiché sur les cartes |
| `HISTOIRES_CONTACT` | lien du dépôt | contact transmis à Wikimedia (exigé par leur règlement) |
| `HISTOIRES_POLICE`, `HISTOIRES_POLICE_GRASSE` | DejaVu / Arial | polices des cartes et de la miniature |

Si l'appel au modèle principal est refusé par ses filtres de sécurité, l'API bascule automatiquement sur le modèle de secours recommandé par Anthropic (`fallbacks: "default"`).

## Coûts

- Sources, voix et montage : gratuits.
- Claude : le dossier (de 20 000 à plus de 100 000 jetons selon la longueur des articles) est mis en cache entre la rédaction, la vérification et les corrections ; comptez de l'ordre de 1 à 3 $ par vidéo longue avec Claude Opus 5.5. Le détail des jetons s'affiche à chaque appel.
- Rendu : environ 1 minute de calcul par minute de vidéo en 1080p sur un ordinateur récent.

## À savoir avant de monétiser

- **Monétisation** : YouTube refuse le contenu « produit en masse ou répétitif ». Relisez chaque script, variez sujets et angles, ajoutez votre regard (choix des histoires, introduction personnelle, séries thématiques).
- **Contenu synthétique** : YouTube demande de déclarer le contenu réaliste modifié ou généré par IA (option `publier --contenu-synthetique`). Une narration en voix de synthèse sur des photos d'archives réelles n'est en général pas visée, mais vérifiez les règles en vigueur.
- **Voix** : les voix Edge sont gratuites mais passent par un service Microsoft non officiel. Pour une chaîne monétisée, envisagez une voix sous licence commerciale (Azure Speech, ElevenLabs…).
- **Droits** : textes Wikipédia sous CC BY-SA, photos sous licences libres créditées automatiquement ; la musique de fond doit être libre de droits (bibliothèque audio de YouTube Studio par exemple).

## Tests

```bash
pip install pytest
python -m pytest
```

Les tests fonctionnent hors ligne avec des données **fictives** (`tests/fixtures/`) : recherche simulée, vérification (citations inventées, nombres absents, boucle de correction), métadonnées et rendu vidéo complet avec voix muette.

## Structure du code

| Module | Rôle |
| --- | --- |
| `histoires/sources.py` | Wikipédia, Wikidata, Commons, sources personnelles → `dossier.json` |
| `histoires/writer.py` | consignes et schéma JSON du script, réécriture ciblée |
| `histoires/factcheck.py` | contrôles mécaniques, relecture IA, rapport |
| `histoires/llm.py` | appels à Claude (sortie JSON structurée, cache du dossier) |
| `histoires/tts.py` | voix off et repères de sous-titres |
| `histoires/visuals.py` | photos recadrées, cartes, calques, miniature |
| `histoires/render.py` | montage ffmpeg (Ken Burns, fondus, concaténation, musique) |
| `histoires/publish.py` | description, chapitres, crédits, envoi YouTube |
| `histoires/cli.py` | commandes `recherche`, `ecrire`, `verifier`, `video`, `tout`, `publier`, `voix` |
