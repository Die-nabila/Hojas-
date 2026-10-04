# Hojas — read Spanish

Installable, local-first PWA. Import a PDF or EPUB, tap any word for its English meaning,
and every lookup is saved to that book's vocabulary list. No backend, no accounts.

## Host on GitHub Pages
1. Create a repo and put these files at the **root** (index.html, app.js, sw.js, manifest.webmanifest, style.css, icons/, vendor/).
2. Settings → Pages → Deploy from branch → `main` / root.
3. Open `https://<you>.github.io/<repo>/` in Chrome on Android → menu → **Install app**.

Books are never part of the repo: you import them on the phone and they stay in its IndexedDB.

## Notes
- Meanings come from Wiktionary (backup: MyMemory) and are cached on the device after the first lookup.
  A first lookup needs internet; reading and your saved vocabulary work offline.
- When you update the files, bump `CACHE` in `sw.js` so installed copies refresh.
- Bundled libraries: pdf.js (Apache-2.0) and JSZip (MIT / GPLv3).
