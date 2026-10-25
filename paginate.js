/* paginate.js — turns a book into fixed pages that fit the screen.
   The book is one continuous stream of paragraphs ("flat"). A page is just a start position [paragraph, character offset];
   it ends where the next page starts. Pages are found by filling a hidden box that has exactly the size and typography
   of the real page, and splitting a paragraph at a word boundary when it no longer fits. */

export function flatten(book, sections) {
  const flat = [], secStart = [], secFirst = [], pdf = book.type === 'pdf'; let maxP = 0;
  sections.forEach((s, si) => {
    const at = flat.length;
    secStart.push(at);
    const synth = pdf ? /^(Pages? \d|Beginning$)/.test(s.title) : /^Section \d+$/.test(s.title);
    const chars = s.paras.reduce((a, p) => a + p.t.length, 0);
    if (!synth) flat.push({ t: s.title, h: true, ct: true, sec: si, p: s.paras[0]?.p });
    secFirst.push(flat.length);
    s.paras.forEach((p, i) => { p.sec = si; p.pi = i; if (p.p > maxP) maxP = p.p; flat.push(p); });
    if (flat[at] && (pdf ? !synth : chars >= 1200)) flat[at].brk = true; // chapters start on a fresh page
  });
  const cum = new Float64Array(flat.length + 1);
  flat.forEach((p, i) => { cum[i + 1] = cum[i] + p.t.length; });
  return { flat, secStart, secFirst, cum, maxP };
}

const skipWs = (t, i) => { while (i < t.length && /\s/.test(t[i])) i++; return i; };
const cutAt = (t, n) => { const i = t.lastIndexOf(' ', n); return i > n * 0.5 ? i : n; };
const wordEnds = t => { const out = [], re = /\S+/g; let m; while ((m = re.exec(t))) out.push(m.index + m[0].length); return out; };

/* largest k such that the first k+1 words fit (or -1); `est` is a starting guess */
function fitK(el, text, ends, est, M, H) {
  const top = ends.length - 2; if (top < 0) return -1;
  const fits = k => { el.textContent = text.slice(0, ends[k]); return M.scrollHeight <= H; };
  let lo = -1, hi = top, k = Math.max(0, Math.min(top, est));
  if (fits(k)) {
    lo = k; let s = 1;
    while (lo < hi) { const n = Math.min(hi, lo + s); if (fits(n)) { lo = n; s *= 2; } else { hi = n - 1; break; } }
  } else {
    hi = k - 1; let s = 1;
    while (hi >= 0) { const n = Math.max(0, hi - s + 1); if (fits(n)) { lo = n; break; } hi = n - 1; s *= 2; }
  }
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(mid)) lo = mid; else hi = mid - 1; }
  return lo;
}

export async function paginate({ flat, pdf, M, H, cum, cancelled, progress }) {
  const n = flat.length, pages = [];
  const mk = (para, text, cont) => {
    const el = document.createElement(para.ct ? 'h2' : para.h ? 'h3' : 'p');
    el.className = 'para' + (para.ct ? ' ct' : '') + (cont ? ' cont' : '');
    el.textContent = text; return el;
  };
  const fits = () => M.scrollHeight <= H;
  let g = 0, o = 0, count = 0;
  while (g < n) {
    pages.push([g, o]);
    M.textContent = '';
    let g2 = g, o2 = o, first = true;
    while (g2 < n) {
      const para = flat[g2];
      if (!first && o2 === 0) {
        if (para.brk) break;
        if (pdf && para.p != null && flat[g2 - 1].p != null && para.p !== flat[g2 - 1].p) break; // keep original PDF page boundaries
      }
      const text = para.t.slice(o2), el = mk(para, text, o2 > 0 || !!para.cont);
      M.appendChild(el);
      let body = text;
      if (text.length > 6000) { const c = text.slice(0, cutAt(text, 6000)); el.textContent = c; if (!fits()) body = c; else el.textContent = text; }
      if (fits()) { g2++; o2 = 0; first = false; continue; }

      const ends = wordEnds(body), top0 = el.offsetTop, hc = M.scrollHeight;
      const est = hc > top0 ? Math.floor(ends.length * Math.max(0, H - top0) / (hc - top0)) : 0;
      const k = fitK(el, body, ends, est, M, H);
      if (k >= 0) { el.textContent = body.slice(0, ends[k]); o2 = skipWs(para.t, o2 + ends[k]); break; }
      M.removeChild(el);
      if (first) { o2 = skipWs(para.t, o2 + ends[0]); break; } // not even one word fits: always make progress
      const last = M.lastElementChild; // never leave a heading stranded at the bottom of a page
      if (last && /^H[23]$/.test(last.tagName) && M.childElementCount > 1) { M.removeChild(last); g2--; o2 = 0; }
      break;
    }
    if (g2 < n && o2 >= flat[g2].t.length) { g2++; o2 = 0; }
    if (g2 === g && o2 === o) { g2 = g + 1; o2 = 0; } // safety
    g = g2; o = o2;
    if (++count % 6 === 0) {
      progress && progress(cum[Math.min(g, n)] / (cum[n] || 1));
      await new Promise(r => setTimeout(r, 0));
      if (cancelled && cancelled()) return null;
    }
  }
  return pages;
}

/* which slices of which paragraphs make up page `pi` */
export function pageParts(flat, pages, pi) {
  const [g0, o0] = pages[pi], nx = pages[pi + 1], g1 = nx ? nx[0] : flat.length, o1 = nx ? nx[1] : 0, out = [];
  for (let g = g0; g <= g1 && g < flat.length; g++) {
    const t = flat[g].t, a = g === g0 ? o0 : 0, b = g === g1 ? o1 : t.length;
    if (b > a) out.push({ g, a, b, cont: a > 0 || !!flat[g].cont });
  }
  return out;
}

/* index of the page that contains position [g, o] */
export function findPage(pages, g, o) {
  let lo = 0, hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1, [a, b] = pages[mid];
    if (a < g || (a === g && b <= o)) lo = mid; else hi = mid - 1;
  }
  return lo;
}
