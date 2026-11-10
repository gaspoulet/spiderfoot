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

La fonction `/api/devoirs` se connecte à ton compte Blubee et lit directement ta liste de devoirs et de contrôles, dans la base Supabase de Blubee, comme le fait l'app Blubee. Elle ne garde que ce qui n'est pas encore marqué comme fait. L'app l'appelle toutes les 15 minutes. Touche un devoir pour l'ouvrir dans Classroom.

Sur Vercel, dans le projet du dashboard : **Settings → Environment Variables**. Ajoute ces variables, coche **Sensitive**, puis **Redeploy** :

| Variable | Valeur |
|---|---|
| `BLUBEE_EMAIL` | l'adresse mail de ton compte Blubee |
| `BLUBEE_PASSWORD` | ton mot de passe Blubee |
| `DASHBOARD_KEY` | une phrase secrète de ton choix (conseillé), à saisir aussi dans l'app avec ⚙︎ |

Ton mot de passe reste dans Vercel. Il n'est jamais envoyé à l'iPhone. Si tu changes ton mot de passe Blubee, mets à jour `BLUBEE_PASSWORD` puis fais **Redeploy**.

Autres sources possibles à la place de Blubee : Google Classroom (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`) ou un lien calendrier `.ics` (`ICAL_URL`). Pour forcer une source, utilise `DEVOIRS_SOURCE=blubee|classroom|ical`.

Les devoirs ajoutés avec **+** restent sur l'iPhone, en plus de ceux de Blubee. Cocher un devoir le masque sur le dashboard, mais ne le coche pas dans Blubee. Le toast « Annuler » permet de revenir en arrière.

L'emploi du temps par défaut est ton vrai emploi du temps, repris de Blubee (périodes P1 à P8). Tu peux le modifier avec un appui long sur le widget.

## Installation sur l'iPhone

1. Ouvre l'URL Vercel dans **Safari**, puis touche **Partager → Sur l'écran d'accueil**.
2. Lance l'app depuis son icône : elle s'ouvre en plein écran, sans barre Safari.
3. **Réglages → Luminosité et affichage → Verrouillage auto → Jamais**.
4. Désactive le verrouillage de l'orientation et pose l'iPhone à l'horizontale.
5. Touche l'écran une fois après chaque lancement : iOS bloque le son tant qu'on n'a pas touché l'écran, et n'importe quel toucher l'arme. Le petit haut-parleur dans l'en-tête du réveil est barré tant que le son n'est pas armé.
6. Facultatif : **Réglages → Accessibilité → Accès guidé** pour verrouiller l'iPhone sur l'app.

## Utilisation

- **Modifier un widget** : fais un appui long dessus. Sur le réveil, ça permet de régler l'heure, les jours et le libellé (toucher l'heure marche aussi). Sur l'emploi du temps, ça permet de le modifier. Sur les devoirs, ça ouvre les réglages.
- **Réveil** : une option permet de tester la sonnerie. Une option permet de tester la sonnerie. Le son monte progressivement pendant une minute. **+5 min** relance le réveil 5 minutes plus tard. Sans action, la sonnerie s'arrête seule au bout de 10 minutes.
- **Emploi du temps**, format :
  ```
  Lundi
  08:00-08:55 Mathématiques @ B204
  Mar, Jeu
  10:10-11:05 Anglais @ C03
  ```
  Chaque matière garde toujours la même couleur.
- **Nuit** (de 23 h à 8 h, heure de Hong Kong) : seules l'heure et la date restent affichées, en gris-bleu très sombre. Touche l'écran pour tout réafficher pendant 20 secondes.
- **Horloge seule en journée** : touche le petit bouton rond à côté de la bulle « Paris ». Touche l'écran n'importe où pour revenir aux widgets.
- Contre le marquage OLED, l'affichage se décale de quelques pixels toutes les 2 minutes. Le Wake Lock empêche l'écran de s'éteindre.
- **Hors ligne** : l'app et la dernière liste de devoirs restent disponibles. Le réveil, l'emploi du temps et les devoirs ajoutés à la main sont sauvegardés en `localStorage`.

## En local

```
npx vercel dev
```
