# Bureau — dashboard de bureau pour iPhone

Web app (PWA) au look iOS, faite pour un iPhone posé à l'horizontale, branché et allumé en permanence.
Elle affiche l'heure de Hong Kong, l'heure de Paris, un réveil, l'emploi du temps du jour et les devoirs.

```
public/           l'app (HTML/CSS/JS sans framework, service worker, manifest, icônes)
api/devoirs.js    fonction serverless Vercel : récupère les devoirs, identifiants côté serveur
vercel.json       configuration du déploiement
```

## Déploiement sur Vercel

1. Sur vercel.com : **Add New → Project**, importe le dépôt GitHub.
2. **Root Directory** : `desk-dashboard`. Framework Preset : **Other**. Ne remplis ni la commande de build ni le dossier de sortie (ils sont dans `vercel.json`).
3. Dans **Settings → Environment Variables**, ajoute les variables de la source de devoirs (voir plus bas), puis **Redeploy**.

En ligne de commande, c'est la même chose : `npm i -g vercel`, puis `vercel --prod` depuis `desk-dashboard/`.

## Devoirs : choix de la source

La fonction `/api/devoirs` est appelée toutes les 15 minutes. La source est choisie avec `DEVOIRS_SOURCE`. Sans cette variable, la fonction prend la première source configurée, dans l'ordre Blubee, Classroom puis iCal.

| Source | Variables |
|---|---|
| **Blubee** (`blubee`) | `BLUBEE_URL` (adresse du site, ex. `https://blubee.vercel.app`), `BLUBEE_PATH` (route JSON des devoirs, `/api/devoirs` par défaut), plus `BLUBEE_TOKEN` (envoyé en `Authorization: Bearer`) **ou** `BLUBEE_COOKIE` (cookie de session) |
| **Google Classroom** (`classroom`) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (portées `classroom.courses.readonly` et `classroom.coursework.me.readonly`) |
| **Flux iCal** (`ical`) | `ICAL_URL` (lien `.ics` privé, `webcal://` accepté) |

Pour Blubee, la réponse JSON peut avoir plusieurs formes : un tableau ou un objet `{ devoirs: [...] }`, avec des champs en français ou en anglais (`titre`/`title`, `matiere`/`subject`, `pourLe`/`dueDate`…). Les devoirs déjà rendus (`done`, `TURNED_IN`…) sont ignorés.

**`DASHBOARD_KEY`** (conseillé) : si tu la définis, la fonction exige cette clé. Saisis la même valeur dans l'app avec l'icône ⚙︎ du widget Devoirs. Sans clé, n'importe qui qui connaît l'URL peut lire tes devoirs.

Les devoirs ajoutés avec **+** restent sur l'iPhone, en plus de ceux de la source. Cocher un devoir le masque, et le toast « Annuler » permet de revenir en arrière.

## Installation sur l'iPhone

1. Ouvre l'URL Vercel dans **Safari**, puis touche **Partager → Sur l'écran d'accueil**.
2. Lance l'app depuis son icône : elle s'ouvre en plein écran, sans barre Safari.
3. **Réglages → Luminosité et affichage → Verrouillage auto → Jamais**.
4. Désactive le verrouillage de l'orientation et pose l'iPhone à l'horizontale.
5. Touche **Armer le son** une fois après chaque lancement : iOS bloque l'audio tant qu'on n'a pas touché l'écran. Le bouton passe au vert (« Son armé »).
6. Facultatif : **Réglages → Accessibilité → Accès guidé** pour verrouiller l'iPhone sur l'app.

## Utilisation

- **Réveil** : touche l'heure ou le crayon pour régler l'heure, les jours et le libellé. Une option permet de tester la sonnerie. Le son monte progressivement pendant une minute. **+5 min** relance le réveil 5 minutes plus tard. Sans action, la sonnerie s'arrête seule au bout de 10 minutes.
- **Emploi du temps** : touche le crayon. Format :
  ```
  Lundi
  08:00-08:55 Mathématiques @ B204
  Mar, Jeu
  10:10-11:05 Anglais @ C03
  ```
  Chaque matière garde toujours la même couleur.
- **Mode nuit** (de 23 h à 7 h, heure de Hong Kong) : seule l'horloge reste affichée, en rouge sombre. Touche l'écran pour tout réafficher pendant 20 secondes.
- Contre le marquage OLED, l'affichage se décale de quelques pixels toutes les 2 minutes. Le Wake Lock empêche l'écran de s'éteindre.
- **Hors ligne** : l'app et la dernière liste de devoirs restent disponibles. Le réveil, l'emploi du temps et les devoirs ajoutés à la main sont sauvegardés en `localStorage`.

## En local

```
npx vercel dev
```
