/* Hojas — local-first Spanish reading PWA. No backend: everything lives in this device's IndexedDB. */
import { initLex, lookup, peek, rank, describe, translatePhrase } from './lex.js';
import { initReview, renderReview, bindReview } from './review.js';
import { flatten, paginate, pageParts, findPage } from './paginate.js';
import * as CH from './chapters.js';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const ICON_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/* ================= Storage (IndexedDB) ================= */
const DB = (() => {
  let dbp;
  const open = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('hojas', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('content', { keyPath: 'id' });
      d.createObjectStore('vocab', { keyPath: 'id' }).createIndex('bookId', 'bookId');
      d.createObjectStore('dict', { keyPath: 'word' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const run = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = t.onabort = () => rej(t.error);
    });
  };
  return {
    get: (s, k) => run(s, 'readonly', o => o.get(k)),
    all: s => run(s, 'readonly', o => o.getAll()),
    put: (s, v) => run(s, 'readwrite', o => { o.put(v); }),
    del: (s, k) => run(s, 'readwrite', o => { o.delete(k); }),
    byBook: id => run('vocab', 'readonly', o => o.index('bookId').getAll(id)),
    async delPrefix(store, prefix) {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction(store, 'readwrite'), rq = t.objectStore(store).openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
        rq.onsuccess = () => { const c = rq.result; if (c) { c.delete(); c.continue(); } };
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
    },
    async delByBook(id) {
      const items = await this.byBook(id);
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('vocab', 'readwrite');
        items.forEach(v => t.objectStore('vocab').delete(v.id));
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
    }
  };
})();

/* ================= Settings (local) ================= */
const S = Object.assign({ size: 20, face: 'serif', theme: 'meadow', lh: 1.65 }, JSON.parse(localStorage.getItem('hojas.settings') || '{}'));
function applySettings() {
  const r = document.documentElement;
  r.dataset.theme = S.theme; r.dataset.face = S.face; r.style.setProperty('--fs', S.size + 'px'); r.style.setProperty('--lh', S.lh);
  localStorage.setItem('hojas.settings', JSON.stringify(S));
  themeColor();
}
function themeColor() {
  const cs = getComputedStyle(document.documentElement);
  const c = view === 'reader' ? cs.getPropertyValue('--page') : view === 'vocab' || view === 'review' ? cs.getPropertyValue('--bg1') : (S.theme === 'night' ? '#0f6f61' : '#62d6b5');
  $('meta[name=theme-color]').content = c.trim();
}

/* ================= UI helpers ================= */
let toastT;
function toast(msg, ms = 2600) { const t = $('#toast'); t.classList.remove('has-act'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }
function toastAction(msg, label, fn, ms = 6500) {
  const t = $('#toast'); t.classList.add('has-act'); t.innerHTML = '<span></span><button type="button" class="toast-act"></button>';
  t.firstChild.textContent = msg; const b = $('.toast-act', t); b.textContent = label;
  b.onclick = () => { t.hidden = true; clearTimeout(toastT); fn(); };
  t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; t.classList.remove('has-act'); }, ms);
}
const busy = (title, text = '') => { $('#busy-title').textContent = title; $('#busy-text').textContent = text; $('#busy').hidden = false; };
const busyText = t => { $('#busy-text').textContent = t; };
const hideBusy = () => { $('#busy').hidden = true; };
function ask(title, text, ok = 'Remove') {
  return new Promise(res => {
    const d = $('#confirm');
    $('#confirm-title').textContent = title; $('#confirm-text').textContent = text; $('.danger', d).textContent = ok;
    d.returnValue = '';
    d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true });
    d.showModal();
  });
}
function openSheet(id) { closeSheets(); $('#backdrop').hidden = false; $(id).hidden = false; }
function closeSheets() { $('#backdrop').hidden = true; $$('.sheet').forEach(s => s.hidden = true); }
$('#backdrop').addEventListener('click', closeSheets);

let view = 'library';
function show(v) {
  view = v;
  for (const n of ['library', 'vocab', 'review', 'reader']) $('#view-' + n).hidden = n !== v;
  $('#tabs').hidden = v === 'reader';
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === v));
  hidePop(); closeSheets(); themeColor();
}
async function goTab(t) {
  if (t === 'vocab') { show('vocab'); await renderVocab(); }
  else if (t === 'review') { show('review'); books = await loadBooks(); await renderReview(); }
  else { show('library'); await renderShelf(); }
}
const loadBooks = async () => (await DB.all('books')).sort((a, b) => (b.lastOpened || b.added) - (a.lastOpened || a.added));
$$('#tabs button').forEach(b => b.addEventListener('click', () => goTab(b.dataset.tab)));

/* ================= Library ================= */
let books = [];
const PAL = [['#17b88c', '#0b6e5a'], ['#5fd0f0', '#1a8fb0'], ['#2bbfa0', '#4cc3e6'], ['#0f9d76', '#7be0c3'], ['#6fd6c9', '#0f8f7a'], ['#7ad0f0', '#12a67f']];
const hash = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const pctOf = b => { if (b.progress?.pct != null) return b.progress.pct; const t = b.total || 1; const before = b.counts.slice(0, b.progress.sec).reduce((a, n) => a + n, 0); return Math.min(100, Math.round(100 * (before + b.progress.para) / t)); };

async function renderShelf() {
  books = await loadBooks();
  const vc = new Map(); (await DB.all('vocab')).forEach(v => vc.set(v.bookId, (vc.get(v.bookId) || 0) + 1));
  const shelf = $('#shelf');
  if (!books.length) {
    shelf.innerHTML = `<div class="empty"><img src="icons/icon-512.png" alt=""><h3>Your shelf is empty</h3><p>Import a Spanish PDF or EPUB from your phone to start reading.</p></div>`;
    return;
  }
  shelf.innerHTML = books.map(b => {
    const [c1, c2] = PAL[hash(b.title) % PAL.length];
    const pct = pctOf(b), n = vc.get(b.id) || 0;
    const cover = b.cover ? `<img src="${b.cover}" alt="">` : `<div class="gen" style="background:linear-gradient(155deg,${c1},${c2})"><b>${esc([...b.title.trim()][0] || 'H').toUpperCase()}</b><span>${esc(b.title)}</span></div>`;
    const sub = pct || n ? `${pct}% read${n ? ` · ${n} word${n === 1 ? '' : 's'}` : ''}` : 'New';
    return `<article class="book"><button class="open" data-open="${b.id}"><div class="cover">${cover}<div class="bar"><i style="width:${pct}%"></i></div></div><div class="meta"><div class="name">${esc(b.title)}</div><div class="sub">${sub}</div></div></button><button class="more" data-more="${b.id}" aria-label="Remove ${esc(b.title)}"><svg viewBox="0 0 24 24"><path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3.4"/></svg></button></article>`;
  }).join('');
}
let menuId = null;
$('#shelf').addEventListener('click', e => {
  const o = e.target.closest('[data-open]'), m = e.target.closest('[data-more]');
  if (o) openBook(o.dataset.open);
  if (m) { const b = books.find(x => x.id === m.dataset.more); if (!b) return; menuId = b.id; $('#sb-title').textContent = b.title; openSheet('#sheet-book'); }
});
$('#sheet-book').addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const b = books.find(x => x.id === menuId); closeSheets(); if (!b) return;
  if (btn.dataset.act === 'open') openBook(b.id);
  if (btn.dataset.act === 'chapters') openBook(b.id, { manage: true });
  if (btn.dataset.act === 'remove' && await ask('Remove this book?', `“${b.title}” and its saved words will be deleted from this phone.`)) {
    await Promise.all([DB.del('books', b.id), DB.del('content', b.id), DB.delByBook(b.id), DB.delPrefix('dict', 'pg:' + b.id + ':')]);
    renderShelf(); toast('Book removed');
  }
});

/* ================= Import ================= */
$('#btn-import').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });

