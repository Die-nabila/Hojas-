/* Hojas — local-first Spanish reading PWA. No backend: everything lives in this device's IndexedDB. */
import { initLex, analyze, rank, describe, translatePhrase } from './lex.js';
import { initReview, renderReview, bindReview } from './review.js';
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
const S = Object.assign({ size: 20, face: 'serif', theme: 'meadow' }, JSON.parse(localStorage.getItem('hojas.settings') || '{}'));
function applySettings() {
  const r = document.documentElement;
  r.dataset.theme = S.theme; r.dataset.face = S.face; r.style.setProperty('--fs', S.size + 'px');
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
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }
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
const pctOf = b => { const t = b.total || 1; const before = b.counts.slice(0, b.progress.sec).reduce((a, n) => a + n, 0); return Math.min(100, Math.round(100 * (before + b.progress.para) / t)); };

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
$('#shelf').addEventListener('click', async e => {
  const o = e.target.closest('[data-open]'), m = e.target.closest('[data-more]');
  if (o) openBook(o.dataset.open);
  if (m) {
    const b = books.find(x => x.id === m.dataset.more);
    if (b && await ask('Remove this book?', `“${b.title}” and its saved words will be deleted from this phone.`)) {
      await Promise.all([DB.del('books', b.id), DB.del('content', b.id), DB.delByBook(b.id)]);
      renderShelf(); toast('Book removed');
    }
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
      cover: parsed.cover || null, added: Date.now(), lastOpened: 0, counts, total: counts.reduce((a, c) => a + c, 0), progress: { sec: 0, para: 0 }
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
    if (last && ps.length && !last.h && !ps[0].h && !/[.!?…:»”"')]$/.test(last.t) && /^\p{Ll}/u.test(ps[0].t)) joinInto(last, ps.shift().t);
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
  return { title, author, cover, sections };
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

/* ================= Reader ================= */
let R = null, saveT, lookupToken = 0, P = null, PP = null, sel = null, gs = null, suppressClick = false, afterReader = null;
const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
function wrap(t) {
  let out = '', last = 0;
  t.replace(WORD, (m, off) => {
    out += esc(t.slice(last, off)) + `<span class="w${R.known.has(m.toLowerCase()) ? ' k' : ''}" data-o="${off}" data-n="${R.wc++}">${esc(m)}</span>`;
    last = off + m.length; return m;
  });
  return out + esc(t.slice(last));
}

async function openBook(id) {
  const book = books.find(b => b.id === id); if (!book) return;
  busy('Opening book');
  try {
    const content = await DB.get('content', id);
    if (!content) throw new Error('This book’s text is missing. Remove it and import it again.');
    const vocab = (await DB.byBook(id)).filter(v => v.v === 2);
    R = { book, sections: content.sections, sec: 0, paras: [], words: [], wc: 0, vcount: vocab.length,
      known: new Set(vocab.filter(v => v.kind === 'word').flatMap(v => v.forms.map(f => f.form.toLowerCase()))) };
    book.lastOpened = Date.now(); DB.put('books', book);
    history.pushState({ reader: 1 }, '');
    show('reader');
    $('#r-book').textContent = book.title; setVCount();
    const p = book.progress || { sec: 0, para: 0 };
    renderSection(Math.min(p.sec, R.sections.length - 1), p.para);
  } catch (e) { toast(e.message, 4500); }
  hideBusy();
}
const setVCount = () => { $('#r-vcount').textContent = R.vcount || ''; $('#r-vcount').hidden = !R.vcount; };

function renderSection(i, para = 0) {
  hidePop(); R.sec = i; R.wc = 0;
  const sec = R.sections[i], last = i === R.sections.length - 1;
  const html = [`<h2 class="sec-title">${esc(sec.title)}</h2>`];
  sec.paras.forEach((p, idx) => { const tag = p.h ? 'h3' : 'p'; html.push(`<${tag} class="para" data-i="${idx}">${wrap(p.t)}</${tag}>`); });
  html.push(`<div class="chapter-nav"><button class="prev" ${i === 0 ? 'disabled' : ''}>Previous</button><button class="next" ${last ? 'disabled' : ''}>${last ? 'The end' : 'Next chapter'}</button></div>`);
  $('#r-text').innerHTML = html.join('');
  R.paras = $$('#r-text .para'); R.words = $$('#r-text .w');
  $('#r-sec').textContent = sec.title;
  const sc = $('#r-scroll'); sc.scrollTop = 0;
  if (para > 0 && R.paras[para]) sc.scrollTop = R.paras[para].getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 10;
  updateBar(para);
}
function currentPara() {
  const top = $('#r-scroll').getBoundingClientRect().top + 6; let lo = 0, hi = R.paras.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (R.paras[mid].getBoundingClientRect().bottom > top) hi = mid; else lo = mid + 1; }
  return lo;
}
function updateBar(para) {
  const before = R.sections.slice(0, R.sec).reduce((a, s) => a + s.paras.length, 0), total = R.sections.reduce((a, s) => a + s.paras.length, 0) || 1;
  $('#r-bar').style.width = Math.min(100, 100 * (before + para) / total) + '%';
}
function saveProgress() {
  if (!R || view !== 'reader') return;
  const sc = $('#r-scroll'), para = sc.scrollTop < 20 ? 0 : currentPara();
  R.book.progress = { sec: R.sec, para }; DB.put('books', R.book); updateBar(para);
}
$('#r-scroll').addEventListener('scroll', () => { if (!gs?.active) hidePop(); clearTimeout(saveT); saveT = setTimeout(saveProgress, 350); }, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });
addEventListener('pagehide', saveProgress);

function leaveReader() { saveProgress(); R = null; const next = afterReader || 'library'; afterReader = null; goTab(next); }
addEventListener('popstate', () => { if (view === 'reader') leaveReader(); });
$('#r-back').addEventListener('click', () => history.back());
$('#r-vocab').addEventListener('click', () => { afterReader = 'vocab'; vFilter = R.book.id; history.back(); });
$('#r-toc').addEventListener('click', () => {
  $('#toc-list').innerHTML = R.sections.map((s, i) => `<li><button data-i="${i}" class="${i === R.sec ? 'on' : ''}">${esc(s.title)}</button></li>`).join('');
  openSheet('#sheet-toc');
  $('#toc-list .on')?.scrollIntoView({ block: 'center' });
});
$('#toc-list').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { closeSheets(); renderSection(+b.dataset.i); saveProgress(); } });

$('#r-aa').addEventListener('click', () => {
  $('#set-size').value = S.size;
  $$('#set-face button').forEach(b => b.classList.toggle('on', b.dataset.v === S.face));
  $$('#set-theme button').forEach(b => b.classList.toggle('on', b.dataset.v === S.theme));
  openSheet('#sheet-set');
});
$('#set-size').addEventListener('input', e => { S.size = +e.target.value; applySettings(); });
$('#set-face').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.face = b.dataset.v; applySettings(); $$('#set-face button').forEach(x => x.classList.toggle('on', x === b)); });
$('#set-theme').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.theme = b.dataset.v; applySettings(); $$('#set-theme button').forEach(x => x.classList.toggle('on', x === b)); });

