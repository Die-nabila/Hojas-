/* lex-en.js — ENGLISH books: word → base form → French translation + English definitions, and English → French sentences.
   This module is completely separate from the Spanish one (lex.js): its own cache keys ("en:…"), its own rules, nothing shared at run time.
   No API keys.

   Words      English Wiktionary (REST "definition" endpoint, English entries): base form (lemma), part of speech, the grammar of the tapped
              form ("simple past tense and past participle of walk"), English definitions and usage examples.
              The French translation of the base form comes from Lingva, then MyMemory. Verbs are translated as "to walk" and nouns as
              "the house", so you get the right part of speech (marcher, la maison).
   Sentences  Lingva first, MyMemory if it fails (en → fr). */

let cache = { get: async () => null, put: async () => { } };
export const initLex = c => { cache = c; };
const V = 1;
const SENTENCE_PROVIDERS = ['lingva', 'mymemory'];   // 'lingva' | 'mymemory' — change the order or drop one here
const MYMEMORY_EMAIL = '';                            // optional: raises MyMemory's free daily limit (not a secret key)

const clip = (s, n) => s.length > n ? s.slice(0, s.lastIndexOf(' ', n) > 20 ? s.lastIndexOf(' ', n) : n).replace(/[,;:\s]+$/, '') + '…' : s;
export const plain = g => {
  let s = (g || '').replace(/\s+/g, ' ').trim();
  const t = s.replace(/^(\([^)]*\)\s*)+/, '').trim();
  if (t.length >= 3) s = t;
  return s.replace(/\.$/, '').trim();
};
const norm = w => w.toLowerCase().replace(/[’‘]/g, "'");
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ============ Cache: memory first, then IndexedDB (own "en:" keys) ============ */
const mem = new Map();
const memGet = k => { const v = mem.get(k); if (v !== undefined) { mem.delete(k); mem.set(k, v); } return v; };
const memSet = (k, v) => { mem.delete(k); mem.set(k, v); if (mem.size > 600) mem.delete(mem.keys().next().value); };
async function cget(k) {
  const m = memGet(k); if (m !== undefined) return m;
  const r = await cache.get(k);
  if (r && r.v === V && r.data !== undefined) { memSet(k, r.data); return r.data; }
  return undefined;
}
function cput(k, data) { memSet(k, data); cache.put({ word: k, v: V, data }); }
export const peek = word => memGet('en:an:' + norm(word));

/* ============ Network (every failure says what really went wrong) ============ */
const fail = (kind, detail) => Object.assign(new Error(kind), { kind, detail });
async function http(name, url, ms = 8000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok && r.status !== 404) throw fail('http', `${name}: server error (HTTP ${r.status})`);
    return r;
  } catch (e) {
    if (e.kind) throw e;
    if (e.name === 'AbortError') throw fail('timeout', `${name}: no answer after ${ms / 1000} s`);
    throw fail('network', `${name}: could not connect (offline, blocked, or the service is down)`);
  } finally { clearTimeout(t); }
}

/* ============ English Wiktionary ============ */
const normPos = p => {
  p = (p || '').toLowerCase();
  if (p.includes('proper')) return 'proper noun';
  if (p.includes('verb') && !p.includes('participle')) return 'verb';
  if (p.includes('participle')) return 'participle';
  if (p.includes('noun')) return 'noun';
  if (p.includes('adject')) return 'adjective';
  if (p.includes('adverb')) return 'adverb';
  if (p.includes('prepos')) return 'preposition';
  if (p.includes('conjunc')) return 'conjunction';
  if (p.includes('pronoun')) return 'pronoun';
  if (p.includes('determiner') || p.includes('article')) return 'determiner';
  if (p.includes('interj')) return 'interjection';
  return p || 'other';
};
const FLAG_RX = [['third-person', '3'], ['first-person', '1'], ['second-person', '2'], ['singular', 'sg'], ['plural', 'pl'],
['simple past', 'pret'], ['past tense', 'pret'], ['past participle', 'ptcp'], ['present participle', 'ger'], ['gerund', 'ger'],
['simple present', 'pres'], ['present', 'pres'], ['comparative', 'cmp'], ['superlative', 'sup'], ['indicative', 'ind'], ['subjunctive', 'subj'],
['possessive', 'poss'], ['diminutive', 'dim'], ['alternative', 'alt']];
const flagsOf = t => {                                // longer phrases first, and each match is used up ("present participle" must not also count as "present")
  t = t.toLowerCase(); const out = new Set();
  for (const [k, v] of [...FLAG_RX].sort((a, b) => b[0].length - a[0].length)) if (t.includes(k)) { out.add(v); t = t.split(k).join(' '); }
  return [...out];
};
const tpl = document.createElement('template');     // inert: nothing in the dictionary HTML can load or run
const frag = h => { tpl.innerHTML = h || ''; return tpl.content; };
const textOf = h => (frag(h).textContent || '').replace(/\s+/g, ' ').trim();