async function importFile(file) {
  const n = file.name.toLowerCase();
  const isEpub = n.endsWith('.epub') || file.type === 'application/epub+zip';
  const isPdf = n.endsWith('.pdf') || file.type === 'application/pdf';
  if (!isEpub && !isPdf) return toast('Choose a PDF or EPUB file.');
  if (books.some(b => b.file === file.name && b.size === file.size)) return toast('That book is already in your library.');
  busy('Importing book', 'Getting started…');
  try {
    navigator.storage?.persist?.();
    const parsed = isEpub ? await parseEpub(file) : await parsePdf(file);
    const sections = parsed.sections;
    const counts = sections.map(s => s.paras.length);
    const title = (parsed.title || file.name.replace(/\.(pdf|epub)$/i, '')).trim();
    const book = {
      id: uid(), title, author: (parsed.author || '').trim(), type: isEpub ? 'epub' : 'pdf', file: file.name, size: file.size,
      cover: parsed.cover || null, pdfPages: parsed.pdfPages || 0, added: Date.now(), lastOpened: 0, counts, total: counts.reduce((a, c) => a + c, 0), progress: { sec: 0, para: 0 }
    };
    await DB.put('content', { id: book.id, sections });
    await DB.put('books', book);
    hideBusy(); await goTab('library'); toast(`“${title}” is ready to read`);
  } catch (err) {
    console.error(err); hideBusy(); toast(err.message || 'Could not read that file.', 5000);
  }
}

/* ---- PDF: extract selectable text, rebuild lines and paragraphs ---- */
function linesFromItems(items) {
  const lines = []; let cur = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const x = it.transform[4], y = it.transform[5];
    const h = Math.abs(it.height) || Math.hypot(it.transform[2], it.transform[3]) || 10;
    if (cur && Math.abs(y - cur.y) <= h * 0.5) {
      const gap = x - cur.endX;
      const need = gap > h * 0.18 && !/\s$/.test(cur.text) && !/^\s/.test(it.str);
      cur.text += (need ? ' ' : '') + it.str; cur.endX = x + (it.width || 0); if (it.str.trim()) cur.h = Math.max(cur.h, h);
    } else {
      if (cur) lines.push(cur);
      cur = { y, x, endX: x + (it.width || 0), h, text: it.str };
    }
  }
  if (cur) lines.push(cur);
  return lines.map(l => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter(l => l.text);
}
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
function joinInto(p, text) {
  if (/\p{L}-$/u.test(p.t) && /^\p{Ll}/u.test(text)) p.t = p.t.slice(0, -1) + text; else p.t += ' ' + text;
}
function parasFromLines(lines, bodyH, page) {
  const paras = []; let cur = null, prev = null;
  const step = median(lines.slice(1).map((l, i) => lines[i].y - l.y).filter(d => d > 0)) || bodyH * 1.3;
  const body = lines.filter(l => l.h <= bodyH * 1.25);
  const left = body.length ? Math.min(...body.map(l => l.x)) : 0;
  for (const l of lines) {
    if (/^\d{1,4}$/.test(l.text)) continue; // page numbers
    const head = l.h > bodyH * 1.25 && l.text.length < 90;
    const gap = prev ? prev.y - l.y : 0;
    const prevEnds = prev && /[.!?…»”"')\]:]$/.test(prev.text);
    const indent = prev && l.x > left + bodyH * 0.9 && prevEnds;
    const dash = prev && prevEnds && /^[—–-]\s?\S/.test(l.text);
    const cont = cur && head && cur.h && gap > 0 && gap <= step * 1.7;
    if (cont) joinInto(cur, l.text);
    else if (!cur || head || cur.h || gap > step * 1.45 || gap < 0 || indent || dash) {
      cur = { t: l.text, h: head, p: page }; paras.push(cur);
    } else joinInto(cur, l.text);
    prev = l;
  }
  return paras;
}
async function pdfOutline(pdf) {
  try {
    const outline = await pdf.getOutline(); if (!outline?.length) return [];
    const out = [];
    for (const o of outline) {
      let dest = o.dest; if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest)) continue;
      const idx = typeof dest[0] === 'object' ? await pdf.getPageIndex(dest[0]) : dest[0];
      out.push({ page: idx + 1, title: (o.title || '').trim() });
    }
    const seen = new Set();
    return out.filter(o => o.title && !seen.has(o.page) && seen.add(o.page)).sort((a, b) => a.page - b.page);
  } catch { return []; }
}
async function parsePdf(file) {
  const pdfjs = await import('./vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', location.href).href;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pageLines = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    busyText(`Reading page ${n} of ${pdf.numPages}`);
    const page = await pdf.getPage(n);
    pageLines.push(linesFromItems((await page.getTextContent()).items));
    page.cleanup();
  }
  const bodyH = median(pageLines.flat().map(l => l.h)) || 10;
  const paras = [];
  pageLines.forEach((lines, i) => {
    const ps = parasFromLines(lines, bodyH, i + 1);
    const last = paras[paras.length - 1];
    if (last && ps.length && !last.h && !ps[0].h && !/[.!?…:»”"')]$/.test(last.t) && /^\p{Ll}/u.test(ps[0].t)) {
      // the sentence continues on the next PDF page: keep the page boundary, mark the continuation
      if (/\p{L}-$/u.test(last.t)) { const m = ps[0].t.match(/^(\S+)\s*([\s\S]*)$/); last.t = last.t.slice(0, -1) + m[1]; ps[0].t = m[2]; }
      if (ps[0].t) ps[0].cont = true; else ps.shift();
    }
    paras.push(...ps);
  });
  if (paras.reduce((a, p) => a + p.t.length, 0) < 200) throw new Error('No selectable text found. This PDF may be a scan of images.');

  busyText('Building chapters…');
  const starts = await pdfOutline(pdf);
  const sections = [];
  if (starts.length >= 2) {
    const bounds = starts[0].page > 1 ? [{ page: 1, title: 'Beginning' }, ...starts] : starts;
    bounds.forEach((b, i) => {
      const end = bounds[i + 1] ? bounds[i + 1].page : Infinity;
      const ps = paras.filter(p => p.p >= b.page && p.p < end);
      if (ps.length) sections.push({ title: b.title, paras: ps });
    });
  } else {
    const CH = 8;
    for (let a = 1; a <= pdf.numPages; a += CH) {
      const b = Math.min(a + CH - 1, pdf.numPages);
      const ps = paras.filter(p => p.p >= a && p.p <= b);
      if (ps.length) sections.push({ title: a === b ? `Page ${a}` : `Pages ${a}–${b}`, paras: ps });
    }
  }
  let title = '', author = '', cover = null;
  try {
    const info = (await pdf.getMetadata()).info || {};
    title = info.Title || ''; author = info.Author || '';
    if (/^(microsoft word|untitled)|\.(docx?|indd|pdf|tex)$/i.test(title.trim())) title = '';
  } catch { }
  if (pageLines[0] && pageLines[0].reduce((a, l) => a + l.text.length, 0) < 400) {
    try { // title-page style first page: use it as the cover
      const page = await pdf.getPage(1), v0 = page.getViewport({ scale: 1 }), v = page.getViewport({ scale: 300 / v0.width });
      const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
      cover = c.toDataURL('image/jpeg', .72);
    } catch { }
  }
  return { title, author, cover, sections, pdfPages: pdf.numPages };
}

