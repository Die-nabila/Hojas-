/* lex.js — word → base form → meaning, and sentence translation. Online only; no API keys.

   Words      English Wiktionary (REST "definition" endpoint, Spanish entries): base form (lemma), part of speech,
              grammar of the tapped form, English senses, usage examples. MyMemory is used only for a word Wiktionary doesn't have.
   Sentences  Lingva (open-source Google Translate front-end) first, MyMemory if Lingva fails.
   Cache      every result is kept in memory and in IndexedDB so repeating a word is instant (the app still needs a connection for new words). */

let cache = { get: async () => null, put: async () => { } };
export const initLex = c => { cache = c; };
const V = 2;

/* If you ever want a different order or a single provider for sentences, change this list: 'lingva' | 'mymemory' */
const SENTENCE_PROVIDERS = ['lingva', 'mymemory'];
/* Optional: MyMemory allows ~10x more free translations per day when you pass an email address (it is not a secret key). */
const MYMEMORY_EMAIL = '';

const clip = (s, n) => s.length > n ? s.slice(0, s.lastIndexOf(' ', n) > 20 ? s.lastIndexOf(' ', n) : n).replace(/[,;:\s]+$/, '') + '…' : s;
export const plain = g => {
  let s = (g || '').replace(/\s+/g, ' ').trim();
  const t = s.replace(/^(\([^)]*\)\s*)+/, '').trim();
  if (t.length >= 3) s = t;
  return s.replace(/\.$/, '').trim();
};

/* ============ Cache: memory first, then IndexedDB ============ */
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
export const peek = word => memGet('an:' + word.toLowerCase());   // synchronous: a word already looked up this session

/* ============ Network ============
   Every failure says what actually went wrong, so an error message can be trusted:
   network  = the browser could not connect (no internet, DNS, blocked host, or the server answered without CORS headers)
   timeout  = no answer in time        http = the server answered with an error status */
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

