/* lex.js — word → base form → meaning.
   Sources, combined:
   1. English Wiktionary (Spanish entries): lemma, parts of speech, grammatical forms, senses, usage examples.
   2. A bundled Spanish lemma index (vendor/lemmas, loaded on demand): finds the base form even when Wiktionary has no page for the form.
   3. MyMemory as a last resort for single words.
   Phrases: Lingva (Google backend) first, MyMemory as backup.
   Everything fetched is cached on the device, so repeat lookups work offline. */

let cache = { get: async () => null, put: async () => { } };
export const initLex = c => { cache = c; };
const V = 2;

const clip = (s, n) => s.length > n ? s.slice(0, s.lastIndexOf(' ', n) > 20 ? s.lastIndexOf(' ', n) : n).replace(/[,;:\s]+$/, '') + '…' : s;
export const plain = g => {
  let s = (g || '').replace(/\s+/g, ' ').trim();
  const t = s.replace(/^(\([^)]*\)\s*)+/, '').trim();
  if (t.length >= 3) s = t;
  return s.replace(/\.$/, '').trim();
};
async function http(url, ms = 8000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal }); } finally { clearTimeout(t); }
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
const parseHTML = h => new DOMParser().parseFromString(h || '', 'text/html');
const textOf = h => parseHTML(h).body.textContent.replace(/\s+/g, ' ').trim();

function parseDef(def) {
  const d = parseHTML(def.definition);
  const full = d.body.textContent.replace(/\s+/g, ' ').trim();
  if (!full) return null;
  if (d.querySelector('.form-of-definition')) {
    const a = d.querySelector('.form-of-definition-link a') || d.querySelector('[lang="es"] a');
    const lemma = a && (a.textContent || '').trim();
    if (lemma) return { form: 1, lemma, flags: flagsOf(full.split(lemma).join(' ')), text: clip(full, 120) };
  }
  d.querySelectorAll('ul,ol,dl,.h-usage-example').forEach(n => n.remove());
  const g = d.body.textContent.replace(/\s+/g, ' ').trim();
  if (!g) return null;
  const ex = (def.parsedExamples || def.examples || []).slice(0, 3).map(x => textOf(typeof x === 'string' ? x : x.example)).join(' ').toLowerCase().slice(0, 300);
  return { g: g.replace(/\s*;\s*/g, ' / '), ex };
}
const parsePage = entries => entries
  .map(e => ({ pos: normPos(e.partOfSpeech), defs: (e.definitions || []).map(parseDef).filter(Boolean) }))
  .filter(e => e.defs.length);

async function wikt(term) {
  const ck = 'wk:' + term, hit = await cache.get(ck);
  if (hit && hit.v === V) return hit.data;
  const r = await http('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(term));
  let data = null;
  if (r.status !== 404) {
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    data = Array.isArray(j.es) ? parsePage(j.es) : null;
  }
  cache.put({ word: ck, v: V, data });
  return data;
}

/* ============ Offline lemma index ============ */
const shards = new Map();
function shard(w) {
  const c = (w.normalize('NFD')[0] || '_').toLowerCase(), b = /[a-z]/.test(c) ? c : '_';
  if (!shards.has(b)) {
    shards.set(b, fetch(`vendor/lemmas/${b}.txt`).then(r => r.ok ? r.text() : '').then(t => {
      const m = new Map();
      for (const line of t.split('\n')) { const i = line.indexOf('\t'); if (i > 0) m.set(line.slice(0, i), line.slice(i + 1)); }
      return m;
    }).catch(() => { shards.delete(b); return new Map(); }));
  }
  return shards.get(b);
}
async function indexLemmas(w) { const v = (await shard(w)).get(w.toLowerCase()); return v ? v.split('|') : []; }

/* ============ Build readings for a tapped form ============ */
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
async function sensesFor(lemma, pos, depth = 0) {
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

async function myMemory(q) {
  const r = await http(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=es|en`);
  if (!r.ok) throw new Error('http ' + r.status);
  const j = await r.json(), t = textOf(j.responseData?.translatedText || '');
  if (!t || String(j.responseStatus) !== '200' || /MYMEMORY WARNING|INVALID|PLEASE SELECT/i.test(t)) return null;
  return t;
}

export async function analyze(word) {
  const low = word.toLowerCase(), ck = 'an:' + low, hit = await cache.get(ck);
  if (hit && hit.v === V) return hit.data;
  let net = false;
  const safe = async fn => { try { return await fn(); } catch { net = true; return null; } };

  let readings = [];
  let term = low, page = await safe(() => wikt(low));
  if (!page && !net && word !== low) { term = word; page = await safe(() => wikt(word)); }
  if (page) readings = readingsFromPage(page, term);

  const lemmas = (await indexLemmas(low)).filter(l => l !== low);
  const hasForm = readings.some(r => r.flags.length);
  if (lemmas.length && (!readings.length || !hasForm)) {
    const known = new Set(readings.map(r => r.lemma.toLowerCase()));
    lemmas.filter(l => !known.has(l)).slice(0, readings.length ? 2 : 3)
      .forEach((l, i) => readings.push({ lemma: l, pos: '', flags: [], senses: null, idx: 1, o: 50 + i }));
  }
  await Promise.all(readings.filter(r => !r.senses).slice(0, 5).map(async r => {
    const s = await safe(() => sensesFor(r.lemma, r.pos));
    if (s) { r.senses = s.senses; if (s.lemma.toLowerCase() !== r.lemma.toLowerCase()) { r.via = r.lemma; r.lemma = s.lemma; } }
  }));
  readings.forEach(r => { r.senses ||= []; });

  if (!readings.some(r => r.senses.length)) {
    const mt = await safe(() => myMemory(low));
    if (mt) readings = [{ lemma: '', pos: '', flags: [], senses: [{ g: mt, ex: '' }], mt: 1, o: 99 }];
  }
  if (!readings.length) throw new Error(net ? 'offline' : 'nomatch');
  if (!net) cache.put({ word: ck, v: V, data: readings });
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

/* ============ Phrase / sentence translation ============ */
export async function translatePhrase(text) {
  const ck = 'ph:' + text.toLowerCase(), hit = await cache.get(ck);
  if (hit && hit.v === V) return hit.data;
  let net = false, out = null;
  try {
    const r = await http(`https://lingva.ml/api/v1/es/en/${encodeURIComponent(text)}`, 6000);
    if (r.ok) { const j = await r.json(); if (j.translation) out = String(j.translation).trim(); }
  } catch { net = true; }
  if (!out) { try { out = await myMemory(text); } catch { net = true; } }
  if (!out) throw new Error(net ? 'offline' : 'nomatch');
  cache.put({ word: ck, v: V, data: out });
  return out;
}