function describeForm(full, lemma) {                  // "simple past tense and past participle of walk" → "simple past tense and past participle"
  let desc = full.replace(new RegExp('\\s*(?:form\\s+)?of\\s+' + escRe(lemma) + '.*$', 'i'), '').replace(/\s+form$/i, '').trim();
  const after = full.includes(':') ? full.slice(full.indexOf(':') + 1).trim() : '';
  if (/^inflection\b/i.test(desc)) desc = after;
  return clip(desc.replace(/^(the\s+)/i, ''), 70);
}
function parseDef(def) {
  const d = frag(def.definition);
  const full = (d.textContent || '').replace(/\s+/g, ' ').trim();
  if (!full) return null;
  if (d.querySelector('.form-of-definition')) {
    const a = d.querySelector('.form-of-definition-link a') || d.querySelector('[lang="en"] a');
    const lemma = a && (a.textContent || '').trim();
    if (lemma) { const desc = describeForm(full, lemma); return { form: 1, lemma, desc, flags: flagsOf(desc || full.split(lemma).join(' ')) }; }
  }
  d.querySelectorAll('ul,ol,dl,.h-usage-example').forEach(n => n.remove());
  const g = (d.textContent || '').replace(/\s+/g, ' ').trim();
  if (!g) return null;
  const ex = (def.parsedExamples || def.examples || []).slice(0, 3).map(x => textOf(typeof x === 'string' ? x : x.example)).join(' ').toLowerCase().slice(0, 300);
  return { g: g.replace(/\s*;\s*/g, ' / '), ex };
}
const parsePage = entries => entries
  .map(e => ({ pos: normPos(e.partOfSpeech), defs: (e.definitions || []).slice(0, 16).map(parseDef).filter(Boolean) }))
  .filter(e => e.defs.length);

