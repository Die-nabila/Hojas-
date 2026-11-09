/* review.js — flashcards from the vocabulary, with simple spaced repetition (Leitner boxes). */
let A;
export const initReview = api => { A = api; };

const DAY = 864e5, INTERVALS = [0, 1, 3, 7, 14, 30, 60];
const chapterOf = c => c.sec ?? (c.loc || '').split(' · p.')[0];
const cfg = { book: 'all', chap: 'all', mode: 'smart', n: 20 };
let deck = [], pos = 0, flipped = false, stats = null;

const MODES = [
  ['smart', 'Smart mix', 'New and due words, hardest first'],
  ['unlearned', 'Not learned', 'Everything you haven’t marked as learned'],
  ['difficult', 'Difficult', 'Words you miss or keep looking up'],
  ['stale', 'Not seen lately', 'Not reviewed in the last 3 days, learned words included'],
  ['all', 'Everything', 'Every word and phrase, learned ones too']
];
const isDifficult = g => !g.learned && ((g.wrong > 0 && g.wrong >= g.right) || (g.count >= 3 && g.right === 0));
const FILTERS = {
  smart: (g, now) => !g.learned && (g.seen === 0 || g.due <= now),
  unlearned: g => !g.learned,
  difficult: isDifficult,
  stale: (g, now) => now - g.last > 3 * DAY,
  all: () => true
};

function makeGroup(ents) {
  const main = [...ents].sort((a, b) => b.count - a.count)[0], forms = new Map();
  for (const e of ents) for (const f of e.forms || []) {
    const k = f.form.toLowerCase(), x = forms.get(k) || { ...f, n: 0 };
    x.n += f.n; if (!x.fm) x.fm = f.fm; forms.set(k, x);
  }
  const s = ents.map(e => e.srs).filter(Boolean), seen = s.reduce((a, x) => a + x.seen, 0);
  return {
    ents, kind: main.kind, key: main.key, lemma: main.lemma, pos: main.pos, meaning: main.meaning,
    forms: [...forms.values()], contexts: ents.flatMap(e => e.contexts || []), count: ents.reduce((a, e) => a + e.count, 0),
    learned: ents.every(e => e.learned), seen, right: s.reduce((a, x) => a + x.right, 0), wrong: s.reduce((a, x) => a + x.wrong, 0),
    last: s.reduce((a, x) => Math.max(a, x.last), 0), due: seen ? Math.min(...s.map(x => x.due)) : 0
  };
}
async function allGroups() {
  const ids = new Set(A.books().map(b => b.id)), map = new Map();
  for (const e of await A.DB.all('vocab')) {
    if (e.v !== 2 || !ids.has(e.bookId) || (cfg.book !== 'all' && e.bookId !== cfg.book)) continue;
    const k = e.kind + '|' + e.key; (map.get(k) || map.set(k, []).get(k)).push(e);
  }
  return [...map.values()].map(makeGroup);
}
const inChapter = g => cfg.chap === 'all' || g.contexts.some(c => chapterOf(c) === cfg.chap);
const priority = (g, now) => (g.seen === 0 ? 3 : 0) + Math.min(30, Math.max(0, (now - g.due) / DAY)) * 0.3 + g.wrong * 1.5 - g.right * 0.4 + Math.min(g.count, 6) * 0.4 + (g.learned ? -4 : 0) + Math.random() * 0.8;

