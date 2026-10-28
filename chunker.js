// Meaning-unit chunker.
// Input: per recognition session ("stream"), the full transcript so far, split into
// its final part and its still-changing interim part. Output: non-overlapping chunks
// ready to translate. Each word of a stream is emitted exactly once (committed-prefix
// tracking by word count), so ASR revisions of already-sent words are never re-sent.

export const DEFAULTS = {
  pauseMs: 700,      // interim text unchanged this long -> commit it
  maxWords: 12,      // this many uncommitted interim words -> commit early
  tailHold: 2,       // on a length cut keep the last N words back (they still change)
  minPauseWords: 2,  // a pause cut needs at least this many words (finals ignore it)
};

export const splitWords = (s) => (s || '').trim().split(/\s+/).filter(Boolean);
const SENTENCE_END = /[.!?;…]["»)]*$/;

export class Chunker {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.streams = new Map(); // id -> { committed, text, changedAt, finalCount, words }
  }

  _get(id, now) {
    let s = this.streams.get(id);
    if (!s) {
      s = { committed: 0, text: '', changedAt: now, words: [], finalCount: 0 };
      this.streams.set(id, s);
    }
    return s;
  }

  _cut(id, s, end, endTime, reason) {
    const text = s.words.slice(s.committed, end).join(' ');
    s.committed = end;
    return { stream: id, text, endTime, reason };
  }

  // finalText: concatenation of all final results of this stream;
  // interimText: concatenation of the non-final results after them.
  update(id, finalText, interimText, now) {
    const s = this._get(id, now);
    const fin = splitWords(finalText);
    const words = fin.concat(splitWords(interimText));
    const joined = words.join(' ');
    if (joined !== s.text) { s.text = joined; s.changedAt = now; }
    s.words = words;
    s.finalCount = fin.length;
    const out = [];

    // 1. Everything final and not yet sent goes out now.
    if (s.finalCount > s.committed) out.push(this._cut(id, s, s.finalCount, now, 'final'));

    // 2. Sentence punctuation inside the interim tail (not on its very last word,
    //    which may still be revised).
    for (let i = words.length - 2; i >= s.committed; i--) {
      if (SENTENCE_END.test(words[i])) { out.push(this._cut(id, s, i + 1, now, 'punct')); break; }
    }

    // 3. Long run of interim words: send all but the unstable tail.
    if (words.length - s.committed >= this.o.maxWords) {
      const end = Math.max(s.committed + 1, words.length - this.o.tailHold);
      out.push(this._cut(id, s, end, now, 'length'));
    }
    return out;
  }

  // Call periodically (e.g. every 100ms): pause-based commits.
  tick(now) {
    const out = [];
    for (const [id, s] of this.streams) {
      const pending = s.words.length - s.committed;
      if (pending >= this.o.minPauseWords && now - s.changedAt >= this.o.pauseMs) {
        out.push(this._cut(id, s, s.words.length, s.changedAt, 'pause'));
      }
    }
    return out;
  }

  // Stream ended (recognition stopped/restarted): send whatever is left, forget it.
  flush(id, now) {
    const s = this.streams.get(id);
    if (!s) return [];
    this.streams.delete(id);
    if (s.words.length > s.committed) return [this._cut(id, s, s.words.length, Math.min(now, s.changedAt), 'flush')];
    return [];
  }
}

// Joins a SpeechRecognitionResultList-like array into { finalText, interimText }.
// dedupeCumulative works around Android Chrome repeating earlier finals as prefixes.
export function joinResults(results, dedupeCumulative = false) {
  let finalText = '', interimText = '', prevFinal = '';
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    let t = (r[0] && r[0].transcript) || '';
    if (r.isFinal) {
      if (dedupeCumulative && prevFinal && t.trim().startsWith(prevFinal.trim())) {
        t = t.trim().slice(prevFinal.trim().length);
      }
      prevFinal = r[0].transcript;
      finalText += ' ' + t;
    } else {
      interimText += ' ' + t;
    }
  }
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  return { finalText: norm(finalText), interimText: norm(interimText) };
}