async function wikt(term) {                           // → parsed English entries, or null when the page has none
  const ck = 'en:wk:' + term, c = await cget(ck);
  if (c !== undefined) return c;
  const r = await http('Wiktionary', 'https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(term));
  let data = null;
  if (r.status !== 404) { const j = await r.json(); data = Array.isArray(j.en) ? parsePage(j.en) : null; if (data && !data.length) data = null; }   // a page without usable English entries counts as "no page"
  cput(ck, data);
  return data;
}

function readingsFromPage(page, term) {
  const forms = new Map(), own = []; let o = 0;
  for (const e of page) {
    const ownDefs = e.defs.filter(d => !d.form);
    if (ownDefs.length) own.push({ lemma: term, pos: e.pos, flags: [], desc: '', senses: ownDefs.slice(0, 6).map(d => ({ g: d.g, ex: d.ex })), o: o++ });
    for (const d of e.defs.filter(x => x.form)) {
      const k = d.lemma.toLowerCase() + '|' + e.pos;
      const r = forms.get(k) || { lemma: d.lemma, pos: e.pos, flags: [], desc: '', senses: null, o: o++ };
      r.flags = [...new Set([...r.flags, ...d.flags])]; if (!r.desc) r.desc = d.desc; forms.set(k, r);
    }
  }
  return [...forms.values(), ...own];
}
async function sensesFor(lemma, pos, depth = 0) {     // English definitions of the base form (follows "past tense of X" chains)
  const low = norm(lemma);
  let page = await wikt(low);
  if (!page && lemma !== low) page = await wikt(lemma);
  if (!page) return { lemma, senses: [] };
  const pick = page.filter(e => e.pos === pos).concat(page.filter(e => e.pos !== pos));
  for (const e of pick) {
    const own = e.defs.filter(d => !d.form);
    if (own.length) return { lemma, senses: own.slice(0, 6).map(d => ({ g: d.g, ex: d.ex })) };
  }
  if (depth < 2) {
    for (const e of pick) {
      const f = e.defs.find(d => d.form && norm(d.lemma) !== low);
      if (f) return sensesFor(f.lemma, e.pos === 'participle' ? 'verb' : e.pos, depth + 1);
    }
  }
  return { lemma, senses: [] };
}

/* ============ English → French (Lingva, then MyMemory) ============ */
async function myMemory(q) {
  const r = await http('MyMemory', `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=en|fr${MYMEMORY_EMAIL ? '&de=' + encodeURIComponent(MYMEMORY_EMAIL) : ''}`);
  const j = await r.json(), t = textOf(j.responseData?.translatedText || '');
  if (String(j.responseStatus) === '429' || /MYMEMORY WARNING/i.test(t)) throw fail('http', 'MyMemory: today’s free limit has been used up');
  if (!t || String(j.responseStatus) !== '200' || /INVALID|PLEASE SELECT/i.test(t)) throw fail('nomatch', 'MyMemory: no translation returned');
  return t;
}
const PROVIDERS = {
  async lingva(text) {
    const r = await http('Lingva', `https://lingva.ml/api/v1/en/fr/${encodeURIComponent(text)}`, 6000);
    const j = await r.json().catch(() => ({}));
    if (r.status === 404 || !j.translation) throw fail('nomatch', 'Lingva: no translation returned');
    return String(j.translation).trim();
  },
  mymemory: myMemory
};
async function toFrench(text) {                       // sequential providers, each with its own clear error
  const problems = [];
  for (const name of SENTENCE_PROVIDERS) {
    try { return await PROVIDERS[name](text); } catch (e) { problems.push(e); }
  }
  const net = e => e.kind === 'network' || e.kind === 'timeout';
  const kind = problems.every(e => e.kind === 'nomatch') ? 'nomatch' : problems.every(net) ? 'network' : 'http';
  throw fail(kind, problems.map(e => e.detail || e.message).join(' · '));
}
async function frenchOf(lemma, pos) {                 // "to walk" → marcher · "the house" → la maison · others as they are
  const ck = 'en:tr:' + pos + ':' + norm(lemma), c = await cget(ck);
  if (c !== undefined) return c;
  const q = pos === 'verb' ? 'to ' + lemma : pos === 'noun' ? 'the ' + lemma : lemma;
  let fr = (await toFrench(q)).replace(/\.$/, '').trim();
  if (pos === 'verb') fr = fr.replace(/^(pour|à|de)\s+/i, '');
  if (!/^\p{Lu}/u.test(lemma)) fr = fr.charAt(0).toLowerCase() + fr.slice(1);
  cput(ck, fr);
  return fr;
}

/* ============ The word lookup ============
   cache → Wiktionary page of the tapped word (grammar + base form: hooks.onSkeleton) → definitions + French of the best reading
   (hooks.onTop) → the other readings → cache. A base form is never shown without its definitions and its French translation. */
const termsFor = word => {
  const low = norm(word), out = [low];
  if (word !== low && !out.includes(word)) out.push(word);
  if (/'s$/.test(low)) out.push(low.slice(0, -2));
  return out;
};
export async function lookup(word, ctx, hooks = {}) {
  const low = norm(word), ck = 'en:an:' + low, stale = hooks.stale || (() => false);
  const hit = await cget(ck); if (hit) return hit;

  let page = null, term = low;
  for (const t of termsFor(word)) { page = await wikt(t); if (page) { term = t; break; } }
  if (stale()) return null;

  let readings = page ? readingsFromPage(page, term) : [];
  if (!readings.length) {                              // no dictionary page: French only
    const fr = (await toFrench(low)).replace(/\.$/, '').trim();
    readings = [{ lemma: '', pos: '', flags: [], desc: '', senses: [], fr, mt: 1, o: 99 }];
    cput(ck, readings); hooks.onTop && hooks.onTop(readings); return readings;
  }

  hooks.onSkeleton && hooks.onSkeleton(readings);
  const ranked = rank(readings, ctx);
  const complete = async r => {
    const [s, fr] = await Promise.all([r.senses ? { lemma: r.lemma, senses: r.senses } : sensesFor(r.lemma, r.pos), frenchOf(r.lemma, r.pos)]);
    r.senses = s.senses; r.fr = fr;
    if (norm(s.lemma) !== norm(r.lemma)) { r.via = r.lemma; r.lemma = s.lemma; }
  };
  await complete(ranked[0].r);                         // a failure here propagates: the popup shows the real reason
  if (stale() && !hooks.keep) return readings;
  hooks.onTop && hooks.onTop(readings);

  let others = true;
  await Promise.all(ranked.slice(1, 4).map(x => complete(x.r).catch(() => { others = false; })));
  readings.forEach(r => { r.senses ||= []; });
  if (others) cput(ck, readings);
  return readings;
}

/* ============ Context-aware ranking (English words) ============ */
const S = s => new Set(s.split(' '));
const DET = S('the a an this that these those my your his her its our their some any no every each much many few several both either neither another other such what which whose');
const PREP = S('in on at by for with from of about into over under between through during before after above below against among within without upon toward towards across behind beyond');
const HAVE = S('has have had having');
const BE = S('is are was were be been being am');
const MODAL = S("will would can could shall should may might must do does did don't doesn't didn't can't won't cannot");
const SUBJ = S("i you he she it we they who there i'm you're he's she's it's we're they're i'd i'll");
const TO = S('to');
const TENSE_FLAGS = ['pres', 'pret', 'ind', 'subj'];
const isFinite_ = r => r.pos === 'verb' && r.flags.some(f => TENSE_FLAGS.includes(f));
const isPtcp = r => r.pos === 'participle' || r.flags.includes('ptcp');

export function rank(readings, ctx) {
  const p1 = norm(ctx.prev[0] || ''), n1 = norm(ctx.next[0] || '');
  return readings.map((r, i) => {
    const fin = isFinite_(r), pt = isPtcp(r), ger = r.flags.includes('ger'), adj = r.pos === 'adjective', noun = r.pos === 'noun' || r.pos === 'proper noun';
    const inf = r.pos === 'verb' && !fin && !pt && !ger, fn = ['preposition', 'conjunction', 'determiner', 'pronoun'].includes(r.pos);
    let s = -(r.o ?? i) * 0.12;
    if (!r.flags.length && !r.desc && norm(r.lemma) === ctx.word) s += 0.4;
    if (DET.has(p1)) { if (noun) s += 3; if (adj) s += 1; if (fin) s -= 3; if (inf) s -= 2; if (pt || ger) s -= 0.3; if (fn) s -= 2; }
    if (HAVE.has(p1)) { if (pt) s += 4; if (fin) s -= 2; if (noun) s -= 2; }
    if (BE.has(p1)) { if (ger) s += 3; if (pt || adj) s += 2.5; if (noun) s -= 0.5; if (fin) s -= 1; }
    if (MODAL.has(p1) || TO.has(p1)) { if (inf) s += 3; if (fin) s -= 1; if (noun) s -= 1; if (adj) s -= 1; }
    if (SUBJ.has(p1)) { if (fin) s += 2.5; if (noun) s -= 1; if (inf) s += 0.5; }
    if (PREP.has(p1)) { if (noun) s += 2; if (ger) s += 1.5; if (fin) s -= 2.5; if (adj) s -= 0.5; }
    if (p1 && ![DET, PREP, HAVE, BE, MODAL, SUBJ, TO].some(set => set.has(p1))) { if (adj || pt) s += 0.6; if (fin) s += 0.5; }
    if (DET.has(n1) && (fin || inf)) s += 1;
    if (ctx.capMid && noun) s += 1.5;
    return { r, s };
  }).sort((a, b) => b.s - a.s);
}

export function orderSenses(r, ctx) {
  const words = new Set(((ctx.sentence || '').toLowerCase().match(/[\p{L}]{4,}/gu)) || []);
  words.delete(ctx.word);
  return (r.senses || []).map((s, i) => {
    const g = (s.g || '').toLowerCase();
    let sc = -i * 0.2;
    if (/\b(obsolete|archaic|dated|rare|dialectal|slang|vulgar|colloquial|nonstandard|derogatory)\b/.test(g.slice(0, 40))) sc -= 1.2;
    let ov = 0; if (s.ex) for (const w of words) if (s.ex.includes(w)) ov++;
    return { s, sc: sc + Math.min(ov, 3) * 0.8 };
  }).sort((a, b) => b.sc - a.sc).map(x => x.s);
}

/* what the popup / vocabulary needs for one chosen reading */
export function describe(r, ctx) {
  const defs = [];
  for (const s of orderSenses(r, ctx)) { const g = clip(plain(s.g), 90); if (g && !defs.includes(g)) defs.push(g); if (defs.length >= 2) break; }
  const lemma = r.lemma || '';
  return {
    lemma, pos: r.pos, via: r.via || '', verbish: false, gram: r.desc || '',
    isForm: !!lemma && (r.flags.length > 0 || !!r.desc || norm(lemma) !== ctx.word),
    meaning: r.fr || '', defs, formMeaning: '', mt: !!r.mt
  };
}

/* ============ Sentence / phrase translation (en → fr) ============ */
export async function translatePhrase(text) {
  const ck = 'en:ph:' + text.toLowerCase().replace(/\s+/g, ' ').trim(), hit = await cget(ck);
  if (hit) return hit;
  const out = (await toFrench(text)).trim();
  cput(ck, out);
  return out;
}
