/* Hojas — local-first Spanish reading PWA. No backend: everything lives in this device's IndexedDB. */
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
  const c = view === 'reader' ? cs.getPropertyValue('--page') : view === 'vocab' ? cs.getPropertyValue('--bg1') : (S.theme === 'night' ? '#0f6f61' : '#62d6b5');
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
  for (const n of ['library', 'vocab', 'reader']) $('#view-' + n).hidden = n !== v;
  $('#tabs').hidden = v === 'reader';
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === v));
  hidePop(); closeSheets(); themeColor();
}
async function goTab(t) {
  if (t === 'vocab') { show('vocab'); await renderVocab(); }
  else { show('library'); await renderShelf(); }
}
$$('#tabs button').forEach(b => b.addEventListener('click', () => goTab(b.dataset.tab)));

/* ================= Library ================= */
let books = [];
const PAL = [['#17b88c', '#0b6e5a'], ['#5fd0f0', '#1a8fb0'], ['#2bbfa0', '#4cc3e6'], ['#0f9d76', '#7be0c3'], ['#6fd6c9', '#0f8f7a'], ['#7ad0f0', '#12a67f']];
const hash = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const pctOf = b => { const t = b.total || 1; const before = b.counts.slice(0, b.progress.sec).reduce((a, n) => a + n, 0); return Math.min(100, Math.round(100 * (before + b.progress.para) / t)); };

async function renderShelf() {
  books = (await DB.all('books')).sort((a, b) => (b.lastOpened || b.added) - (a.lastOpened || a.added));
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
let R = null, saveT, lookupToken = 0, lastSpan = null;
const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
function wrap(t) {
  let out = '', last = 0;
  t.replace(WORD, (m, off) => {
    out += esc(t.slice(last, off)) + `<span class="w${R.known.has(m.toLowerCase()) ? ' k' : ''}" data-o="${off}">${esc(m)}</span>`;
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
    const vocab = await DB.byBook(id);
    R = { book, sections: content.sections, sec: 0, paras: [], known: new Set(vocab.map(v => v.key)), vcount: vocab.length };
    book.lastOpened = Date.now(); DB.put('books', book);
    history.pushState({ reader: 1 }, '');
    show('reader');
    $('#r-book').textContent = book.title; $('#r-vcount').textContent = R.vcount || ''; $('#r-vcount').hidden = !R.vcount;
    const p = book.progress || { sec: 0, para: 0 };
    renderSection(Math.min(p.sec, R.sections.length - 1), p.para);
  } catch (e) { toast(e.message, 4500); }
  hideBusy();
}

function renderSection(i, para = 0) {
  hidePop(); R.sec = i;
  const sec = R.sections[i], last = i === R.sections.length - 1;
  const html = [`<h2 class="sec-title">${esc(sec.title)}</h2>`];
  sec.paras.forEach((p, idx) => { const tag = p.h ? 'h3' : 'p'; html.push(`<${tag} class="para" data-i="${idx}">${wrap(p.t)}</${tag}>`); });
  html.push(`<div class="chapter-nav"><button class="prev" ${i === 0 ? 'disabled' : ''}>Previous</button><button class="next" ${last ? 'disabled' : ''}>${last ? 'The end' : 'Next chapter'}</button></div>`);
  $('#r-text').innerHTML = html.join('');
  R.paras = $$('#r-text .para');
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
$('#r-scroll').addEventListener('scroll', () => { hidePop(); clearTimeout(saveT); saveT = setTimeout(saveProgress, 350); }, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });
addEventListener('pagehide', saveProgress);

function leaveReader() { saveProgress(); R = null; const next = afterReader || 'library'; afterReader = null; goTab(next); }
let afterReader = null;
addEventListener('popstate', () => { if (view === 'reader') leaveReader(); });
$('#r-back').addEventListener('click', () => history.back());
$('#r-vocab').addEventListener('click', () => { afterReader = 'vocab'; vFilter = R.book.id; history.back(); });
$('#r-toc').addEventListener('click', () => {
  $('#toc-list').innerHTML = R.sections.map((s, i) => `<li><button data-i="${i}" class="${i === R.sec ? 'on' : ''}">${esc(s.title)}</button></li>`).join('');
  openSheet('#sheet-toc');
  $('#toc-list .on')?.scrollIntoView({ block: 'center' });
});
$('#toc-list').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { closeSheets(); renderSection(+b.dataset.i); saveProgress(); } });