/* ============ Wiktionary ============ */
const normPos = p => {
  p = (p || '').toLowerCase();
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
const FLAG_RX = [['first-person', '1'], ['second-person', '2'], ['third-person', '3'], ['singular', 'sg'], ['plural', 'pl'], ['masculine', 'm'], ['feminine', 'f'],
['present', 'pres'], ['preterite', 'pret'], ['imperfect', 'impf'], ['future', 'fut'], ['conditional', 'cond'], ['subjunctive', 'subj'], ['indicative', 'ind'],
['imperative', 'impv'], ['gerund', 'ger'], ['past participle', 'ptcp'], ['infinitive', 'inf'], ['diminutive', 'dim'], ['augmentative', 'aug'], ['superlative', 'sup']];
const flagsOf = t => { t = t.toLowerCase(); return FLAG_RX.filter(([k]) => t.includes(k)).map(([, v]) => v); };
const tpl = document.createElement('template'); // inert: nothing in the dictionary HTML can load or run
const frag = h => { tpl.innerHTML = h || ''; return tpl.content; };
const textOf = h => (frag(h).textContent || '').replace(/\s+/g, ' ').trim();

function parseDef(def) {
  const d = frag(def.definition);
  const full = (d.textContent || '').replace(/\s+/g, ' ').trim();
  if (!full) return null;
  if (d.querySelector('.form-of-definition')) {          // "plural of X", "imperfect indicative of X" → remember X and the grammar
    const a = d.querySelector('.form-of-definition-link a') || d.querySelector('[lang="es"] a');
    const lemma = a && (a.textContent || '').trim();
    if (lemma) return { form: 1, lemma, flags: flagsOf(full.split(lemma).join(' ')), text: clip(full, 120) };
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

async function wikt(term) {                                // → parsed Spanish entries, or null when the page doesn't exist
  const ck = 'wk:' + term, c = await cget(ck);
  if (c !== undefined) return c;
  const r = await http('Wiktionary', 'https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(term));
  let data = null;
  if (r.status !== 404) { const j = await r.json(); data = Array.isArray(j.es) ? parsePage(j.es) : null; }
  cput(ck, data);
  return data;
}

async function myMemory(q) {
  const r = await http('MyMemory', `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=es|en${MYMEMORY_EMAIL ? '&de=' + encodeURIComponent(MYMEMORY_EMAIL) : ''}`);
  const j = await r.json(), t = textOf(j.responseData?.translatedText || '');
  if (String(j.responseStatus) === '429' || /MYMEMORY WARNING/i.test(t)) throw fail('http', 'MyMemory: today’s free limit has been used up');
  if (!t || String(j.responseStatus) !== '200' || /INVALID|PLEASE SELECT/i.test(t)) return null;
  return t;
}

/* ============ Readings: the possible base forms of a tapped word ============ */
function readingsFromPage(page, term) {
  const forms = new Map(), own = []; let o = 0;
  for (const e of page) {
    const ownDefs = e.defs.filter(d => !d.form);
    if (ownDefs.length) own.push({ lemma: term, pos: e.pos, flags: [], senses: ownDefs.slice(0, 6).map(d => ({ g: d.g, ex: d.ex })), o: o++ });
    for (const d of e.defs.filter(x => x.form)) {
      const k = d.lemma.toLowerCase() + '|' + e.pos;
      const r = forms.get(k) || { lemma: d.lemma, pos: e.pos, flags: [], senses: null, note: d.text, o: o++ };
      r.flags = [...new Set([...r.flags, ...d.flags])]; forms.set(k, r);
    }
  }
  return [...forms.values(), ...own];
}
async function sensesFor(lemma, pos, depth = 0) {         // English meaning of the base form (follows "past participle of X" one or two steps)
  const low = lemma.toLowerCase();
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
      const f = e.defs.find(d => d.form && d.lemma.toLowerCase() !== low);
      if (f) return sensesFor(f.lemma, e.pos === 'participle' ? 'verb' : e.pos, depth + 1);
    }
  }
  return { lemma, senses: [] };
}
async function fill(r) {
  if (r.senses) return;
  const s = await sensesFor(r.lemma, r.pos);
  r.senses = s.senses;
  if (s.lemma.toLowerCase() !== r.lemma.toLowerCase()) { r.via = r.lemma; r.lemma = s.lemma; }
}

/* ============ The word lookup ============
   cache → Wiktionary page of the tapped word (grammar + base form: hooks.onSkeleton) → meaning of the best reading
   (hooks.onTop) → meanings of the other readings → cache. A base form is never shown without its own English meaning. */
export async function lookup(word, ctx, hooks = {}) {
  const low = word.toLowerCase(), ck = 'an:' + low, stale = hooks.stale || (() => false);
  const hit = await cget(ck); if (hit) return hit;

  let term = low, page = await wikt(low);
  if (!page && word !== low) { term = word; page = await wikt(word); }
  if (stale()) return null;

  let readings = page ? readingsFromPage(page, term) : [];
  if (!readings.length) {                                  // Wiktionary has no page for this form
    const mt = await myMemory(low);
    if (!mt) throw fail('nomatch', 'No dictionary entry found');
    readings = [{ lemma: '', pos: '', flags: [], senses: [{ g: mt, ex: '' }], mt: 1, o: 99 }];
    cput(ck, readings); hooks.onTop && hooks.onTop(readings); return readings;
  }

  hooks.onSkeleton && hooks.onSkeleton(readings);
  const ranked = rank(readings, ctx);
  const complete = async r => {                            // meaning of r's base form; machine translation only if the base form has no page
    await fill(r);
    if (!r.senses.length && r.lemma) { const mt = await myMemory(r.lemma.toLowerCase()); if (mt) { r.senses = [{ g: mt, ex: '' }]; r.mt = 1; } }
  };
  await complete(ranked[0].r);                             // a failure here propagates: the popup then shows the real reason
  if (stale() && !hooks.keep) return readings;
  hooks.onTop && hooks.onTop(readings);

  let others = true;
  await Promise.all(ranked.slice(1, 5).map(x => complete(x.r).catch(() => { others = false; })));
  readings.forEach(r => { r.senses ||= []; });
  if (others) cput(ck, readings);                          // only complete results are cached
  return readings;
}

/* ============ Context-aware ranking ============ */
const S = s => new Set(s.split(' '));
const DET = S('el la los las un una unos unas este esta estos estas ese esa esos esas aquel aquella aquellos aquellas mi tu su mis tus sus nuestro nuestra nuestros nuestras vuestro vuestra otro otra otros otras cada mucho mucha muchos muchas poco poca pocos pocas todo toda todos todas algún alguna algunos algunas ningún ninguna varios varias del al cierto cierta ciertos ciertas tanto tanta tantos tantas');
const PREP = S('a ante bajo con contra de desde en entre hacia hasta para por según sin sobre tras');
const HAVE = S('ha he has hemos habéis han había habías habíamos habíais habían hube hubo habrá habría haya hayan hubiera hubiese haber habiendo');
const BE = S('es son era eran fue fueron soy eres somos sea sean sido ser está están estaba estaban estuvo estoy estás estamos estar esté estén estando queda quedan quedaba quedó quedaron');
const PREV = S('no ya se me te lo la las los le nos os les que y pero si cuando como porque nunca siempre también tampoco ni yo tú él ella usted nosotros nosotras ellos ellas ustedes quien donde mientras aunque pues entonces');
const REFL = S('se me te nos os');
const TENSE_FLAGS = ['pres', 'pret', 'impf', 'fut', 'cond', 'subj', 'impv', 'ind'];

const isFinite_ = r => r.pos === 'verb' && r.flags.some(f => TENSE_FLAGS.includes(f));
const isPtcp = r => r.pos === 'participle' || r.flags.includes('ptcp');

export function rank(readings, ctx) {
  const p1 = ctx.prev[0] || '', p2 = ctx.prev[1] || '', n1 = ctx.next[0] || '';
  return readings.map((r, i) => {
    const fin = isFinite_(r), pt = isPtcp(r), adj = r.pos === 'adjective', noun = r.pos === 'noun';
    const inf = r.pos === 'verb' && !fin && !pt, fn = ['preposition', 'conjunction', 'determiner', 'pronoun'].includes(r.pos);
    let s = -(r.o ?? i) * 0.12;
    if (!r.flags.length && r.lemma.toLowerCase() === ctx.word && !r.idx) s += 0.4;
    if (r.idx) s -= 0.5;
    if (DET.has(p1)) { if (noun) s += 3; if (adj) s += 0.8; if (fin) s -= 3; if (pt) s -= 0.5; if (fn) s -= 2; }
    if (HAVE.has(p1) || (p1 === 'no' && HAVE.has(p2))) { if (pt) s += 4; if (fin) s -= 2; if (noun) s -= 2; }
    if (BE.has(p1)) { if (adj || pt) s += 2.5; if (noun) s -= 0.5; }
    if (PREV.has(p1)) { if (fin) s += 2.5; if (noun) s -= 1; }
    if (PREP.has(p1)) { if (noun) s += 2; if (inf) s += 2; if (fin) s -= 2.5; if (adj) s -= 0.5; }
    if (p1 && !DET.has(p1) && !PREP.has(p1) && !HAVE.has(p1) && !BE.has(p1) && !PREV.has(p1)) { if (adj || pt) s += 1.2; if (fin) s += 0.4; }
    if (!p1 && fin) s += 0.3;
    if (DET.has(n1) && (fin || inf)) s += 1;
    if (ctx.capMid && noun) s += 1.5;
    return { r, s };
  }).sort((a, b) => b.s - a.s);
}

export function orderSenses(r, ctx) {
  const words = new Set(((ctx.sentence || '').toLowerCase().match(/[\p{L}]{4,}/gu)) || []);
  words.delete(ctx.word);
  const refl = REFL.has(ctx.prev[0] || '');
  return (r.senses || []).map((s, i) => {
    const g = (s.g || '').toLowerCase();
    let sc = -i * 0.2;
    if (/\b(reflexive|pronominal)\b/.test(g)) sc += refl ? 2 : -1.5;
    if (/\b(obsolete|archaic|dated|rare|dialectal|slang|vulgar|colloquial)\b/.test(g.slice(0, 40))) sc -= 1.2;
    let ov = 0; if (s.ex) for (const w of words) if (s.ex.includes(w)) ov++;
    return { s, sc: sc + Math.min(ov, 3) * 0.8 };
  }).sort((a, b) => b.sc - a.sc).map(x => x.s);
}

/* ============ English inflection (for "sabía = knew / used to know") ============ */
const IRR = {};
`arise arose arisen|awake awoke awoken|be was/were been|bear bore borne|beat beat beaten|become became become|begin began begun|bend bent bent|bet bet bet|bind bound bound|bite bit bitten|bleed bled bled|blow blew blown|break broke broken|bring brought brought|build built built|buy bought bought|catch caught caught|choose chose chosen|come came come|cost cost cost|cut cut cut|deal dealt dealt|dig dug dug|do did done|draw drew drawn|drink drank drunk|drive drove driven|eat ate eaten|fall fell fallen|feed fed fed|feel felt felt|fight fought fought|find found found|fly flew flown|forbid forbade forbidden|forget forgot forgotten|forgive forgave forgiven|freeze froze frozen|get got gotten|give gave given|go went gone|grow grew grown|hang hung hung|have had had|hear heard heard|hide hid hidden|hit hit hit|hold held held|hurt hurt hurt|keep kept kept|kneel knelt knelt|know knew known|lay laid laid|lead led led|leave left left|lend lent lent|let let let|lie lay lain|light lit lit|lose lost lost|make made made|mean meant meant|meet met met|pay paid paid|put put put|quit quit quit|read read read|ride rode ridden|ring rang rung|rise rose risen|run ran run|say said said|see saw seen|seek sought sought|sell sold sold|send sent sent|set set set|shake shook shaken|shine shone shone|shoot shot shot|show showed shown|shut shut shut|sing sang sung|sink sank sunk|sit sat sat|sleep slept slept|slide slid slid|speak spoke spoken|spend spent spent|spin spun spun|split split split|spread spread spread|stand stood stood|steal stole stolen|stick stuck stuck|sting stung stung|strike struck struck|swear swore sworn|sweep swept swept|swim swam swum|swing swung swung|take took taken|teach taught taught|tear tore torn|tell told told|think thought thought|throw threw thrown|understand understood understood|wake woke woken|wear wore worn|weep wept wept|win won won|wind wound wound|write wrote written`
  .split('|').forEach(l => { const [b, p, pp] = l.split(' '); IRR[b] = [p, pp]; });
const PREFIXES = ['be', 'for', 'fore', 'mis', 'out', 'over', 'under', 'up', 'with', 're', 'un', 'pre', 'inter', 'down'];
const IRR_KEYS = Object.keys(IRR).sort((a, b) => b.length - a.length);
function irr(v) {
  if (IRR[v]) return IRR[v];
  for (const k of IRR_KEYS) if (v.length > k.length && v.endsWith(k) && PREFIXES.includes(v.slice(0, -k.length))) { const p = v.slice(0, -k.length); return [p + IRR[k][0], p + IRR[k][1]]; }
  return null;
}
const DBL = new Set('begin prefer admit commit occur refer regret permit submit control upset equip transfer'.split(' '));
const dbl = v => (/^[^aeiou]*[aeiou][^aeiouwxy]$/.test(v) && v.length <= 4) || DBL.has(v);
const engPast = v => irr(v)?.[0] || (/e$/.test(v) ? v + 'd' : /[^aeiou]y$/.test(v) ? v.slice(0, -1) + 'ied' : dbl(v) ? v + v.slice(-1) + 'ed' : v + 'ed');
const engPP = v => irr(v)?.[1] || engPast(v);
const engIng = v => v === 'be' ? 'being' : /ie$/.test(v) ? v.slice(0, -2) + 'ying' : /e$/.test(v) && !/(ee|ye|oe)$/.test(v) ? v.slice(0, -1) + 'ing' : dbl(v) ? v + v.slice(-1) + 'ing' : v + 'ing';
const engS = v => v === 'be' ? 'is' : v === 'have' ? 'has' : /(s|x|z|ch|sh|o)$/.test(v) ? v + 'es' : /[^aeiou]y$/.test(v) ? v.slice(0, -1) + 'ies' : v + 's';
const STATIVE = new Set('know be have want like love need believe understand prefer seem belong own hate mean owe remember contain depend exist fit matter suppose wish'.split(' '));

function verbParts(gloss) {
  let g = plain(gloss).replace(/\([^)]*\)/g, '').replace(/^to\s+/i, '').split(/[;,/]/)[0].trim();
  const w = g.split(/\s+/);
  return { v: (w[0] || '').toLowerCase(), tail: w.length > 1 ? ' ' + w.slice(1).join(' ') : '' };
}
function verbEnglish(gloss, tense, flags) {
  const { v, tail } = verbParts(gloss);
  if (!/^[a-z]+$/.test(v)) return '';
  const third = flags.includes('3') && flags.includes('sg') && !flags.includes('1') && !flags.includes('2');
  const o = [];
  switch (tense) {
    case 'pres': o.push((third ? engS(v) : v) + tail); break;
    case 'pret': o.push(engPast(v) + tail); break;
    case 'impf': if (STATIVE.has(v)) o.push(engPast(v) + tail, 'used to ' + v + tail); else o.push(`was/were ${engIng(v)}${tail}`, 'used to ' + v + tail); break;
    case 'fut': o.push('will ' + v + tail); break;
    case 'cond': o.push('would ' + v + tail); break;
    case 'psubj': o.push(v + tail + ' (subj.)'); break;
    case 'isubj': o.push(engPast(v) + tail, 'would ' + v + tail); break;
    case 'fsubj': o.push('will ' + v + tail + ' (subj.)'); break;
    case 'impv': o.push(v + tail + '!'); break;
    case 'ger': o.push(engIng(v) + tail); break;
    case 'ptcp': o.push(engPP(v) + tail); break;
    case 'inf': o.push('to ' + v + tail); break;
  }
  return o.join(' / ');
}
const IRR_PL = { man: 'men', woman: 'women', child: 'children', person: 'people', foot: 'feet', tooth: 'teeth', mouse: 'mice', goose: 'geese', ox: 'oxen', life: 'lives', wife: 'wives', knife: 'knives', leaf: 'leaves', wolf: 'wolves', half: 'halves', shelf: 'shelves', thief: 'thieves', calf: 'calves' };
const plural1 = w => IRR_PL[w.toLowerCase()] || (/(s|x|z|ch|sh)$/.test(w) ? w + 'es' : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : w + 's');
function pluralize(gloss) {
  const g = plain(gloss).replace(/\([^)]*\)/g, '').replace(/^(a|an|the)\s+/i, '').split(/[;,/]/)[0].trim();
  const m = g.match(/^(.+?)(\s(?:of|for|in|on|to|with)\s.*)$/i), head = m ? m[1] : g, rest = m ? m[2] : '';
  const w = head.split(' '); w[w.length - 1] = plural1(w[w.length - 1]);
  return w.join(' ') + rest;
}