/* ================= Tap a word / long-press and slide across words ================= */
const textEl = $('#r-text');
textEl.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; }
  const nav = e.target.closest('.chapter-nav button');
  if (nav && !nav.disabled) { renderSection(R.sec + (nav.classList.contains('next') ? 1 : -1)); saveProgress(); return; }
  const w = e.target.closest('.w');
  if (w) onWord(w); else hidePop();
});
textEl.addEventListener('contextmenu', e => e.preventDefault());

function wordAt(x, y) {
  for (const [dx, dy] of [[0, 0], [-8, 0], [8, 0], [0, -8], [0, 8], [-18, 0], [18, 0]]) {
    const w = document.elementFromPoint(x + dx, y + dy)?.closest?.('.w');
    if (w && textEl.contains(w)) return w;
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
  if (R) $$('.w.rng', textEl).forEach(n => n.classList.remove('rng'));
  sel = null; PP = null;
}
function beginSel(w) { hidePop(); sel = { a: +w.dataset.n, b: +w.dataset.n }; paintRange(); navigator.vibrate?.(12); }
function extendSel(w) { const n = +w.dataset.n; if (sel && n !== sel.b) { sel.b = n; paintRange(); } }
function endSel() {
  if (!sel) return;
  const lo = Math.min(sel.a, sel.b), hi = Math.max(sel.a, sel.b);
  if (lo === hi) { const w = R.words[lo]; clearRange(); onWord(w); } else showPhrase(lo, hi);
}
let edgeT = null;
function edgeScroll(y) {
  const sc = $('#r-scroll'), r = sc.getBoundingClientRect(), z = 70;
  clearInterval(edgeT);
  const dir = y < r.top + z ? -1 : y > r.bottom - z ? 1 : 0;
  if (dir) edgeT = setInterval(() => { sc.scrollTop += dir * 9; const w = gs && wordAt(gs.lx, gs.ly); if (w) extendSel(w); }, 16);
}

textEl.addEventListener('touchstart', e => {
  if (!R || e.touches.length !== 1) { gs = null; return; }
  const t = e.touches[0], w = e.target.closest?.('.w');
  clearTimeout(gs?.timer);
  gs = { x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY, active: false, timer: null };
  if (w) gs.timer = setTimeout(() => { if (gs) { gs.active = true; beginSel(w); } }, 380);
}, { passive: true });
textEl.addEventListener('touchmove', e => {
  if (!gs) return;
  const t = e.touches[0]; gs.lx = t.clientX; gs.ly = t.clientY;
  if (!gs.active) { if (Math.hypot(t.clientX - gs.x, t.clientY - gs.y) > 10) { clearTimeout(gs.timer); gs = null; } return; }
  e.preventDefault();
  const w = wordAt(t.clientX, t.clientY); if (w) extendSel(w);
  edgeScroll(t.clientY);
}, { passive: false });
const endTouch = e => {
  if (!gs) return;
  clearTimeout(gs.timer); clearInterval(edgeT);
  if (gs.active) { if (e.cancelable) e.preventDefault(); suppressClick = true; setTimeout(() => suppressClick = false, 400); const g = gs; gs = null; endSel(); return g; }
  gs = null;
};
textEl.addEventListener('touchend', endTouch);
textEl.addEventListener('touchcancel', () => { if (gs) { clearTimeout(gs.timer); clearInterval(edgeT); if (gs.active) endSel(); gs = null; } });

/* mouse: press on a word and drag across others */
let md = null;
textEl.addEventListener('mousedown', e => { const w = e.target.closest?.('.w'); md = w && e.button === 0 ? { w, moved: false } : null; });
textEl.addEventListener('mousemove', e => {
  if (!md || !(e.buttons & 1)) return;
  const w = e.target.closest?.('.w'); if (!w) return;
  if (!md.moved && w !== md.w) { md.moved = true; beginSel(md.w); }
  if (md.moved) extendSel(w);
});
addEventListener('mouseup', () => { if (md?.moved) { suppressClick = true; setTimeout(() => suppressClick = false, 300); endSel(); } md = null; });

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
const paraOf = span => R.sections[R.sec].paras[+span.closest('.para').dataset.i];
const locOf = span => { const sec = R.sections[R.sec], p = paraOf(span); return sec.title + (p.p ? ` · p. ${p.p}` : ''); };

/* ---------- single word ---------- */
async function onWord(span) {
  clearRange();
  const word = span.textContent, lower = word.toLowerCase(), token = ++lookupToken;
  const para = paraOf(span), off = +span.dataset.o, st = sentenceAt(para.t, off, word.length);
  const toks = s => (s.match(WORD) || []).map(x => x.toLowerCase());
  const before = toks(para.t.slice(st.start, off)), after = toks(para.t.slice(off + word.length, st.end));
  const ctx = { word: lower, prev: before.slice(-2).reverse(), next: after.slice(0, 2), sentence: st.text, capMid: /^\p{Lu}/u.test(word) && before.length > 0 };
  const info = { word, lower, form: ctx.capMid ? word : lower, ctx, loc: locOf(span), sec: R.sections[R.sec].title };
  $$('.w.sel').forEach(n => n.classList.remove('sel')); span.classList.add('sel');
  showPop(span, `<div class="ph"><span class="pw">${esc(word)}</span><button class="px" aria-label="Close">${ICON_X}</button></div><div class="dots"><i></i><i></i><i></i></div>`);
  try {
    const ranked = rank(await analyze(word), ctx);
    const d = describe(ranked[0].r, ctx);
    const rec = await recordWord(info, d);
    $$('#r-text .w').forEach(n => { if (n.textContent.toLowerCase() === lower) n.classList.add('k'); });
    setVCount();
    if (token === lookupToken) { P = { span, info, ranked, idx: 0, d, rec }; renderWordPop(); }
  } catch (err) {
    if (token !== lookupToken) return;
    const off = err.message === 'offline';
    showPop(span, `<div class="ph"><span class="pw">${esc(word)}</span><button class="px" aria-label="Close">${ICON_X}</button></div>
      <div class="pe">${off ? 'Couldn’t reach the dictionary. Check your connection and try again.' : `No meaning found for “${esc(word)}”.`}</div>
      ${off ? '<button class="retry">Try again</button>' : ''}`);
  }
}

function renderWordPop() {
  const { span, info, ranked, idx, d, rec } = P, n = rec.f.n;
  let body;
  const lem = `<b>${esc(d.lemma)}</b>`;
  if (d.isForm) {
    const from = d.verbish ? `from ${lem}${d.gram ? ` <span class="pg">${esc(d.gram)}</span>` : ''}` : (d.gram ? `${esc(d.gram)} form of ${lem}` : `from ${lem}`);
    body = `<div class="pf">${from}</div>
      <div class="pl">${lem} = <i>${esc(d.meaning || '—')}</i></div>
      ${d.formMeaning ? `<div class="pm"><b>${esc(info.word)}</b> = <i>${esc(d.formMeaning)}</i></div>` : ''}`;
  } else {
    body = `<div class="pm"><b>${esc(info.word)}</b> = <i>${esc(d.meaning || '—')}</i></div>`;
  }
  const alts = ranked.map((x, i) => ({ i, d: describe(x.r, info.ctx) })).filter(x => x.i !== idx && x.d.meaning);
  showPop(span, `<div class="ph"><span class="pw">${esc(info.word)}</span><span class="pc">${n === 1 ? 'Saved' : `Looked up ${n}×`}</span><button class="px" aria-label="Close">${ICON_X}</button></div>
    ${body}
    <div class="ps">${esc([d.pos, d.via ? `via ${d.via}` : '', d.mt ? 'machine translation' : ''].filter(Boolean).join(' · '))}</div>
    ${alts.length ? `<details class="alt"><summary>Other readings (${alts.length})</summary>${alts.map(a => `<button class="altb" data-alt="${a.i}"><b>${esc(a.d.lemma || info.word)}</b>${a.d.pos ? ` <small>${esc(a.d.pos)}</small>` : ''}<span>${esc(a.d.meaning)}</span></button>`).join('')}</details>` : ''}`);
}
async function switchReading(i) {
  const { info, ranked } = P, d = describe(ranked[i].r, info.ctx);
  await unrecordWord(P.rec.e.id, info);
  const rec = await recordWord(info, d);
  P.idx = i; P.d = d; P.rec = rec; renderWordPop(); setVCount();
}

/* ---------- selected phrase ---------- */
const rangeText = spans => {
  const groups = [];
  for (const s of spans) { const p = s.closest('.para'), g = groups[groups.length - 1]; if (g && g.p === p) g.last = s; else groups.push({ p, first: s, last: s }); }
  return groups.map(g => R.sections[R.sec].paras[+g.p.dataset.i].t.slice(+g.first.dataset.o, +g.last.dataset.o + g.last.textContent.length)).join(' ').replace(/\s+/g, ' ').trim();
};
const phraseKey = t => t.toLowerCase().replace(/\s+/g, ' ').trim();
async function showPhrase(lo, hi) {
  const spans = R.words.slice(lo, hi + 1), first = spans[0], last = spans[spans.length - 1], text = rangeText(spans);
  if (text.length > 300) { clearRange(); toast('Select a shorter phrase (up to about 300 characters).'); return; }
  const p0 = paraOf(first), st = sentenceAt(p0.t, +first.dataset.o, first.textContent.length);
  const same = first.closest('.para') === last.closest('.para');
  const endOff = same ? +last.dataset.o + last.textContent.length : st.end;
  let sent = p0.t.slice(st.start, Math.max(st.end, endOff)).trim(); if (sent.length > 420) sent = st.text;
  const saved = await DB.get('vocab', entryId(R.book.id, 'phrase', phraseKey(text)));
  PP = { span: last, text, sent, loc: locOf(first), sec: R.sections[R.sec].title, tr: '', sentTr: '', saved: !!saved, state: 'load' };
  renderPhrasePop();
  try { PP.tr = await translatePhrase(text); PP.state = 'ok'; } catch (e) { PP.state = e.message === 'offline' ? 'offline' : 'none'; }
  if (PP && PP.text === text) renderPhrasePop();
}
function renderPhrasePop() {
  const p = PP, x = ICON_X;
  const fullIsSame = phraseKey(p.sent) === phraseKey(p.text);
  showPop(p.span, `<div class="ph"><span class="pw phrase">“${esc(p.text)}”</span><button class="px" aria-label="Close">${x}</button></div>
    ${p.state === 'load' ? '<div class="dots"><i></i><i></i><i></i></div>' : ''}
    ${p.state === 'ok' ? `<div class="pm">${esc(p.tr)}</div>` : ''}
    ${p.state === 'offline' ? '<div class="pe">Couldn’t reach the translator. Check your connection and try again.</div><button class="retry-ph">Try again</button>' : ''}
    ${p.state === 'none' ? '<div class="pe">No translation found for this phrase.</div>' : ''}
    ${p.sentTr ? `<div class="pn"><i>${esc(p.sent)}</i><br>${esc(p.sentTr)}</div>` : ''}
    ${p.state === 'ok' ? `<div class="pact"><button class="save-ph ${p.saved ? 'done' : ''}" ${p.saved ? 'disabled' : ''}>${p.saved ? '✓ Saved' : 'Save phrase'}</button>${!fullIsSame && !p.sentTr ? '<button class="sent-ph">Translate sentence</button>' : ''}</div>` : ''}`);
}

$('#pop').addEventListener('click', async e => {
  const t = e.target;
  if (t.closest('.px')) return hidePop();
  if (t.closest('.retry')) { if (popAnchor?.isConnected) onWord(popAnchor); return; }
  const alt = t.closest('[data-alt]'); if (alt) return switchReading(+alt.dataset.alt);
  if (!PP) return;
  if (t.closest('.retry-ph')) { const { text } = PP; PP.state = 'load'; renderPhrasePop(); try { PP.tr = await translatePhrase(text); PP.state = 'ok'; } catch (er) { PP.state = er.message === 'offline' ? 'offline' : 'none'; } if (PP) renderPhrasePop(); return; }
  if (t.closest('.save-ph')) { await recordPhrase(PP); PP.saved = true; R.vcount++; setVCount(); renderPhrasePop(); toast('Phrase saved to vocabulary'); return; }
  if (t.closest('.sent-ph')) {
    const cur = PP; cur.sentTr = '…'; renderPhrasePop();
    try { cur.sentTr = await translatePhrase(cur.sent); } catch { cur.sentTr = 'Couldn’t translate the sentence.'; }
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
document.addEventListener('pointerdown', e => { if (!$('#pop').hidden && !e.target.closest('#pop') && !e.target.closest('#r-text .w')) hidePop(); }, true);

/* ================= Vocabulary model ================= */
const entryId = (bookId, kind, key) => `${bookId}|${kind === 'phrase' ? 'p' : 'w'}|${key}`;
const newSrs = () => ({ box: 0, due: 0, seen: 0, right: 0, wrong: 0, last: 0 });

async function recordWord(info, d) {
  const key = (d.lemma || info.lower).toLowerCase(), id = entryId(R.book.id, 'word', key), now = Date.now();
  let e = await DB.get('vocab', id);
  if (!e) { e = { id, v: 2, kind: 'word', bookId: R.book.id, key, lemma: d.lemma || info.lower, pos: d.pos, meaning: d.meaning, forms: [], contexts: [], count: 0, first: now, last: now, learned: false, srs: null }; R.vcount++; }
  e.count++; e.last = now; e.pos = d.pos || e.pos; e.meaning = d.meaning || e.meaning; e.lemma = d.lemma || e.lemma;
  let f = e.forms.find(x => x.form.toLowerCase() === info.lower);
  if (!f) { f = { form: info.form, fm: '', gram: '', n: 0, last: now }; e.forms.push(f); }
  f.n++; f.last = now; f.fm = d.formMeaning || ''; f.gram = d.gram || '';
  if (!e.contexts.some(c => c.s === info.ctx.sentence && (c.form || '').toLowerCase() === info.lower)) {
    e.contexts.push({ s: info.ctx.sentence, loc: info.loc, sec: info.sec, form: f.form });
    if (e.contexts.length > 8) e.contexts.splice(1, 1);
  }
  await DB.put('vocab', e); R.known.add(info.lower);
  return { e, f };
}
async function unrecordWord(id, info) {
  const e = await DB.get('vocab', id); if (!e) return;
  const f = e.forms.find(x => x.form.toLowerCase() === info.lower);
  if (f) { f.n--; if (f.n <= 0) e.forms.splice(e.forms.indexOf(f), 1); }
  e.contexts = e.contexts.filter(c => !(c.s === info.ctx.sentence && (c.form || '').toLowerCase() === info.lower) || (f && f.n > 0));
  e.count--;
  if (e.count <= 0 || !e.forms.length) { await DB.del('vocab', id); R.vcount--; } else await DB.put('vocab', e);
}
async function recordPhrase(p) {
  const key = phraseKey(p.text), id = entryId(R.book.id, 'phrase', key), now = Date.now();
  let e = await DB.get('vocab', id);
  if (e) { e.count++; e.last = now; e.meaning = p.tr || e.meaning; }
  else e = { id, v: 2, kind: 'phrase', bookId: R.book.id, key, lemma: p.text, pos: 'phrase', meaning: p.tr, forms: [], contexts: [{ s: p.sent, loc: p.loc, sec: p.sec, form: '' }], count: 1, first: now, last: now, learned: false, srs: null };
  await DB.put('vocab', e);
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
