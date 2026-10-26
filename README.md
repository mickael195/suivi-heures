# Mes heures

Petite app (PWA) de suivi des heures de travail : chaque jour on saisit les heures prévues et le temps atelier réellement fait (en centièmes, ex. `7.53`), l'app affiche le solde en heures/minutes (ex. `−4h00`).

- Hébergement : GitHub Pages (site statique, aucun build)
- Données et comptes : Supabase (chaque utilisateur ne voit que ses propres heures, protégé par RLS)
- Inscription uniquement avec un code d'invitation (généré dans Réglages par l'administrateur)
- Installable sur iPhone (Safari → Partager → Sur l'écran d'accueil) et Android (bouton Installer)

Fichiers : `index.html`, `style.css`, `app.js` (logique), `time.js` (calcul des durées), `sw.js` (service worker), `manifest.webmanifest`, `icons/`.