const TENSE_NAME = { pres: 'present', pret: 'preterite', impf: 'imperfect', fut: 'future', cond: 'conditional', psubj: 'present subjunctive', isubj: 'imperfect subjunctive', fsubj: 'future subjunctive', impv: 'imperative', ger: 'gerund', ptcp: 'past participle', inf: 'infinitive' };
export function tensesOf(flags) {
  const F = new Set(flags), t = [];
  if (F.has('ptcp')) t.push('ptcp'); if (F.has('ger')) t.push('ger'); if (F.has('inf')) t.push('inf');
  if (F.has('subj')) {
    if (F.has('pres')) t.push('psubj'); if (F.has('impf')) t.push('isubj'); if (F.has('fut')) t.push('fsubj');
    if (!['pres', 'impf', 'fut'].some(x => F.has(x))) t.push('psubj');
  }
  if (F.has('ind') || !F.has('subj')) for (const k of ['pres', 'pret', 'impf', 'fut', 'cond']) if (F.has(k) && !(k === 'pres' && F.has('subj') && !F.has('ind'))) t.push(k);
  if (F.has('impv')) t.push('impv');
  return [...new Set(t)];
}
function personLabel(flags) {
  const F = new Set(flags), p = ['1', '2', '3'].filter(x => F.has(x)).map(x => ({ 1: '1st', 2: '2nd', 3: '3rd' }[x])).join('/');
  if (!p) return '';
  return p + (F.has('sg') && !F.has('pl') ? ' sing.' : F.has('pl') && !F.has('sg') ? ' pl.' : '');
}
function nounGram(flags) {
  const n = { m: 'masculine', f: 'feminine', pl: 'plural', dim: 'diminutive', aug: 'augmentative', sup: 'superlative' };
  return ['m', 'f', 'pl', 'dim', 'aug', 'sup'].filter(k => flags.includes(k) && !(k === 'm' && flags.includes('f'))).map(k => n[k]).join(' ');
}
function formMeaning(r, g, tenses) {
  const gl = plain(g);
  if (/^to\s/i.test(gl)) return tenses.length ? [...new Set(tenses.map(t => verbEnglish(gl, t, r.flags)).filter(Boolean))].join(' · ') : '';
  if (r.pos === 'noun' && r.flags.includes('pl')) return pluralize(gl);
  if (r.flags.includes('dim')) return 'little ' + plain(gl).replace(/\([^)]*\)/g, '').trim();
  if (r.flags.includes('aug')) return 'big ' + plain(gl).replace(/\([^)]*\)/g, '').trim();
  if (r.flags.includes('sup')) return 'very ' + plain(gl).replace(/\([^)]*\)/g, '').trim();
  return '';
}