/* reading settings */
$('#r-aa').addEventListener('click', () => {
  $('#set-size').value = S.size;
  $$('#set-face button').forEach(b => b.classList.toggle('on', b.dataset.v === S.face));
  $$('#set-theme button').forEach(b => b.classList.toggle('on', b.dataset.v === S.theme));
  openSheet('#sheet-set');
});
$('#set-size').addEventListener('input', e => { S.size = +e.target.value; applySettings(); });
$('#set-face').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.face = b.dataset.v; applySettings(); $$('#set-face button').forEach(x => x.classList.toggle('on', x === b)); });
$('#set-theme').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.theme = b.dataset.v; applySettings(); $$('#set-theme button').forEach(x => x.classList.toggle('on', x === b)); });

/* ================= Tap a word ================= */
$('#r-text').addEventListener('click', e => {
  const nav = e.target.closest('.chapter-nav button');
  if (nav && !nav.disabled) { renderSection(R.sec + (nav.classList.contains('next') ? 1 : -1)); saveProgress(); return; }
  const w = e.target.closest('.w');
  if (w) onWord(w); else hidePop();
});

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
  let out = t.slice(s, e).trim();
  if (out.length > 320) {
    const a = Math.max(0, off - s - 140), b = Math.min(out.length, off - s + len + 140);
    out = (a > 0 ? '… ' : '') + out.slice(a, b).trim() + (b < out.length ? ' …' : '');
  }
  return out;
}

async function onWord(span) {
  lastSpan = span;
  const word = span.textContent, key = word.toLowerCase();
  $$('.w.sel').forEach(n => n.classList.remove('sel')); span.classList.add('sel');
  const token = ++lookupToken, sec = R.sections[R.sec], para = sec.paras[+span.closest('.para').dataset.i];
  const ctx = sentenceAt(para.t, +span.dataset.o, word.length);
  const loc = sec.title + (para.p ? ` · p. ${para.p}` : '');
  showPop(span, `<div class="ph"><span class="pw">${esc(word)}</span><button class="px" aria-label="Close">${ICON_X}</button></div><div class="dots"><i></i><i></i><i></i></div>`);
  try {
    const d = await lookup(word);
    const rec = await saveVocab(key, word, d, ctx, loc);
    $$('#r-text .w').forEach(n => { if (n.textContent.toLowerCase() === key) n.classList.add('k'); });
    $('#r-vcount').textContent = R.vcount; $('#r-vcount').hidden = false;
    if (token === lookupToken) {
      const lemma = d.lemma && d.lemma.toLowerCase() !== key ? d.lemma : '';
      showPop(span, `<div class="ph"><span class="pw">${esc(word)}</span><span class="pc">${rec.count === 1 ? 'Saved' : `Looked up ${rec.count}×`}</span><button class="px" aria-label="Close">${ICON_X}</button></div>
        <div class="pm">${esc(d.meaning)}</div>
        ${lemma ? `<div class="pn">Base form: <b>${esc(lemma)}</b>${d.note ? ` · ${esc(d.note)}` : ''}</div>` : d.note ? `<div class="pn">${esc(d.note)}</div>` : ''}
        ${d.pos ? `<div class="ps">${esc(d.pos)}</div>` : ''}`);
    }
  } catch (err) {
    if (token !== lookupToken) return;
    const off = err.message === 'offline';
    showPop(span, `<div class="ph"><span class="pw">${esc(word)}</span><button class="px" aria-label="Close">${ICON_X}</button></div>
      <div class="pe">${off ? 'Couldn’t reach the dictionary. Check your connection and try again.' : `No meaning found for “${esc(word)}”.`}</div>
      ${off ? '<button class="retry">Try again</button>' : ''}`);
  }
}

/* popup */
function showPop(span, html) {
  const pop = $('#pop'); pop.innerHTML = html; pop.hidden = false;
  const r = span.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  const left = Math.min(Math.max(10, r.left + r.width / 2 - pw / 2), innerWidth - pw - 10);
  let top = r.bottom + 10; if (top + ph > innerHeight - 14) top = Math.max(70, r.top - ph - 10);
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
}
function hidePop() { $('#pop').hidden = true; $$('.w.sel').forEach(n => n.classList.remove('sel')); }
$('#pop').addEventListener('click', e => {
  if (e.target.closest('.px')) hidePop();
  if (e.target.closest('.retry') && lastSpan) onWord(lastSpan);
});