/* ---------- Home: build a deck ---------- */
export async function renderReview() {
  const $ = A.$, esc = A.esc, now = Date.now();
  $('#rv-run').hidden = true; $('#rv-home').hidden = false;
  const books = A.books();
  if (cfg.book !== 'all' && !books.some(b => b.id === cfg.book)) { cfg.book = 'all'; cfg.chap = 'all'; }
  const groups = await allGroups();
  const scoped = groups.filter(inChapter);

  let chapters = [];
  if (cfg.book !== 'all') {
    const content = await A.DB.get('content', cfg.book);
    const have = new Set(groups.flatMap(g => g.contexts.map(chapterOf)));
    chapters = (content?.sections || []).map(s => s.title).filter((t, i, a) => have.has(t) && a.indexOf(t) === i);
    have.forEach(t => { if (!chapters.includes(t)) chapters.push(t); });
    if (cfg.chap !== 'all' && !chapters.includes(cfg.chap)) cfg.chap = 'all';
  }
  const counts = Object.fromEntries(MODES.map(([k]) => [k, scoped.filter(g => FILTERS[k](g, now)).length]));
  const total = scoped.length, learned = scoped.filter(g => g.learned).length;
  $('#rv-sub').textContent = groups.length ? `${groups.length} cards from your vocabulary` : '';

  if (!groups.length) {
    $('#rv-home').innerHTML = `<div class="empty"><h3>Nothing to review yet</h3><p>Tap words while you read. Every word you look up becomes a flashcard here.</p></div>`;
    return;
  }
  const ready = Math.min(counts[cfg.mode], cfg.n === 0 ? Infinity : cfg.n);
  $('#rv-home').innerHTML = `
    <div class="rv-panel">
      <label class="rv-field"><span>From</span>
        <select id="rv-book"><option value="all">All books</option>${books.map(b => `<option value="${b.id}" ${cfg.book === b.id ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}</select></label>
      <label class="rv-field"><span>Chapter</span>
        <select id="rv-chap" ${cfg.book === 'all' ? 'disabled' : ''}><option value="all">All chapters</option>${chapters.map(c => `<option value="${esc(c)}" ${cfg.chap === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <div class="rv-modes" id="rv-modes">${MODES.map(([k, name]) => `<button data-m="${k}" class="${cfg.mode === k ? 'on' : ''}">${name}<em>${counts[k]}</em></button>`).join('')}</div>
      <p class="rv-hint">${MODES.find(m => m[0] === cfg.mode)[2]}</p>
      <label class="rv-field"><span>Cards</span>
        <select id="rv-n">${[10, 20, 50, 0].map(n => `<option value="${n}" ${cfg.n === n ? 'selected' : ''}>${n === 0 ? 'All' : n}</option>`).join('')}</select></label>
      <button id="rv-start" class="btn-primary" ${ready ? '' : 'disabled'}>${ready ? `Start · ${ready} card${ready === 1 ? '' : 's'}` : 'No cards match'}</button>
    </div>
    <p class="rv-foot">${total} in this selection · ${learned} learned</p>`;
}

/* ---------- Session ---------- */
async function start(list) {
  deck = list; pos = 0; flipped = false; stats = { right: 0, wrong: 0, missed: [] };
  deck.forEach(g => { // which form to ask about this time
    const f = g.forms; g._form = f.length ? f[Math.floor(Math.random() * f.length)] : null;
  });
  A.$('#rv-home').hidden = true; A.$('#rv-run').hidden = false;
  card();
}
function faces(g) {
  const { esc, mark } = A, form = g._form, name = form ? form.form : g.lemma;
  const ctx = g.contexts.find(c => form && c.form && c.form.toLowerCase() === form.form.toLowerCase()) || g.contexts[0];
  const sentence = ctx ? `<p class="fc-ctx">${mark(ctx.s, name)}<span class="loc">${esc(ctx.loc || '')}</span></p>` : '';
  if (g.kind === 'phrase') return {
    front: `<p class="fc-q">What does this mean?</p><p class="fc-big phrase">${esc(g.lemma)}</p>`,
    back: `<p class="fc-q phrase">${esc(g.lemma)}</p><p class="fc-ans">${esc(g.meaning)}</p>${sentence}`
  };
  const others = g.forms.filter(f => f !== form).map(f => esc(f.form)).slice(0, 6);
  const alsoMet = others.length ? `<p class="fc-also">Also met as: ${others.join(', ')}</p>` : '';
  if (g.lemma.toLowerCase() !== name.toLowerCase()) return {
    front: `<p class="fc-q">What does <b>${esc(name)}</b> come from and mean?</p>${sentence}`,
    back: `<p class="fc-ans"><b>${esc(g.lemma)}</b> — ${esc(g.meaning)}</p>${form && form.fm ? `<p class="fc-fm"><b>${esc(name)}</b> = ${esc(form.fm)}</p>` : ''}${alsoMet}`
  };
  return {
    front: `<p class="fc-q">¿Qué significa <b>${esc(name)}</b>?</p>${sentence}`,
    back: `<p class="fc-ans">${esc(g.meaning)}</p>${alsoMet}`
  };
}
function card() {
  const g = deck[pos], f = faces(g), run = A.$('#rv-run');
  run.innerHTML = `
    <div class="rv-top"><button class="icon-btn rv-x" aria-label="End review"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <div class="rv-prog"><i style="width:${100 * pos / deck.length}%"></i></div><span>${pos + 1} / ${deck.length}</span></div>
    <button class="fc ${flipped ? 'back' : 'front'}" id="fc" ${flipped ? 'disabled' : ''}>${flipped ? f.back : f.front}${flipped ? '' : '<span class="fc-tip">Tap to reveal</span>'}</button>
    ${flipped ? `<div class="rv-act"><button class="rv-no">Didn’t know</button><button class="rv-yes">Knew it</button></div>
      <button class="rv-learn ${g.learned ? 'on' : ''}">${g.learned ? '✓ Learned — tap to undo' : 'Mark as learned'}</button>` : ''}`;
}
async function rate(ok) {
  const g = deck[pos], now = Date.now();
  for (const e of g.ents) {
    const s = e.srs ||= { box: 0, due: 0, seen: 0, right: 0, wrong: 0, last: 0 };
    s.seen++; s.last = now;
    if (ok) { s.right++; s.box = Math.min(s.box + 1, 6); } else { s.wrong++; s.box = 0; }
    s.due = now + (ok ? INTERVALS[s.box] * DAY : 10 * 60 * 1000);
    await A.DB.put('vocab', e);
  }
  if (ok) stats.right++; else { stats.wrong++; stats.missed.push(g); }
  pos++; flipped = false;
  pos < deck.length ? card() : done();
}
async function toggleLearned() {
  const g = deck[pos], now = Date.now(), on = !g.learned;
  for (const e of g.ents) {
    e.learned = on;
    const s = e.srs ||= { box: 0, due: 0, seen: 0, right: 0, wrong: 0, last: 0 };
    if (on) { s.box = Math.max(s.box, 4); s.due = now + 30 * DAY; } else { s.due = now; }
    await A.DB.put('vocab', e);
  }
  g.learned = on; card();
}
function done() {
  const total = stats.right + stats.wrong, miss = stats.missed.length;
  A.$('#rv-run').innerHTML = `
    <div class="rv-done"><div class="rv-badge">${stats.right}<small>/ ${total}</small></div>
      <h3>${miss ? 'Good session' : 'Perfect round'}</h3>
      <p>${stats.right} knew it${miss ? ` · ${miss} to see again soon` : ''}</p>
      ${miss ? `<button class="btn-primary rv-again">Review missed (${miss})</button>` : ''}
      <button class="pill ghost rv-back">Back to Review</button></div>`;
}

export function bindReview() {
  const root = A.$('#view-review');
  root.addEventListener('change', e => {
    if (e.target.id === 'rv-book') { cfg.book = e.target.value; cfg.chap = 'all'; renderReview(); }
    if (e.target.id === 'rv-chap') { cfg.chap = e.target.value; renderReview(); }
    if (e.target.id === 'rv-n') { cfg.n = +e.target.value; renderReview(); }
  });
  root.addEventListener('click', async e => {
    const t = e.target;
    const m = t.closest('[data-m]'); if (m) { cfg.mode = m.dataset.m; return renderReview(); }
    if (t.closest('#rv-start')) {
      const now = Date.now(), pool = (await allGroups()).filter(inChapter).filter(g => FILTERS[cfg.mode](g, now));
      pool.forEach(g => { g._p = cfg.mode === 'stale' ? -g.last + Math.random() : priority(g, now); });
      pool.sort((a, b) => b._p - a._p);
      return start(cfg.n ? pool.slice(0, cfg.n) : pool);
    }
    if (t.closest('#fc') && !flipped) { flipped = true; return card(); }
    if (t.closest('.rv-yes')) return rate(true);
    if (t.closest('.rv-no')) return rate(false);
    if (t.closest('.rv-learn')) return toggleLearned();
    if (t.closest('.rv-x') || t.closest('.rv-back')) return renderReview();
    if (t.closest('.rv-again')) { const list = stats.missed; return start(list); }
  });
}