/* Everything the popup / vocabulary needs for one chosen reading */
export function describe(r, ctx) {
  const senses = orderSenses(r, ctx), glosses = [];
  for (const s of senses) { const g = clip(plain(s.g), 64); if (g && !glosses.includes(g)) glosses.push(g); if (glosses.length >= 3) break; }
  const tenses = tensesOf(r.flags), verbish = tenses.length > 0 && r.pos !== 'noun';
  const fm = senses[0] ? formMeaning(r, senses[0].g, verbish ? tenses : []) : '';
  const lemma = r.lemma || '';
  const gramVerb = tenses.map(t => TENSE_NAME[t]).join(' / ') + (personLabel(r.flags) ? ' · ' + personLabel(r.flags) : '');
  const gram = verbish ? gramVerb : nounGram(r.flags);
  return {
    lemma, pos: r.pos === 'participle' ? 'participle' : r.pos, via: r.via || '', verbish, gram,
    isForm: !!lemma && (r.flags.length > 0 || lemma.toLowerCase() !== ctx.word),
    meaning: glosses.join(' / '), formMeaning: fm && fm.toLowerCase() !== glosses[0]?.toLowerCase() ? fm : '', mt: !!r.mt
  };
}

/* ============ Sentence / phrase translation ============
   Lingva first, MyMemory if it fails — one after the other (never both at once), each with its own clear error. */