/* ================= Dictionary (Wiktionary first, MyMemory as backup; cached on device) ================= */
const DICT_V = 1;
async function lookup(word) {
  const key = word.toLowerCase();
  const hit = await DB.get('dict', key);
  if (hit && hit.v === DICT_V) return hit;
  const d = await fetchMeaning(word);
  const rec = { ...d, word: key, v: DICT_V };
  DB.put('dict', rec);
  return rec;
}
async function wikt(term) {
  const r = await fetch('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(term));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('http ' + r.status);
  const j = await r.json();
  return Array.isArray(j.es) ? j.es : null;
}
async function myMemory(w) {
  const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(w)}&langpair=es|en`);
  if (!r.ok) throw new Error('http ' + r.status);
  const j = await r.json(), t = (j.responseData?.translatedText || '').trim();
  if (!t || String(j.responseStatus) !== '200' || /MYMEMORY WARNING|INVALID/i.test(t)) return null;
  return t;
}
const clip = (s, n) => s.length > n ? s.slice(0, s.lastIndexOf(' ', n) > 20 ? s.lastIndexOf(' ', n) : n).replace(/[,;:\s]+$/, '') + '…' : s;
function parseEntries(entries) {
  const glosses = [], pos = []; let lemma = '', note = '';
  for (const e of entries) {
    let used = 0;
    for (const def of e.definitions || []) {
      const d = new DOMParser().parseFromString(def.definition || '', 'text/html');
      d.querySelectorAll('ul,ol,dl,.h-usage-example').forEach(n => n.remove());
      const text = d.body.textContent.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const link = d.querySelector('.form-of-definition-link a, .form-of-definition a');
      if (d.querySelector('.form-of-definition') && link) {
        if (!lemma) { lemma = link.textContent.trim(); note = clip(text, 80); }
      } else if (glosses.length < 3 && used < 2) {
        glosses.push(clip(text.replace(/\s*;\s*/g, ' / '), 90)); used++;
        const p = (e.partOfSpeech || '').toLowerCase(); if (p && !pos.includes(p)) pos.push(p);
      }
    }
  }
  return { glosses, pos: pos.slice(0, 2).join(' · '), lemma, note };
}
async function fetchMeaning(word) {
  let entries = null, net = false;
  for (const t of new Set([word.toLowerCase(), word])) {
    try { entries = await wikt(t); if (entries) break; } catch { net = true; break; }
  }
  if (entries) {
    const p = parseEntries(entries);
    if (p.glosses.length) return { meaning: p.glosses.join(' / '), pos: p.pos, lemma: p.lemma, note: p.lemma ? 'Also: ' + p.note : '' };
    if (p.lemma) {
      try {
        const le = await wikt(p.lemma), lp = le && parseEntries(le);
        if (lp?.glosses.length) return { meaning: lp.glosses.join(' / '), pos: lp.pos, lemma: p.lemma, note: p.note };
      } catch { net = true; }
      return { meaning: p.note, pos: '', lemma: p.lemma, note: '' };
    }
  }
  try {
    const mt = await myMemory(word.toLowerCase());
    if (mt) return { meaning: mt, pos: '', lemma: '', note: 'Machine translation' };
  } catch { net = true; }
  throw new Error(net ? 'offline' : 'nomatch');
}

/* ================= Vocabulary ================= */
async function saveVocab(key, word, d, ctx, loc) {
  const id = R.book.id + '|' + key, now = Date.now();
  let rec = await DB.get('vocab', id);
  if (rec) {
    rec.count++; rec.last = now;
    if (!rec.contexts.some(c => c.s === ctx)) { rec.contexts.push({ s: ctx, loc }); if (rec.contexts.length > 6) rec.contexts.splice(1, 1); }
    rec.meaning = d.meaning; rec.pos = d.pos || rec.pos; rec.lemma = rec.lemma || d.lemma || ''; rec.note = d.note || '';
  } else {
    const sentenceInitial = ctx.replace(/^[^\p{L}]+/u, '').startsWith(word);
    rec = { id, bookId: R.book.id, key, word: word === key || sentenceInitial ? key : word, meaning: d.meaning, lemma: d.lemma || '', pos: d.pos || '', note: d.note || '', contexts: [{ s: ctx, loc }], count: 1, first: now, last: now };
    R.vcount++; R.known.add(key);
  }
  await DB.put('vocab', rec);
  return rec;
}

let vFilter = 'all', vSort = 'recent', vQuery = '';
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function markWord(ctx, key) {
  const re = new RegExp(`(^|[^\\p{L}\\p{M}])(${reEsc(key)})(?![\\p{L}\\p{M}])`, 'giu');
  let out = '', last = 0;
  for (const m of ctx.matchAll(re)) {
    const s = m.index + m[1].length;
    out += esc(ctx.slice(last, s)) + `<mark>${esc(m[2])}</mark>`; last = s + m[2].length;
  }
  return out + esc(ctx.slice(last));
}
async function renderVocab() {
  books = (await DB.all('books')).sort((a, b) => (b.lastOpened || b.added) - (a.lastOpened || a.added));
  const all = await DB.all('vocab');
  const per = new Map(); all.forEach(v => per.set(v.bookId, (per.get(v.bookId) || 0) + 1));
  if (vFilter !== 'all' && !per.has(vFilter)) vFilter = 'all';
  const titleOf = id => books.find(b => b.id === id)?.title || 'Removed book';
  $('#vocab-summary').textContent = all.length ? `${all.length} word${all.length === 1 ? '' : 's'} from ${per.size} book${per.size === 1 ? '' : 's'}` : '';
  $('#vocab-books').innerHTML = [`<button class="chip ${vFilter === 'all' ? 'on' : ''}" data-f="all">All (${all.length})</button>`,
    ...books.filter(b => per.has(b.id)).map(b => `<button class="chip ${vFilter === b.id ? 'on' : ''}" data-f="${b.id}">${esc(b.title)} (${per.get(b.id)})</button>`)].join('');
  $('#vocab-sort').value = vSort;
  const q = vQuery.trim().toLowerCase();
  let list = all.filter(v => (vFilter === 'all' || v.bookId === vFilter) && (!q || [v.key, v.lemma, v.meaning].some(x => (x || '').toLowerCase().includes(q))));
  list.sort(vSort === 'az' ? (a, b) => a.key.localeCompare(b.key, 'es') : vSort === 'count' ? (a, b) => b.count - a.count || b.last - a.last : (a, b) => b.last - a.last);
  const box = $('#vocab-list');
  if (!all.length) { box.innerHTML = `<div class="empty"><h3>No words yet</h3><p>Tap any word while you read and it lands here, with the sentence you found it in.</p></div>`; return; }
  if (!list.length) { box.innerHTML = `<div class="empty"><p>No words match your search.</p></div>`; return; }
  box.innerHTML = list.map(v => {
    const [first, ...more] = v.contexts;
    const ctxHtml = c => `<p class="ctx">${markWord(c.s, v.key)}<span class="loc">${esc(c.loc || '')}</span></p>`;
    return `<article class="vcard">
      <div class="top"><span class="w1">${esc(v.word)}</span>${v.lemma && v.lemma.toLowerCase() !== v.key ? `<span class="lem">base: ${esc(v.lemma)}</span>` : ''}<span class="cnt">${v.count}×</span></div>
      <div class="mean">${esc(v.meaning)}</div>
      ${first ? ctxHtml(first) : ''}
      ${more.length ? `<details><summary>${more.length} more sentence${more.length === 1 ? '' : 's'}</summary>${more.map(ctxHtml).join('')}</details>` : ''}
      <div class="foot"><span>${vFilter === 'all' ? esc(titleOf(v.bookId)) + ' · ' : ''}${new Date(v.last).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span><button class="del" data-del="${esc(v.id)}">Remove</button></div>
    </article>`;
  }).join('');
}
$('#vocab-books').addEventListener('click', e => { const c = e.target.closest('.chip'); if (c) { vFilter = c.dataset.f; renderVocab(); } });
$('#vocab-search').addEventListener('input', e => { vQuery = e.target.value; renderVocab(); });
$('#vocab-sort').addEventListener('change', e => { vSort = e.target.value; renderVocab(); });
$('#vocab-list').addEventListener('click', async e => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  if (await ask('Remove this word?', 'It will be deleted from the vocabulary list.')) { await DB.del('vocab', b.dataset.del); renderVocab(); }
});

/* ================= Install + offline ================= */
let deferred = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#btn-install').hidden = false; });
$('#btn-install').addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#btn-install').hidden = true; });
addEventListener('appinstalled', () => { $('#btn-install').hidden = true; });
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => { }));

applySettings();
show('library');
renderShelf();
