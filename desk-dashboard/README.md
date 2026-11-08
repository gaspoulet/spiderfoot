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

## Devoirs : connexion à Blubee

La fonction `/api/devoirs` se connecte à Blubee (https://blubee-gaspard.vercel.app) comme toi dans Safari, avec ton e-mail et ton mot de passe. Elle garde la session, lit la page des devoirs et la convertit. L'app l'appelle toutes les 15 minutes.

Sur Vercel, dans le projet du dashboard : **Settings → Environment Variables**. Ajoute les deux variables, coche **Sensitive**, puis **Redeploy** :

| Variable | Valeur |
|---|---|
| `BLUBEE_EMAIL` | l'adresse mail que tu utilises sur Blubee |
| `BLUBEE_PASSWORD` | ton mot de passe Blubee |
| `DASHBOARD_KEY` | une phrase secrète de ton choix (conseillé), à saisir aussi dans l'app avec ⚙︎ |

Ton mot de passe reste dans Vercel. Il n'est jamais envoyé à l'iPhone.

Pour vérifier, ouvre `https://<ton-dashboard>.vercel.app/api/devoirs?debug=1`. La page indique ce que la fonction a trouvé chez Blubee. Si tu as défini `DASHBOARD_KEY`, ouvre plutôt l'app : la ligne en bas du widget Devoirs affiche l'état de la synchronisation.

Options :
- `BLUBEE_PATHS` : pages de Blubee où chercher les devoirs, séparées par des virgules (par défaut `/`).
- `BLUBEE_URL` : à changer seulement si Blubee change d'adresse.
- Autres sources possibles à la place de Blubee : Google Classroom (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`) ou un lien calendrier `.ics` (`ICAL_URL`). Pour forcer une source, utilise `DEVOIRS_SOURCE=blubee|classroom|ical`.

Les devoirs ajoutés avec **+** restent sur l'iPhone, en plus de ceux de Blubee. Cocher un devoir le masque, et le toast « Annuler » permet de revenir en arrière.

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