const PROVIDERS = {
  async lingva(text) {
    const r = await http('Lingva', `https://lingva.ml/api/v1/es/en/${encodeURIComponent(text)}`, 6000);
    const j = await r.json().catch(() => ({}));
    if (r.status === 404 || !j.translation) throw fail('nomatch', 'Lingva: no translation returned');
    return String(j.translation).trim();
  },
  async mymemory(text) {
    const t = await myMemory(text);
    if (!t) throw fail('nomatch', 'MyMemory: no translation returned');
    return t;
  }
};
export async function translatePhrase(text) {
  const ck = 'ph:' + text.toLowerCase().replace(/\s+/g, ' ').trim(), hit = await cget(ck);
  if (hit) return hit;
  const problems = [];
  for (const name of SENTENCE_PROVIDERS) {
    try { const out = await PROVIDERS[name](text); cput(ck, out); return out; }
    catch (e) { problems.push(e); }
  }
  const kind = problems.every(e => e.kind === 'nomatch') ? 'nomatch' : problems.some(e => e.kind === 'network' || e.kind === 'timeout') && problems.every(e => e.kind === 'network' || e.kind === 'timeout') ? 'network' : 'http';
  throw Object.assign(new Error(kind), { kind, detail: problems.map(e => e.detail || e.message).join(' · ') });
}