/* ---- EPUB: use the structured text already inside ---- */
function extractParas(html) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('script,style,rt,rp,svg,nav').forEach(n => n.remove());
  d.querySelectorAll('br').forEach(b => b.replaceWith(' '));
  const SEL = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,dt,dd,figcaption,pre,div,td';
  const out = [];
  for (const el of d.body.querySelectorAll(SEL)) {
    if (el.querySelector(SEL)) continue;
    const t = el.textContent.replace(/\s+/g, ' ').trim();
    if (t) out.push({ t, h: /^H[1-6]$/.test(el.tagName) });
  }
  return out;
}
async function parseEpub(file) {
  busyText('Unpacking…');
  const zip = await JSZip.loadAsync(file);
  const read = async p => { let f = zip.file(p); if (!f) { try { f = zip.file(decodeURIComponent(p)); } catch { } } return f ? f.async('text') : null; };
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const q = (doc, name) => [...doc.getElementsByTagNameNS('*', name)];
  const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
  const resolve = (from, href) => {
    let h = href.split('#')[0]; try { h = decodeURI(h); } catch { }
    const out = []; for (const p of (from + h).split('/')) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
    return out.join('/');
  };
  const cont = await read('META-INF/container.xml');
  if (!cont) throw new Error('This EPUB looks damaged.');
  const opfPath = q(xml(cont), 'rootfile')[0]?.getAttribute('full-path');
  const opfText = opfPath && await read(opfPath);
  if (!opfText) throw new Error('This EPUB looks damaged.');
  const opf = xml(opfText), base = dirOf(opfPath);
  const manifest = {};
  q(opf, 'item').forEach(i => manifest[i.getAttribute('id')] = { href: i.getAttribute('href'), type: i.getAttribute('media-type') || '', props: i.getAttribute('properties') || '' });
  const spine = q(opf, 'itemref').map(r => manifest[r.getAttribute('idref')]).filter(Boolean);

  // chapter titles from the table of contents
  const titles = new Map();
  const navItem = Object.values(manifest).find(m => m.props.split(' ').includes('nav'));
  const ncxItem = Object.values(manifest).find(m => m.type === 'application/x-dtbncx+xml');
  try {
    if (navItem) {
      const p = resolve(base, navItem.href), html = await read(p);
      if (html) {
        const d = new DOMParser().parseFromString(html, 'text/html');
        const nav = d.querySelector('nav[epub\\:type~="toc"]') || d.querySelector('nav');
        nav?.querySelectorAll('a[href]').forEach(a => { const k = resolve(dirOf(p), a.getAttribute('href')); const t = a.textContent.replace(/\s+/g, ' ').trim(); if (t && !titles.has(k)) titles.set(k, t); });
      }
    }
    if (!titles.size && ncxItem) {
      const p = resolve(base, ncxItem.href), txt = await read(p);
      if (txt) q(xml(txt), 'navPoint').forEach(np => {
        const t = q(np, 'text')[0]?.textContent.replace(/\s+/g, ' ').trim(), src = q(np, 'content')[0]?.getAttribute('src');
        if (t && src) { const k = resolve(dirOf(p), src); if (!titles.has(k)) titles.set(k, t); }
      });
    }
  } catch { }

  const sections = []; let n = 0;
  for (const it of spine) {
    if (!/html/.test(it.type)) continue;
    busyText(`Reading chapter ${++n} of ${spine.length}`);
    const path = resolve(base, it.href), html = await read(path);
    if (!html) continue;
    const paras = extractParas(html);
    if (!paras.length) continue;
    let title = titles.get(path) || '';
    if (paras[0].h && paras[0].t.length < 90 && (!title || paras[0].t === title)) title = paras.shift().t;
    if (!paras.length) continue;
    if (!title && paras.reduce((a, p) => a + p.t.length, 0) < 60) continue;
    sections.push({ title: title || `Section ${sections.length + 1}`, paras });
  }
  if (!sections.length) throw new Error('No readable text found in this EPUB.');

  let cover = null;
  try {
    let item = Object.values(manifest).find(m => m.props.split(' ').includes('cover-image'));
    if (!item) { const meta = q(opf, 'meta').find(m => m.getAttribute('name') === 'cover'); if (meta) item = manifest[meta.getAttribute('content')]; }
    const f = item && zip.file(resolve(base, item.href));
    if (f) {
      const bmp = await createImageBitmap(new Blob([await f.async('uint8array')], { type: item.type || 'image/jpeg' }));
      const w = 300, h = Math.round(bmp.height * w / bmp.width), c = document.createElement('canvas');
      c.width = w; c.height = h; c.getContext('2d').drawImage(bmp, 0, 0, w, h); cover = c.toDataURL('image/jpeg', .78);
    }
  } catch { }
  return { title: q(opf, 'title')[0]?.textContent || '', author: q(opf, 'creator')[0]?.textContent || '', cover, sections };
}

/* ================= Reader (book pages) ================= */
let R = null, saveT, lookupToken = 0, P = null, PP = null, sel = null, gs = null, suppressClick = false, afterReader = null, tapDismissed = false;
const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
const stage = $('#r-stage'), pageEl = $('#r-text');
const M = document.createElement('div'); M.className = 'page-text measure'; M.lang = 'es'; M.setAttribute('aria-hidden', 'true'); $('#app').appendChild(M);

function wrap(t, base = 0) {
  let out = '', last = 0;
  t.replace(WORD, (m, off) => {
    out += esc(t.slice(last, off)) + `<span class="w${R.known.has(m.toLowerCase()) ? ' k' : ''}" data-o="${base + off}" data-n="${R.wc++}">${esc(m)}</span>`;
    last = off + m.length; return m;
  });
  return out + esc(t.slice(last));
}

async function openBook(id, opts = {}) {
  const book = books.find(b => b.id === id); if (!book) return;
  busy('Opening book');
  try {
    const content = await DB.get('content', id);
    if (!content) throw new Error('This book’s text is missing. Remove it and import it again.');
    const vocab = (await DB.byBook(id)).filter(v => v.v === 2);
    R = {
      book, sections: content.sections, ...flatten(book, content.sections), pages: [], pi: 0, pos: [0, 0], words: [], wc: 0, tok: 0, laying: true, geo: null,
      ents: new Map(vocab.map(v => [v.id, v])), vcount: vocab.length, known: new Set(vocab.filter(v => v.kind === 'word').flatMap(v => v.forms.map(f => f.form.toLowerCase())))
    };
    if (book.chv !== 1) { CH.merge(book, CH.detect(chK()), uid); book.chv = 1; }   // first time only: the importer's chapters become the editable list
    book.lastOpened = Date.now(); DB.put('books', book);
    history.pushState({ reader: 1 }, '');
    show('reader');
    $('#r-book').textContent = book.title; setVCount();
    const p = book.progress || {}, last = R.flat.length - 1;
    const g = p.g != null ? p.g : p.sec != null ? (R.secFirst[Math.min(p.sec, R.secFirst.length - 1)] || 0) + (p.para || 0) : 0;
    await layoutBook([Math.max(0, Math.min(g, last)), p.g != null ? (p.o || 0) : 0]);
    if (opts.manage && R && !R.laying) { hideBusy(); openChapters(); }
  } catch (e) { console.error(e); toast(e.message, 4500); }
  hideBusy();
}
const setVCount = () => { $('#r-vcount').textContent = R.vcount || ''; $('#r-vcount').hidden = !R.vcount; };

/* ---------- laying out pages ---------- */
function geometry() {
  const w = stage.clientWidth, h = stage.clientHeight;
  const mx = Math.round(Math.min(56, Math.max(26, w * 0.075))), mt = Math.round(Math.max(16, h * 0.03));
  return { W: Math.max(120, w - 2 * mx), H: Math.max(120, h - 2 * mt), mx, mt };
}
function placeBoxes(g) {
  Object.assign(pageEl.style, { left: g.mx + 'px', top: g.mt + 'px', width: g.W + 'px', height: g.H + 'px' });
  Object.assign(M.style, { left: '-99999px', top: '0px', width: g.W + 'px', height: g.H + 'px' });
}
async function layoutBook(pos) {
  const r = R, tok = ++r.tok; r.laying = true; hidePop();
  const geo = geometry(); r.geo = geo; placeBoxes(geo);
  const key = `${geo.W}x${geo.H}|${S.size}|${S.lh}|${S.face}|1`, ck = `pg:${r.book.id}:${key}`;
  const hit = await DB.get('dict', ck);
  let pages = null;
  if (hit?.data?.length) { pages = []; for (let i = 0; i < hit.data.length; i += 2) pages.push([hit.data[i], hit.data[i + 1]]); }
  else {
    busy('Laying out pages', '0%');
    pages = await paginate({
      flat: r.flat, pdf: r.book.type === 'pdf', M, H: geo.H, cum: r.cum,
      cancelled: () => R !== r || r.tok !== tok, progress: f => busyText(Math.round(100 * f) + '%')
    });
    if (!pages) return;
    DB.put('dict', { word: ck, v: 1, data: pages.flat() });
  }
  if (R !== r || r.tok !== tok) return;
  r.pages = pages; r.laying = false; hideBusy();
  renderPage(findPage(pages, pos[0], pos[1]));
}

