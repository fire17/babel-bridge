// Translation providers (free, keyless, CORS-open) + church glossary post-fix.
// Works in the browser and in node >= 18 (global fetch).

export const PROVIDERS = {
  mymemory: {
    name: 'MyMemory',
    terms: 'Free anonymous use, ~5,000 chars/day per IP (mymemory.translated.net/doc/usagelimits.php)',
    async translate(text, signal) {
      if (text.length > 480) throw new Error('MyMemory: chunk over 500-char limit'); // their hard per-request cap
      const url = 'https://api.mymemory.translated.net/get?langpair=ru|en&q=' + encodeURIComponent(text);
      const r = await fetch(url, { signal });
      const j = r.ok ? await r.json() : {};
      const out = (j.responseData && j.responseData.translatedText) || '';
      if (r.status === 429 || j.quotaFinished || Number(j.responseStatus) === 429 || /USED ALL AVAILABLE FREE/i.test(out)) {
        const e = new Error('MyMemory daily free limit reached'); e.quota = true; throw e;
      }
      if (!r.ok) throw new Error('MyMemory HTTP ' + r.status);
      if (Number(j.responseStatus) !== 200 || !out || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) {
        throw new Error('MyMemory: ' + String(j.responseDetails || out || 'bad response').slice(0, 80));
      }
      return decodeEntities(pickMyMemory(text, j) || out);
    },
  },
  google: {
    name: 'Google (unofficial gtx)',
    terms: 'Undocumented public endpoint, no published terms or SLA; may rate-limit',
    async translate(text, signal) {
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=ru&tl=en&dt=t&q=' + encodeURIComponent(text);
      const r = await fetch(url, { signal });
      if (!r.ok) throw new Error('Google HTTP ' + r.status);
      const j = await r.json();
      if (!Array.isArray(j) || !Array.isArray(j[0])) throw new Error('Google: bad response');
      return j[0].map((seg) => (seg && seg[0]) || '').join('');
    },
  },
};

export const ORDERS = {
  auto: ['mymemory', 'google'],
  google: ['google', 'mymemory'],
  mymemory: ['mymemory'],
};

// MyMemory's top answer can be a FUZZY translation-memory hit: a different sentence
// that merely resembles ours (e.g. adds "be with your spirit"). For live interpretation
// we only accept an exact TM hit; otherwise we take its machine-translation candidate.
const normSeg = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function pickMyMemory(query, j) {
  const matches = Array.isArray(j.matches) ? j.matches : [];
  const q = normSeg(query);
  const exact = matches.find((m) => normSeg(m.segment) === q && Number(m.match) >= 0.98 && m.translation);
  if (exact) return exact.translation;
  const mt = matches.find((m) => m['created-by'] === 'MT!' || /machine translation/i.test(m.reference || ''));
  if (mt && mt.translation) return mt.translation;
  const top = j.responseData || {};
  return Number(top.match) >= 0.98 ? top.translatedText : null;
}

function decodeEntities(s) {
  return s.replace(/&#39;|&#039;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Synodal (Russian) -> Hebrew/English psalm numbering, for the common range.
export function psalmRuToEn(n) {
  if (n >= 10 && n <= 112) return n + 1;
  if (n === 113) return '114-115';
  if (n === 114 || n === 115) return 116;
  if (n >= 116 && n <= 145) return n + 1;
  if (n === 146 || n === 147) return 147;
  if (n === 9) return '9-10';
  return n;
}

// Each rule fires only if its Russian pattern is in the source chunk.
// (JS \b is ASCII-only, so Cyrillic patterns avoid it.)
const capStart = [/(^|[.!?]\s+)the Lord/g, '$1The Lord'];
export const GLOSSARY = [
  { ru: /Иисус\S*\s+Христ/i, fix: [[/\b(Iisus|Jesus)\s+(Christ|Hristos|Khristos)\b/gi, 'Jesus Christ']] },
  { ru: /Иисус/i, fix: [[/\bIisus\w*/gi, 'Jesus']] },
  { ru: /Свят\S*\s+Дух|Дух\S*\s+Свят/i, fix: [[/\b(the\s+)?(Holy\s+Ghost|Holy\s+Spirit|Spirit\s+Holy|Saint\s+Spirit)\b/gi, 'the Holy Spirit'], [/(^|[.!?]\s+)the Holy/g, '$1The Holy']] },
  // "Господь" -> "the Lord"; only rewrite "God" when "Бог" is not also in the chunk.
  { ru: /Господ/i, unless: /Бог/i, fix: [[/\b(the\s+)?God\b/g, 'the Lord'], capStart] },
  { ru: /Писани/i, fix: [[/\b(the\s+)?(holy\s+)?scriptures?\b/gi, 'Scripture'], [/(^|[.!?]\s+)scripture/g, '$1Scripture']] },
  { ru: /амин/i, fix: [[/\bamin\b/gi, 'amen']] },
  // Synodal psalm numbers -> English numbering ("Псалом 21" is the English Psalm 22).
  { ru: /псал/i, opt: 'psalms', fix: [
    [/\b(?:the\s+)?(\d{1,3})(?:st|nd|rd|th)\s+psalm\b/gi, (m, n) => 'Psalm ' + n],
    [/\b(Psalms?)\s+(\d{1,3})\b/gi, (m, w, n) => 'Psalm ' + psalmRuToEn(Number(n))],
  ] },
  // Address forms: keep "brothers and sisters" (MT sometimes says "brethren").
  { ru: /брат/i, fix: [[/\bbrethren(\s+and\s+sisters)?/gi, (m, s) => s ? 'brothers and sisters' : 'brothers']] },
  { ru: /сестр|сёстр/i, fix: [[/\bsis\b/gi, 'sister']] },
];

export function applyGlossary(ru, en, opts = {}) {
  let out = en;
  for (const rule of GLOSSARY) {
    if (!rule.ru.test(ru) || (rule.unless && rule.unless.test(ru))) continue;
    if (rule.opt && opts[rule.opt] === false) continue;
    for (const [re, rep] of rule.fix) out = out.replace(re, rep);
  }
  return out.replace(/\bthe the\b/gi, 'the').replace(/\s{2,}/g, ' ').trim();
}

// Try providers in order with a per-request timeout. Returns { text, raw, provider, ms }.
// Providers that hit their daily quota are skipped for the rest of the session.
export const exhausted = new Set();

export async function translate(ru, { order = 'auto', timeoutMs = 4000, onFail = () => {}, glossary = {} } = {}) {
  const t0 = Date.now();
  let lastErr;
  const keys = ORDERS[order] || ORDERS.auto;
  const live = keys.filter((k) => !exhausted.has(k));
  for (const key of live.length ? live : keys) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const raw = await PROVIDERS[key].translate(ru, ctl.signal);
      return { text: applyGlossary(ru, raw, glossary), raw, provider: key, ms: Date.now() - t0 };
    } catch (e) {
      lastErr = e;
      if (e.quota) exhausted.add(key);
      onFail(key, e);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('no provider');
}
