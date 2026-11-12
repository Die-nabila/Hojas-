/* chapters.js — a book's chapter list (automatic + manual), stored with the book.

   A chapter is { id, title, s, e, auto, edited, autoId? }.
   PDF   s / e are PDF page numbers (the same numbers the reader shows: "Page 42 of 315"), both inclusive.
   EPUB  s / e are text positions [paragraph, character] — e is exclusive, null = end of book. Page numbers of an EPUB depend on
         the screen and text size, so they are always *computed* from these positions with the reader's current layout;
         a chapter therefore keeps its place when the text size changes, and its displayed page numbers follow.
   The context K = { pdf, flat, secStart, sections, pages, pdfPages, maxP } describes the open book. */
import { findPage } from './paginate.js';

export const isSynth = t => /^(Pages? \d|Beginning$|Section \d+$)/.test(t);
export const cmpPos = (a, b) => a[0] - b[0] || a[1] - b[1];
const norm = t => t.toLowerCase().replace(/\s+/g, ' ').trim();

/* ---------- automatic detection (what the importer found) ---------- */
export function detect(K) {
  const real = K.sections.map((_, i) => i).filter(i => !isSynth(K.sections[i].title)), out = [];
  real.forEach((si, k) => {
    const g0 = K.secStart[si], g1 = k + 1 < real.length ? K.secStart[real[k + 1]] : K.flat.length, title = K.sections[si].title;
    if (K.pdf) {
      let lo = Infinity, hi = 0;
      for (let g = g0; g < g1; g++) { const p = K.flat[g].p; if (p) { if (p < lo) lo = p; if (p > hi) hi = p; } }
      if (hi) out.push({ autoId: 's' + si, title, s: lo, e: hi });
    } else out.push({ autoId: 's' + si, title, s: [g0, 0], e: g1 >= K.flat.length ? null : [g1, 0] });
  });
  return out;
}

export const sortByStart = (list, pdf) => list.sort((x, y) => pdf ? x.s - y.s : cmpPos(x.s, y.s));

/* Adds detected chapters that the book doesn't have yet. It NEVER changes or removes a chapter that is already there
   (edited or not), and never brings back one the user deleted — so re-running detection can't undo manual work. */
export function merge(book, detected, newId) {
  book.chapters ||= []; book.chapterDeleted ||= [];
  const fresh = [];
  for (const d of detected) {
    if (book.chapterDeleted.includes(d.autoId) || book.chapters.some(c => c.autoId === d.autoId)) continue;
    fresh.push({ id: newId(), autoId: d.autoId, title: d.title, s: d.s, e: d.e, auto: true, edited: false });
  }
  book.chapters.push(...fresh);
  if (fresh.length && book.chOrder !== 'custom') sortByStart(book.chapters, book.type === 'pdf');
  return fresh.length;
}

/* ---------- page numbers ---------- */
export const total = K => K.pdf ? (K.pdfPages || K.maxP || 0) : K.pages.length;

/* first and last page of a chapter, as the reader numbers them */
export function range(K, c) {
  if (K.pdf) return { a: c.s, b: Math.max(c.s, c.e) };
  const N = K.pages.length, a = findPage(K.pages, c.s[0], c.s[1]) + 1;
  let b = N;
  if (c.e) { const k = findPage(K.pages, c.e[0], c.e[1]), atStart = K.pages[k][0] === c.e[0] && K.pages[k][1] === c.e[1]; b = atStart ? k : k + 1; }
  return { a, b: Math.max(a, Math.min(N, b)) };
}

/* where to open the reader for a chapter → [paragraph, character] */
export function startG(K, c) {
  if (!K.pdf) return c.s;
  if (!K._pf) { K._pf = new Map(); K.flat.forEach((p, g) => { if (p.p && !K._pf.has(p.p)) K._pf.set(p.p, g); }); K._pmax = Math.max(0, ...K._pf.keys()); }
  for (let p = c.s; p <= K._pmax; p++) if (K._pf.has(p)) return [K._pf.get(p), 0];   // a page without text → the next page that has text
  return [Math.max(0, K.flat.length - 1), 0];
}

/* chapters whose range contains a text position {g, o, p} */
const holds = (K, c, pos) => K.pdf
  ? pos.p != null && c.s <= pos.p && pos.p <= c.e
  : cmpPos(c.s, [pos.g, pos.o]) <= 0 && (!c.e || cmpPos([pos.g, pos.o], c.e) < 0);
export function at(K, list, pos) {
  let best = null;
  for (const c of list || []) {
    if (!holds(K, c, pos)) continue;
    if (!best || (K.pdf ? c.s > best.s : cmpPos(c.s, best.s) > 0)) best = c;   // the chapter that started most recently
  }
  return best;
}

/* other chapters that overlap this one's pages (chapters may share a page) */
export function sharedWith(K, list, c) {
  const r = range(K, c), out = [];
  for (const o of list) {
    if (o === c) continue;
    const q = range(K, o), lo = Math.max(r.a, q.a), hi = Math.min(r.b, q.b);
    if (lo <= hi) out.push({ title: o.title, a: lo, b: hi });
  }
  return out;
}

/* user's page numbers → what is stored */
export function fromPages(K, a, b) {
  if (K.pdf) return { s: a, e: b };
  const N = K.pages.length;
  return { s: [...K.pages[a - 1]], e: b < N ? [...K.pages[b]] : null };
}

/* ---------- checking what the user typed ---------- */
export function validate(K, list, draft, selfId) {
  let title = String(draft.title ?? '').trim().replace(/\s+/g, ' ');
  if (!title) return { error: 'Enter a title or a chapter number.' };
  if (title.length > 80) return { error: 'The title is too long (80 characters at most).' };
  if (/^\d+$/.test(title)) title = 'Chapter ' + title;
  const T = total(K), as = String(draft.a ?? '').trim(), bs = String(draft.b ?? '').trim();
  if (!/^\d+$/.test(as)) return { error: 'The start page must be a whole number.' };
  if (!/^\d+$/.test(bs)) return { error: 'The end page must be a whole number.' };
  const a = +as, b = +bs;
  if (a < 1 || a > T) return { error: `The start page must be between 1 and ${T}.` };
  if (b > T) return { error: `The book only has ${T} page${T === 1 ? '' : 's'}.` };
  if (b < 1) return { error: `The end page must be between 1 and ${T}.` };
  if (a > b) return { error: 'The start page can’t be after the end page.' };
  for (const o of list) {
    if (o.id === selfId) continue;
    if (norm(o.title) === norm(title)) return { error: `There is already a chapter called “${o.title}”. Edit that one instead.` };
    if (range(K, o).a === a) return { error: `“${o.title}” already starts on page ${a}. Edit that chapter instead.` };
  }
  return { title, a, b, ...fromPages(K, a, b) };
}