/* ---------- showing a page ---------- */
function pageHTML(pi) {
  R.wc = 0;
  return pageParts(R.flat, R.pages, pi).map(x => {
    const para = R.flat[x.g], inner = wrap(para.t.slice(x.a, x.b), x.a);
    const cls = 'para' + (para.ct ? ' ct' : '') + (x.cont ? ' cont' : '');
    const tag = para.ct ? 'h2' : para.h ? 'h3' : 'p';
    return `<${tag} class="${cls}" data-g="${x.g}">${inner}</${tag}>`;
  }).join('');
}
function renderPage(pi, anim) {
  hidePop(); R.pi = pi; R.pos = R.pages[pi];
  pageEl.innerHTML = pageHTML(pi); R.words = $$('.w', pageEl);
  pageEl.classList.remove('turn-next', 'turn-prev');
  if (anim) { void pageEl.offsetWidth; pageEl.classList.add(anim === 'next' ? 'turn-next' : 'turn-prev'); }
  updateFoot(); queueSave();
}
function turn(dir) {
  if (!R || R.laying) return;
  const to = R.pi + dir;
  if (to < 0) return;
  if (to >= R.pages.length) { toast('You’ve reached the end'); return; }
  renderPage(to, dir > 0 ? 'next' : 'prev');
}
function subInfo(pi, p) {
  let a = pi, b = pi;
  while (a > 0 && R.flat[R.pages[a - 1][0]].p === p) a--;
  while (b < R.pages.length - 1 && R.flat[R.pages[b + 1][0]].p === p) b++;
  return { k: pi - a + 1, m: b - a + 1 };
}
function pageLabel(pi) {
  const b = R.book, N = R.pages.length;
  if (b.type === 'pdf') {
    const p = R.flat[R.pages[pi][0]]?.p;
    if (p) { const { k, m } = subInfo(pi, p); return `Page ${p} of ${b.pdfPages || R.maxP}` + (m > 1 ? ` · ${k}/${m}` : ''); }
  }
  return `Page ${pi + 1} of ${N}`;
}
const pctAt = ([g, o]) => R.pi >= R.pages.length - 1 ? 100 : Math.min(99, Math.round(100 * (R.cum[g] + o) / (R.cum[R.flat.length] || 1)));
function updateFoot() {
  const N = R.pages.length;
  $('#r-pg').textContent = pageLabel(R.pi);
  $('#r-pct').textContent = pctAt(R.pos) + '%';
  $('#r-bar').style.width = (100 * (R.pi + 1) / N) + '%';
  const c = curChapter(), label = c ? c.title : '';
  $('#r-chap').textContent = label; $('#r-sec').textContent = label;
}
function saveProgress() {
  clearTimeout(saveT);
  if (!R || R.laying || view !== 'reader') return;
  const [g, o] = R.pos, para = R.flat[g];
  R.book.progress = { g, o, sec: para?.sec ?? 0, para: para?.pi ?? 0, pct: pctAt(R.pos), page: R.pi + 1 };
  DB.put('books', R.book);
}
const queueSave = () => { clearTimeout(saveT); saveT = setTimeout(saveProgress, 400); };
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });
addEventListener('pagehide', saveProgress);

function leaveReader() {
  saveProgress();
  if (R) { R.tok++; R = null; }
  hideBusy();
  const next = afterReader || 'library'; afterReader = null; goTab(next);
}
addEventListener('popstate', () => { if (view === 'reader') leaveReader(); });
$('#r-back').addEventListener('click', () => history.back());
$('#r-vocab').addEventListener('click', () => { afterReader = 'vocab'; vFilter = R.book.id; history.back(); });

/* going to a page / chapter (chapters are optional navigation) */
function gotoPos(g, o = 0) { if (!R || R.laying) return; renderPage(findPage(R.pages, g, o)); saveProgress(); }
function openGoto() {
  if (!R || R.laying) return;
  const sl = $('#goto-pg'); sl.max = R.pages.length; sl.value = R.pi + 1; $('#goto-lbl').textContent = pageLabel(R.pi);
  renderToc(); openSheet('#sheet-toc');
  $('#toc-list .on')?.scrollIntoView({ block: 'center' });
}
$('#r-toc').addEventListener('click', openGoto);
$('#r-pg').addEventListener('click', openGoto);
$('#goto-pg').addEventListener('input', e => { $('#goto-lbl').textContent = pageLabel(+e.target.value - 1); });
$('#goto-pg').addEventListener('change', e => { closeSheets(); renderPage(+e.target.value - 1); saveProgress(); });

/* ---------- chapters: list, go to, manage ---------- */
const chK = () => ({ pdf: R.book.type === 'pdf', flat: R.flat, secStart: R.secStart, sections: R.sections, pages: R.pages, pdfPages: R.book.pdfPages, maxP: R.maxP });
const curChapter = () => { const [g, o] = R.pos; return CH.at(chK(), R.book.chapters, { g, o, p: R.flat[g]?.p }); };
const pageNow = () => R.book.type === 'pdf' ? (R.flat[R.pos[0]]?.p || R.pi + 1) : R.pi + 1;
const pagesText = r => r.a === r.b ? `page ${r.a}` : `pages ${r.a}–${r.b}`;
function gotoChapter(c) { const [g, o] = CH.startG(chK(), c); gotoPos(g, o); }
function renderToc() {
  const k = chK(), list = R.book.chapters || [], cur = curChapter();
  $('#toc-list').innerHTML = list.length
    ? list.map(c => `<li><button data-c="${c.id}" class="${c === cur ? 'on' : ''}"><span>${esc(c.title)}</span><small>${pagesText(CH.range(k, c))}</small></button></li>`).join('')
    : '<li class="toc-empty">No chapters found in this book. Use “Manage chapters” to add them.</li>';
}
$('#toc-list').addEventListener('click', e => { const b = e.target.closest('[data-c]'); const c = b && R.book.chapters.find(x => x.id === b.dataset.c); if (c) { closeSheets(); gotoChapter(c); } });
$('#open-chapters').addEventListener('click', openChapters);

let chEdit = null;                                          // null = showing the list; { id } = the add/edit form is open
function openChapters() { if (!R || R.laying) return; chEdit = null; renderChapters(); openSheet('#sheet-chap'); }
function renderChapters() {
  const k = chK(), list = R.book.chapters || [], T = CH.total(k);
  $('#ch-book').textContent = R.book.title;
  $('#ch-note').textContent = k.pdf
    ? `Page numbers are the PDF’s own, as shown at the bottom of the reader. This book has ${T} pages.`
    : `Pages follow your current text size (${T} pages now). A chapter keeps its place if you change the size; its page numbers then update.`;
  $('#ch-form').hidden = !chEdit; $('#ch-list').hidden = !!chEdit; $('#ch-bar').hidden = !!chEdit; $('#ch-note').hidden = !!chEdit;
  if (chEdit) return;
  $('#ch-list').innerHTML = list.length ? list.map((c, i) => {
    const r = CH.range(k, c), n = r.b - r.a + 1, sh = CH.sharedWith(k, list, c);
    const shared = sh.length ? `<span class="ch-share">shares ${sh.map(x => (x.a === x.b ? `page ${x.a}` : `pages ${x.a}–${x.b}`) + ' with “' + esc(x.title) + '”').join(', ')}</span>` : '';
    return `<li class="ch-row" data-id="${c.id}">
      <button class="ch-main" data-a="go"><b>${esc(c.title)}</b><small>${pagesText(r)} · ${n} page${n === 1 ? '' : 's'}</small>${shared}</button>
      <span class="ch-tag ${c.auto ? (c.edited ? 'ed' : 'au') : 'mn'}">${c.auto ? (c.edited ? 'edited' : 'auto') : 'added'}</span>
      <div class="ch-acts"><button data-a="up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button><button data-a="down" aria-label="Move down" ${i === list.length - 1 ? 'disabled' : ''}>↓</button><button data-a="edit">Edit</button><button data-a="del" class="d">Delete</button></div>
    </li>`;
  }).join('') : '<li class="toc-empty">No chapters yet. Tap “Add chapter” to create the first one.</li>';
}
function openChapterForm(id) {
  const k = chK(), c = id && R.book.chapters.find(x => x.id === id), cur = pageNow(), r = c ? CH.range(k, c) : { a: cur, b: cur };
  chEdit = { id: id || null };
  $('#ch-form-title').textContent = c ? 'Edit chapter' : 'Add chapter';
  $('#ch-name').value = c ? c.title : ''; $('#ch-a').value = r.a; $('#ch-b').value = r.b; $('#ch-err').textContent = '';
  $('#ch-a').max = $('#ch-b').max = CH.total(k);
  renderChapters(); setTimeout(() => $('#ch-name').focus(), 50);
}
$('#ch-add').addEventListener('click', () => openChapterForm(null));
$('#ch-cancel').addEventListener('click', () => { chEdit = null; renderChapters(); });
$('#ch-done').addEventListener('click', closeSheets);
$('#ch-a-now').addEventListener('click', () => { $('#ch-a').value = pageNow(); });
$('#ch-b-now').addEventListener('click', () => { $('#ch-b').value = pageNow(); });
$('#ch-sort').addEventListener('click', async () => { CH.sortByStart(R.book.chapters, R.book.type === 'pdf'); R.book.chOrder = 'pages'; await DB.put('books', R.book); renderChapters(); renderToc(); });
$('#ch-form').addEventListener('submit', async e => {
  e.preventDefault();
  const k = chK(), list = R.book.chapters, c = chEdit.id && list.find(x => x.id === chEdit.id);
  const v = CH.validate(k, list, { title: $('#ch-name').value, a: $('#ch-a').value, b: $('#ch-b').value }, chEdit.id);
  if (v.error) { $('#ch-err').textContent = v.error; return; }
  if (c) {
    const was = CH.range(k, c); c.title = v.title;
    if (v.a !== was.a || v.b !== was.b) { c.s = v.s; c.e = v.e; }       // untouched page numbers keep the exact stored position
    if (c.auto) c.edited = true;
  } else {
    list.push({ id: uid(), title: v.title, s: v.s, e: v.e, auto: false, edited: false });
    if (R.book.chOrder !== 'custom') CH.sortByStart(list, k.pdf);
  }
  await DB.put('books', R.book);
  chEdit = null; renderChapters(); renderToc(); updateFoot(); toast(c ? 'Chapter updated' : 'Chapter added');
});
$('#ch-list').addEventListener('click', async e => {
  const btn = e.target.closest('[data-a]'), row = e.target.closest('.ch-row'); if (!btn || !row) return;
  const list = R.book.chapters, i = list.findIndex(x => x.id === row.dataset.id), c = list[i]; if (!c) return;
  const act = btn.dataset.a;
  if (act === 'go') { closeSheets(); gotoChapter(c); return; }
  if (act === 'edit') return openChapterForm(c.id);
  if (act === 'up' || act === 'down') {
    const j = act === 'up' ? i - 1 : i + 1; if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]]; R.book.chOrder = 'custom';
  }
  if (act === 'del') {
    if (!await ask('Delete this chapter?', `“${c.title}” will be removed from the chapter list. Your reading position, words and flashcards are not affected.`, 'Delete')) return;
    list.splice(i, 1);
    if (c.autoId) (R.book.chapterDeleted ||= []).push(c.autoId);        // so detection can never bring it back
  }
  await DB.put('books', R.book); renderChapters(); renderToc(); updateFoot();
});

