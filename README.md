# Hojas — read Spanish

Installable, local-first PWA. Import a PDF or EPUB, tap any word for its base form and English meaning,
long-press and slide to translate a phrase, and review everything you looked up with flashcards.
No backend, no accounts: books, vocabulary, progress and settings stay in this device's IndexedDB.

## Host on GitHub Pages
1. Create a repo and put these files at the **root** (index.html, app.js, lex.js, review.js, sw.js, manifest.webmanifest, style.css, icons/, vendor/).
2. Settings → Pages → Deploy from branch → `main` / root.
3. Open `https://<you>.github.io/<repo>/` in Chrome on Android → menu → **Install app**.

Books are never part of the repo.

## How lookups work
- **Word → base form → meaning.** English Wiktionary supplies lemma, part of speech, forms and senses.
  A bundled Spanish lemma index (`vendor/lemmas/`, loaded one small file at a time) finds the base form even when Wiktionary has no page for the form.
- **Context.** The words before/after the tapped word and the sentence rank the possible readings
  (e.g. *las cruzadas* → crusade, *piernas cruzadas* → crossed) and the senses. Other readings are one tap away.
- **Form meaning.** "sabía = knew / used to know" is generated from the lemma's meaning and the grammar of the form.
- **Phrases.** Translated with Lingva (Google backend), falling back to MyMemory.
- Everything fetched is cached on the device; the first lookup of a word needs internet, repeats do not.

## Updating
Bump `CACHE` in `sw.js` whenever you change files so installed copies refresh.

## Credits
- pdf.js (Apache-2.0), JSZip (MIT / GPLv3), English Wiktionary (CC BY-SA).
- Spanish lemma list: michmech/lemmatization-lists (Open Database License), derived from Hunspell dictionaries.