/* reading settings — changing size / spacing / typeface reflows the whole book and keeps your place */
$('#r-aa').addEventListener('click', () => {
  $('#set-size').value = S.size; $('#v-size').textContent = S.size;
  $('#set-lh').value = S.lh; $('#v-lh').textContent = (+S.lh).toFixed(2);
  $$('#set-face button').forEach(b => b.classList.toggle('on', b.dataset.v === S.face));
  $$('#set-theme button').forEach(b => b.classList.toggle('on', b.dataset.v === S.theme));
  openSheet('#sheet-set');
});
const reflow = () => { applySettings(); if (R && !R.laying) layoutBook(R.pos); else if (R) layoutBook(R.pos); };
$('#set-size').addEventListener('input', e => { $('#v-size').textContent = e.target.value; });
$('#set-size').addEventListener('change', e => { S.size = +e.target.value; reflow(); });
$('#set-lh').addEventListener('input', e => { $('#v-lh').textContent = (+e.target.value).toFixed(2); });
$('#set-lh').addEventListener('change', e => { S.lh = +e.target.value; reflow(); });
$('#set-face').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || b.dataset.v === S.face) return; S.face = b.dataset.v; $$('#set-face button').forEach(x => x.classList.toggle('on', x === b)); reflow(); });
$('#set-theme').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.theme = b.dataset.v; applySettings(); $$('#set-theme button').forEach(x => x.classList.toggle('on', x === b)); });
let rzT; addEventListener('resize', () => {
  clearTimeout(rzT); rzT = setTimeout(() => {
    if (!R || view !== 'reader') return;
    const g = geometry(); if (Math.abs(g.W - R.geo.W) > 2 || Math.abs(g.H - R.geo.H) > 2) layoutBook(R.pos);
  }, 350);
});
document.addEventListener('keydown', e => {
  if (view !== 'reader' || !R || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); turn(1); }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); turn(-1); }
});

/* ================= Tap a word · swipe or tap the edges to turn · long-press and slide to select ================= */
stage.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; }
  if (!R || R.laying) return;
  const w = e.target.closest?.('.w') || wordAt(e.clientX, e.clientY, [[0, 0], [-9, 0], [9, 0], [0, -7], [0, 7]]);
  if (w) return onWord(w);
  if (tapDismissed) { tapDismissed = false; return; }
  const r = stage.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
  if (x < 0.32) turn(-1); else if (x > 0.68) turn(1);
});
stage.addEventListener('contextmenu', e => e.preventDefault());

const PROBES = [[0, 0], [-8, 0], [8, 0], [0, -8], [0, 8], [-18, 0], [18, 0]];
function wordAt(x, y, probes = PROBES) {
  for (const [dx, dy] of probes) {
    const w = document.elementFromPoint(x + dx, y + dy)?.closest?.('.w');
    if (w && pageEl.contains(w)) return w;
  }
  return null;
}
function paintRange() {
  const lo = Math.min(sel.a, sel.b), hi = Math.max(sel.a, sel.b);
  if (sel.pl != null) for (let k = sel.pl; k <= sel.ph; k++) R.words[k]?.classList.remove('rng');
  for (let k = lo; k <= hi; k++) R.words[k]?.classList.add('rng');
  sel.pl = lo; sel.ph = hi;
}
function clearRange() {
  if (R) $$('.w.rng', pageEl).forEach(n => n.classList.remove('rng'));
  sel = null; PP = null;
}
function beginSel(w) { hidePop(); sel = { a: +w.dataset.n, b: +w.dataset.n }; paintRange(); navigator.vibrate?.(12); }
function extendSel(w) { const n = +w.dataset.n; if (sel && n !== sel.b) { sel.b = n; paintRange(); } }
function endSel() {
  if (!sel) return;
  const lo = Math.min(sel.a, sel.b), hi = Math.max(sel.a, sel.b);
  if (lo === hi) { const w = R.words[lo]; clearRange(); onWord(w); } else showPhrase(lo, hi);
}
const swallowClick = () => { suppressClick = true; setTimeout(() => { suppressClick = false; }, 400); };

stage.addEventListener('touchstart', e => {
  clearTimeout(gs?.timer);
  if (!R || R.laying || e.touches.length !== 1) { gs = null; return; }
  const t = e.touches[0], w = e.target.closest?.('.w');
  gs = { x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY, active: false, moved: false, timer: null };
  if (w) gs.timer = setTimeout(() => { if (gs && !gs.moved) { gs.active = true; beginSel(w); } }, 380);
}, { passive: true });
stage.addEventListener('touchmove', e => {
  if (!gs) return;
  const t = e.touches[0]; gs.lx = t.clientX; gs.ly = t.clientY;
  if (!gs.active) { if (Math.hypot(t.clientX - gs.x, t.clientY - gs.y) > 10) { clearTimeout(gs.timer); gs.moved = true; } return; }
  e.preventDefault();
  const w = wordAt(t.clientX, t.clientY); if (w) extendSel(w);
}, { passive: false });
stage.addEventListener('touchend', e => {
  if (!gs) return;
  clearTimeout(gs.timer); const g = gs; gs = null;
  if (g.active) { if (e.cancelable) e.preventDefault(); swallowClick(); endSel(); return; }
  const dx = g.lx - g.x, dy = g.ly - g.y;
  if (g.moved && Math.abs(dx) >= 48 && Math.abs(dx) > 1.4 * Math.abs(dy)) { if (e.cancelable) e.preventDefault(); swallowClick(); turn(dx < 0 ? 1 : -1); }
});
stage.addEventListener('touchcancel', () => { if (gs) { clearTimeout(gs.timer); if (gs.active) endSel(); gs = null; } });

/* mouse: press on a word and drag across others */
let md = null;
stage.addEventListener('mousedown', e => { const w = e.target.closest?.('.w'); md = w && e.button === 0 ? { w, moved: false } : null; });
stage.addEventListener('mousemove', e => {
  if (!md || !(e.buttons & 1)) return;
  const w = e.target.closest?.('.w'); if (!w) return;
  if (!md.moved && w !== md.w) { md.moved = true; beginSel(md.w); }
  if (md.moved) extendSel(w);
});
addEventListener('mouseup', () => { if (md?.moved) { swallowClick(); endSel(); } md = null; });

/* ---------- sentence helpers ---------- */
function sentenceAt(t, off, len) {
  const END = '.!?…'; let s = 0, e = t.length;
  for (let i = off - 1; i >= 0; i--) {
    const c = t[i];
    if (c === '¿' || c === '¡') { s = i; break; }
    if (END.includes(c) && /[\s"'”»)\]]/.test(t[i + 1] || ' ')) { s = i + 1; break; }
  }
  for (let i = off + len; i < t.length; i++) {
    if (END.includes(t[i])) { e = i + 1; while (e < t.length && /["'”»)\]]/.test(t[e])) e++; break; }
  }
  let text = t.slice(s, e).trim();
  if (text.length > 320) {
    const a = Math.max(0, off - s - 140), b = Math.min(text.length, off - s + len + 140);
    text = (a > 0 ? '… ' : '') + text.slice(a, b).trim() + (b < text.length ? ' …' : '');
  }
  return { text, start: s, end: e };
}
const paraOf = span => R.flat[+span.closest('.para').dataset.g];
const secTitleOf = (p, off = 0) => { const c = CH.at(chK(), R.book.chapters, { g: p.g, o: off, p: p.p }); return c ? c.title : (R.sections[p.sec ?? 0]?.title || ''); };
const locOf = span => { const p = paraOf(span), t = secTitleOf(p, +span.dataset.o); return t + (p.p ? ` · p. ${p.p}` : ''); };

/* ---------- single word ----------
   Tap → the panel opens in the same frame. Then, as soon as each piece exists, it is filled in:
   memory/IndexedDB cache (instant) · base form from the local index (~ms) · grammar + base form from the word's page ·
   meaning of the best reading · other readings. Saving to the vocabulary never delays the panel. */
const LOADING = '<div class="dots"><i></i><i></i><i></i></div>';
const popHead = (word, chip) => `<div class="ph"><span class="pw">${esc(word)}</span>${chip ? `<span class="pc">${chip}</span>` : ''}<button class="px" aria-label="Close">${ICON_X}</button></div>`;
const perfLog = (word, ms, src) => { (window.hojasPerf ||= []).push({ word, ms: Math.round(ms), src }); if (window.hojasPerf.length > 60) window.hojasPerf.shift(); };

function formLine(d, word) {
  if (!d.lemma) return '';
  const lem = `<b>${esc(d.lemma)}</b>`;
  if (!d.isForm) return '';
  const from = d.verbish ? `from ${lem}${d.gram ? ` <span class="pg">${esc(d.gram)}</span>` : ''}` : (d.gram ? `${esc(d.gram)} form of ${lem}` : `from ${lem}`);
  return `<div class="pf">${from}</div>`;
}
function onWord(span) {
  clearRange();
  const t0 = performance.now();
  const word = span.textContent, lower = word.toLowerCase(), token = ++lookupToken;
  const para = paraOf(span), off = +span.dataset.o, st = sentenceAt(para.t, off, word.length);
  const toks = s => (s.match(WORD) || []).map(x => x.toLowerCase());
  const before = toks(para.t.slice(st.start, off)), after = toks(para.t.slice(off + word.length, st.end));
  const ctx = { word: lower, prev: before.slice(-2).reverse(), next: after.slice(0, 2), sentence: st.text, capMid: /^\p{Lu}/u.test(word) && before.length > 0 };
  const info = { word, lower, form: ctx.capMid ? word : lower, ctx, loc: locOf(span), sec: secTitleOf(para, off) };
  $$('.w.sel').forEach(n => n.classList.remove('sel')); span.classList.add('sel');
  const stale = () => token !== lookupToken || !R;
  let shown = false, src = 'net';
  const result = readings => { shown = true; showResult(span, info, readings); perfLog(word, performance.now() - t0, src); };

  const hit = peek(lower);                              // already looked up this visit: draw synchronously
  if (hit) { src = 'memory'; result(hit); return; }
  P = null;
  showPop(span, popHead(word) + LOADING);               // the panel is on screen right now
  lookup(word, ctx, {
    stale,
    onSkeleton: rs => { if (stale() || shown) return; const top = rank(rs, ctx)[0].r; showPop(span, popHead(word) + formLine(describe(top, ctx), word) + LOADING); },
    onTop: rs => { if (!stale()) result(rs); }
  }).then(rs => {
    if (stale() || !rs) return;
    if (!shown) { src = 'device'; result(rs); }                       // came straight from the cache
    else if (P && P.readings === rs) { P.ranked = rank(rs, ctx); renderWordPop(); }   // other readings finished loading
  }).catch(err => {
    if (stale()) return;
    const net = err.kind === 'network' || err.kind === 'timeout' || err.kind === 'http';
    showPop(span, popHead(word) + (net
      ? `<div class="pe">Couldn’t reach the dictionary.</div><div class="pd">${esc(err.detail || err.message)}</div><button class="retry">Try again</button>`
      : `<div class="pe">No meaning found for “${esc(word)}”.</div>`));
  });
}

function showResult(span, info, readings) {
  const ctx = info.ctx, ranked = rank(readings, ctx), top = ranked[0].r, d = describe(top, ctx);
  const rec = recordWord(info, d);                         // in memory now, written to the device in the background
  $$('#r-text .w').forEach(n => { if (n.textContent.toLowerCase() === info.lower) n.classList.add('k'); });
  setVCount();
  P = { span, info, ranked, readings, idx: 0, d, rec };
  renderWordPop();
}

const TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
function removeRow(e, info) {
  const others = e.forms.map(f => f.form).filter(f => f.toLowerCase() !== info.lower);
  const note = others.length ? `<small>Also removes the other forms you looked up: ${esc(others.join(', '))}</small>` : '';
  return `<div class="prem"><button class="rm-vocab" data-rm>${TRASH}<span>Remove from vocabulary</span></button>${note}</div>`;
}

/* ---------- remove the word you are looking at from the vocabulary (no navigation, no reload) ---------- */
function rebuildKnown() {                                  // underlines follow the vocabulary exactly
  R.known = new Set();
  R.ents.forEach(v => { if (v.kind === 'word') v.forms.forEach(f => R.known.add(f.form.toLowerCase())); });
  $$('#r-text .w').forEach(n => n.classList.toggle('k', R.known.has(n.textContent.toLowerCase())));
}
function removeWord() {
  if (!P || !R) return;
  const e = P.rec.e;
  if (R.ents.get(e.id) !== e) return;                      // already removed (double tap)
  const had = $$('#r-text .w.k');
  R.ents.delete(e.id); R.vcount--; DB.del('vocab', e.id);   // only this lemma's entry in this book; nothing else is touched
  rebuildKnown(); setVCount();
  had.filter(n => !n.classList.contains('k')).forEach(n => { n.classList.add('rm-flash'); setTimeout(() => n.classList.remove('rm-flash'), 800); });
  hidePop(); P = null;
  toastAction(`Removed “${e.lemma}” from vocabulary`, 'Undo', () => restoreEntry(e));
}
function restoreEntry(e) {
  const live = R && R.book.id === e.bookId ? R : null;
  const cur = live && live.ents.get(e.id);
  if (cur) {                                               // you looked the word up again before pressing Undo: merge, lose nothing
    for (const f of e.forms) { const m = cur.forms.find(x => x.form.toLowerCase() === f.form.toLowerCase()); if (m) m.n += f.n; else cur.forms.push(f); }
    for (const c of e.contexts) if (!cur.contexts.some(x => x.s === c.s && (x.form || '') === (c.form || ''))) cur.contexts.push(c);
    cur.count += e.count; cur.first = Math.min(cur.first, e.first); cur.learned = cur.learned || e.learned; cur.srs = cur.srs || e.srs;
    DB.put('vocab', cur);
  } else {
    DB.put('vocab', e);
    if (live) { live.ents.set(e.id, e); live.vcount++; }
  }
  if (live) { rebuildKnown(); setVCount(); }
  toast(`Restored “${e.lemma}”`);
}

function renderWordPop() {
  const { span, info, ranked, idx, d, rec } = P, n = rec.f.n;
  const wasOpen = $('#pop details.alt')?.open;
  const lem = `<b>${esc(d.lemma)}</b>`;
  const body = d.isForm
    ? `${formLine(d, info.word)}<div class="pl">${lem} = <i>${esc(d.meaning || '—')}</i></div>${d.formMeaning ? `<div class="pm"><b>${esc(info.word)}</b> = <i>${esc(d.formMeaning)}</i></div>` : ''}`
    : `<div class="pm"><b>${esc(info.word)}</b> = <i>${esc(d.meaning || '—')}</i></div>`;
  const alts = ranked.map((x, i) => ({ i, d: describe(x.r, info.ctx) })).filter(x => x.i !== idx && x.d.meaning);
  const pending = ranked.some((x, i) => i !== idx && !x.r.senses);
  showPop(span, `${popHead(info.word, n === 1 ? 'Saved' : `Looked up ${n}×`)}
    ${body}
    <div class="ps">${esc([d.pos, d.via ? `via ${d.via}` : '', d.mt ? 'machine translation' : ''].filter(Boolean).join(' · '))}</div>
    ${removeRow(rec.e, info)}
    ${alts.length ? `<details class="alt"><summary>Other readings (${alts.length})</summary>${alts.map(a => `<button class="altb" data-alt="${a.i}"><b>${esc(a.d.lemma || info.word)}</b>${a.d.pos ? ` <small>${esc(a.d.pos)}</small>` : ''}<span>${esc(a.d.meaning)}</span></button>`).join('')}</details>` : (pending ? '<div class="pn alt-load">Checking other readings…</div>' : '')}`);
  if (wasOpen) { const dt = $('#pop details.alt'); if (dt) dt.open = true; }
}
function switchReading(i) {
  const { info, ranked } = P, d = describe(ranked[i].r, info.ctx);
  unrecordWord(P.rec.e.id, info);
  const rec = recordWord(info, d);
  P.idx = i; P.d = d; P.rec = rec; renderWordPop(); setVCount();
}

/* ---------- selected phrase ---------- */
const rangeText = spans => {
  const groups = [];
  for (const s of spans) { const p = s.closest('.para'), g = groups[groups.length - 1]; if (g && g.p === p) g.last = s; else groups.push({ p, first: s, last: s }); }
  return groups.map(g => R.flat[+g.p.dataset.g].t.slice(+g.first.dataset.o, +g.last.dataset.o + g.last.textContent.length)).join(' ').replace(/\s+/g, ' ').trim();
};
const phraseKey = t => t.toLowerCase().replace(/\s+/g, ' ').trim();
async function showPhrase(lo, hi) {
  const spans = R.words.slice(lo, hi + 1), first = spans[0], last = spans[spans.length - 1], text = rangeText(spans);
  if (text.length > 300) { clearRange(); toast('Select a shorter phrase (up to about 300 characters).'); return; }
  const p0 = paraOf(first), st = sentenceAt(p0.t, +first.dataset.o, first.textContent.length);
  const same = first.closest('.para') === last.closest('.para');
  const endOff = same ? +last.dataset.o + last.textContent.length : st.end;
  let sent = p0.t.slice(st.start, Math.max(st.end, endOff)).trim(); if (sent.length > 420) sent = st.text;
  const saved = R.ents.get(entryId(R.book.id, 'phrase', phraseKey(text)));
  PP = { span: last, text, sent, loc: locOf(first), sec: secTitleOf(p0, +first.dataset.o), tr: '', sentTr: '', saved: !!saved, state: 'load' };
  renderPhrasePop();
  await runTranslation(PP);
}
async function runTranslation(p) {
  p.state = 'load'; p.err = '';
  try { p.tr = await translatePhrase(p.text); p.state = 'ok'; }
  catch (e) { p.state = e.kind === 'nomatch' ? 'none' : 'offline'; p.err = e.detail || e.message; }
  if (PP === p) renderPhrasePop();
}
function renderPhrasePop() {
  const p = PP, x = ICON_X;
  const fullIsSame = phraseKey(p.sent) === phraseKey(p.text);
  showPop(p.span, `<div class="ph"><span class="pw phrase">“${esc(p.text)}”</span><button class="px" aria-label="Close">${x}</button></div>
    ${p.state === 'load' ? '<div class="dots"><i></i><i></i><i></i></div>' : ''}
    ${p.state === 'ok' ? `<div class="pm">${esc(p.tr)}</div>` : ''}
    ${p.state === 'offline' ? `<div class="pe">Couldn’t reach the translator.</div><div class="pd">${esc(p.err)}</div><button class="retry-ph">Try again</button>` : ''}
    ${p.state === 'none' ? `<div class="pe">No translation found for this phrase.</div><div class="pd">${esc(p.err)}</div>` : ''}
    ${p.sentTr ? `<div class="pn"><i>${esc(p.sent)}</i><br>${esc(p.sentTr)}</div>` : ''}
    ${p.state === 'ok' ? `<div class="pact"><button class="save-ph ${p.saved ? 'done' : ''}" ${p.saved ? 'disabled' : ''}>${p.saved ? '✓ Saved' : 'Save phrase'}</button>${!fullIsSame && !p.sentTr ? '<button class="sent-ph">Translate sentence</button>' : ''}</div>` : ''}`);
}

$('#pop').addEventListener('click', async e => {
  const t = e.target;
  if (t.closest('.px')) return hidePop();
  if (t.closest('[data-rm]')) return removeWord();
  if (t.closest('.retry')) { if (popAnchor?.isConnected) onWord(popAnchor); return; }
  const alt = t.closest('[data-alt]'); if (alt) return switchReading(+alt.dataset.alt);
  if (!PP) return;
  if (t.closest('.retry-ph')) { renderPhrasePop(); runTranslation(PP); return; }
  if (t.closest('.save-ph')) { recordPhrase(PP); PP.saved = true; R.vcount++; setVCount(); renderPhrasePop(); toast('Phrase saved to vocabulary'); return; }
  if (t.closest('.sent-ph')) {
    const cur = PP; cur.sentTr = '…'; renderPhrasePop();
    try { cur.sentTr = await translatePhrase(cur.sent); } catch (e) { cur.sentTr = 'Couldn’t translate the sentence (' + (e.detail || e.message) + ').'; }
    if (PP === cur) renderPhrasePop();
  }
});

/* popup placement */
let popAnchor = null;
function showPop(span, html) {
  popAnchor = span;
  const pop = $('#pop'); pop.innerHTML = html; pop.hidden = false; placePop();
}
function placePop() {
  const pop = $('#pop'), r = popAnchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  const left = Math.min(Math.max(10, r.left + r.width / 2 - pw / 2), innerWidth - pw - 10);
  let top = r.bottom + 10; if (top + ph > innerHeight - 14) top = Math.max(70, r.top - ph - 10);
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
}
$('#pop').addEventListener('toggle', placePop, true);
function hidePop() { $('#pop').hidden = true; $$('.w.sel').forEach(n => n.classList.remove('sel')); clearRange(); }
document.addEventListener('pointerdown', e => {
  if (!$('#pop').hidden && !e.target.closest('#pop') && !e.target.closest('#r-text .w')) { hidePop(); tapDismissed = true; setTimeout(() => { tapDismissed = false; }, 450); }
}, true);

/* ================= Vocabulary model ================= */
const entryId = (bookId, kind, key) => `${bookId}|${kind === 'phrase' ? 'p' : 'w'}|${key}`;
const newSrs = () => ({ box: 0, due: 0, seen: 0, right: 0, wrong: 0, last: 0 });

function recordWord(info, d) {
  const key = (d.lemma || info.lower).toLowerCase(), id = entryId(R.book.id, 'word', key), now = Date.now();
  let e = R.ents.get(id);
  if (!e) { e = { id, v: 2, kind: 'word', bookId: R.book.id, key, lemma: d.lemma || info.lower, pos: d.pos, meaning: d.meaning, forms: [], contexts: [], count: 0, first: now, last: now, learned: false, srs: null }; R.ents.set(id, e); R.vcount++; }
  e.count++; e.last = now; e.pos = d.pos || e.pos; e.meaning = d.meaning || e.meaning; e.lemma = d.lemma || e.lemma;
  let f = e.forms.find(x => x.form.toLowerCase() === info.lower);
  if (!f) { f = { form: info.form, fm: '', gram: '', n: 0, last: now }; e.forms.push(f); }
  f.n++; f.last = now; f.fm = d.formMeaning || ''; f.gram = d.gram || '';
  if (!e.contexts.some(c => c.s === info.ctx.sentence && (c.form || '').toLowerCase() === info.lower)) {
    e.contexts.push({ s: info.ctx.sentence, loc: info.loc, sec: info.sec, form: f.form });
    if (e.contexts.length > 8) e.contexts.splice(1, 1);
  }
  R.known.add(info.lower); DB.put('vocab', e);
  return { e, f };
}
function unrecordWord(id, info) {
  const e = R.ents.get(id); if (!e) return;
  const f = e.forms.find(x => x.form.toLowerCase() === info.lower);
  if (f) { f.n--; if (f.n <= 0) e.forms.splice(e.forms.indexOf(f), 1); }
  e.contexts = e.contexts.filter(c => !(c.s === info.ctx.sentence && (c.form || '').toLowerCase() === info.lower) || (f && f.n > 0));
  e.count--;
  if (e.count <= 0 || !e.forms.length) { R.ents.delete(id); R.vcount--; DB.del('vocab', id); } else DB.put('vocab', e);
}
function recordPhrase(p) {
  const key = phraseKey(p.text), id = entryId(R.book.id, 'phrase', key), now = Date.now();
  let e = R.ents.get(id);
  if (e) { e.count++; e.last = now; e.meaning = p.tr || e.meaning; }
  else { e = { id, v: 2, kind: 'phrase', bookId: R.book.id, key, lemma: p.text, pos: 'phrase', meaning: p.tr, forms: [], contexts: [{ s: p.sent, loc: p.loc, sec: p.sec, form: '' }], count: 1, first: now, last: now, learned: false, srs: null }; R.ents.set(id, e); }
  DB.put('vocab', e);
}

/* old (v1) entries → grouped-by-lemma entries */
async function migrateVocab() {
  const old = (await DB.all('vocab')).filter(v => v.v !== 2);
  for (const o of old) {
    const lemma = (o.lemma || o.key || '').toLowerCase(), key = lemma, id = entryId(o.bookId, 'word', key);
    let e = await DB.get('vocab', id); const form = o.word || o.key;
    const ctxs = (o.contexts || []).map(c => ({ s: c.s, loc: c.loc, sec: (c.loc || '').split(' · p.')[0], form }));
    if (!e) e = { id, v: 2, kind: 'word', bookId: o.bookId, key, lemma: o.lemma || o.key, pos: o.pos || '', meaning: o.meaning, forms: [], contexts: [], count: 0, first: o.first || Date.now(), last: o.last || Date.now(), learned: false, srs: null };
    e.count += o.count || 1; e.last = Math.max(e.last, o.last || 0);
    e.forms.push({ form, fm: '', gram: '', n: o.count || 1, last: o.last || 0 }); e.contexts.push(...ctxs);
    await DB.put('vocab', e); await DB.del('vocab', o.id);
  }
}

/* ================= Vocabulary view ================= */
let vFilter = 'all', vSort = 'recent', vShow = 'all', vQuery = '';
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function markWord(ctx, key) {
  const re = new RegExp(`(^|[^\\p{L}\\p{M}])(${reEsc(key)})(?![\\p{L}\\p{M}])`, 'giu');
  let out = '', last = 0;
  for (const m of ctx.matchAll(re)) { const s = m.index + m[1].length; out += esc(ctx.slice(last, s)) + `<mark>${esc(m[2])}</mark>`; last = s + m[2].length; }
  return out + esc(ctx.slice(last));
}
const chapterOf = c => c.sec ?? (c.loc || '').split(' · p.')[0];
async function renderVocab() {
  books = await loadBooks();
  const all = (await DB.all('vocab')).filter(v => v.v === 2 && books.some(b => b.id === v.bookId));
  const per = new Map(); all.forEach(v => per.set(v.bookId, (per.get(v.bookId) || 0) + 1));
  if (vFilter !== 'all' && !per.has(vFilter)) vFilter = 'all';
  const titleOf = id => books.find(b => b.id === id)?.title || '';
  const nW = all.filter(v => v.kind === 'word').length, nP = all.length - nW, nL = all.filter(v => v.learned).length;
  $('#vocab-summary').textContent = all.length ? `${nW} word${nW === 1 ? '' : 's'}${nP ? ` · ${nP} phrase${nP === 1 ? '' : 's'}` : ''} · ${nL} learned` : '';
  $('#vocab-books').innerHTML = [`<button class="chip ${vFilter === 'all' ? 'on' : ''}" data-f="all">All (${all.length})</button>`,
    ...books.filter(b => per.has(b.id)).map(b => `<button class="chip ${vFilter === b.id ? 'on' : ''}" data-f="${b.id}">${esc(b.title)} (${per.get(b.id)})</button>`)].join('');
  $('#vocab-sort').value = vSort; $('#vocab-show').value = vShow;
  const q = vQuery.trim().toLowerCase();
  const list = all.filter(v => (vFilter === 'all' || v.bookId === vFilter)
    && (vShow === 'all' || (vShow === 'todo' && !v.learned) || (vShow === 'learned' && v.learned) || (vShow === 'phrases' && v.kind === 'phrase'))
    && (!q || [v.key, v.lemma, v.meaning, ...(v.forms || []).map(f => f.form)].some(x => (x || '').toLowerCase().includes(q))));
  list.sort(vSort === 'az' ? (a, b) => a.key.localeCompare(b.key, 'es') : vSort === 'count' ? (a, b) => b.count - a.count || b.last - a.last : (a, b) => b.last - a.last);
  const box = $('#vocab-list');
  if (!all.length) { box.innerHTML = `<div class="empty"><h3>No words yet</h3><p>Tap any word while you read. Long-press and slide across words to save a whole phrase.</p></div>`; return; }
  if (!list.length) { box.innerHTML = `<div class="empty"><p>Nothing matches this filter.</p></div>`; return; }
  box.innerHTML = list.map(v => {
    const forms = (v.forms || []).slice().sort((a, b) => b.n - a.n), c0 = v.contexts[0];
    const ctxHtml = (c, key) => `<p class="ctx">${markWord(c.s, key)}<span class="loc">${esc(c.loc || '')}</span></p>`;
    const isPhrase = v.kind === 'phrase';
    const showForms = forms.length > 1 || (forms.length === 1 && forms[0].form.toLowerCase() !== v.lemma.toLowerCase());
    const more = !isPhrase && (forms.some(f => f.fm || f.gram) || v.contexts.length > 1 || forms.length > 1);
    const detail = more ? `<details><summary>Forms &amp; sentences</summary>${forms.map(f => `<div class="fdet"><b>${esc(f.form)}</b>${f.fm ? ` = <i>${esc(f.fm)}</i>` : ''}${f.gram ? ` <small>${esc(f.gram)}</small>` : ''} <small>· ${f.n}×</small>${v.contexts.filter(c => (c.form || '').toLowerCase() === f.form.toLowerCase()).map(c => ctxHtml(c, f.form)).join('')}</div>`).join('')}</details>` : '';
    return `<article class="vcard ${v.learned ? 'is-learned' : ''} ${isPhrase ? 'is-phrase' : ''}">
      <div class="top"><span class="w1 ${isPhrase ? 'phrase' : ''}">${esc(v.lemma)}</span>${!isPhrase && v.pos ? `<span class="lem">${esc(v.pos)}</span>` : ''}${isPhrase ? '<span class="lem">phrase</span>' : ''}<span class="cnt">${v.count}×</span></div>
      <div class="mean">${esc(v.meaning)}</div>
      ${showForms ? `<div class="forms">${forms.map(f => `<span class="fchip">${esc(f.form)}${f.n > 1 ? ` ×${f.n}` : ''}</span>`).join('')}</div>` : ''}
      ${c0 ? ctxHtml(c0, isPhrase ? v.lemma : (c0.form || v.lemma)) : ''}
      ${detail}
      <div class="foot"><span>${vFilter === 'all' ? esc(titleOf(v.bookId)) + ' · ' : ''}${esc(c0 ? chapterOf(c0) : '')}</span>
        <span class="acts"><button class="lrn ${v.learned ? 'on' : ''}" data-learn="${esc(v.id)}">${v.learned ? '✓ Learned' : 'Mark learned'}</button><button class="del" data-del="${esc(v.id)}">Remove</button></span></div>
    </article>`;
  }).join('');
}
$('#vocab-books').addEventListener('click', e => { const c = e.target.closest('.chip'); if (c) { vFilter = c.dataset.f; renderVocab(); } });
$('#vocab-search').addEventListener('input', e => { vQuery = e.target.value; renderVocab(); });
$('#vocab-sort').addEventListener('change', e => { vSort = e.target.value; renderVocab(); });
$('#vocab-show').addEventListener('change', e => { vShow = e.target.value; renderVocab(); });
$('#vocab-list').addEventListener('click', async e => {
  const l = e.target.closest('[data-learn]');
  if (l) {
    const v = await DB.get('vocab', l.dataset.learn); if (!v) return;
    v.learned = !v.learned; const s = v.srs ||= newSrs();
    if (v.learned) { s.box = Math.max(s.box, 4); s.due = Date.now() + 30 * 864e5; } else s.due = Date.now();
    await DB.put('vocab', v); return renderVocab();
  }
  const b = e.target.closest('[data-del]'); if (!b) return;
  if (await ask('Remove this entry?', 'It will be deleted from the vocabulary list and flashcards.')) { await DB.del('vocab', b.dataset.del); renderVocab(); }
});

/* ================= Install + offline ================= */
let deferred = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#btn-install').hidden = false; });
$('#btn-install').addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#btn-install').hidden = true; });
addEventListener('appinstalled', () => { $('#btn-install').hidden = true; });
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => { }));

/* ================= Boot ================= */
initLex({ get: k => DB.get('dict', k), put: r => DB.put('dict', r) });
initReview({ DB, $, $$, esc, books: () => books, mark: markWord });
bindReview();
applySettings();
show('library');
migrateVocab().catch(console.error).finally(renderShelf);
