/**
 * Caption tokeniser for the YouTube overlay.
 *
 * Splits a caption line into clickable `word` tokens vs. inert
 * `space` (whitespace / punctuation) tokens. Chinese prefers the paired
 * Tokori desktop's jieba route; otherwise Intl.Segmenter; with a
 * per-character CJK fallback when neither is available.
 */
import { sendMsgAsync } from '../../lib/chromeApi';
import type { LanguageCode } from '../../lib/languages';

/** Tokenise caption text for per-token clickability. CJK characters
 *  are emitted one-per-token (so clicking 你 in 你好 looks up 你);
 *  Latin/Cyrillic/etc. scripts emit whole words, with whitespace +
 *  punctuation kept as separate `space` tokens so the original
 *  spacing is preserved. This is the *synchronous fallback*; the real
 *  segmenter (jieba via desktop, then Intl.Segmenter) runs async and
 *  replaces these tokens once it resolves. */
export type Token = { kind: 'word' | 'space'; text: string };

const PUNCT_RE = /[.,!?;:'"()[\]{}—–\-…，。、！？；：「」『』（）【】《》]/;

/** Smarter segmentation than the per-char fallback. For Chinese,
 *  asks the paired Tokori desktop's jieba endpoint over HTTP. For
 *  any language (including ja/ko/th when desktop isn't paired) falls
 *  back to `Intl.Segmenter(lang, { granularity: 'word' })`, which
 *  is ICU-backed in V8 and segments CJK words reasonably well. */
export async function segmentText(text: string, lang: LanguageCode | null): Promise<Token[]> {
  // 1. Try the desktop's jieba route (Chinese only; route echoes other
  //    langs unchanged so the check below stays cheap when it's not).
  if (lang === 'zh') {
    try {
      const r = await sendMsgAsync<{ tokens: string[] | null }>({
        action: 'tokenizeRemote',
        lang,
        text,
      });
      if (r.success) {
        const toks = (r as { tokens: string[] | null }).tokens;
        if (toks && toks.length) return packTokens(toks);
      }
    } catch {
      /* fall through to Intl */
    }
  }

  // 2. Intl.Segmenter — present in all Chromium/Manifest V3 hosts.
  try {
    if (lang && typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
      const seg = new (
        Intl as unknown as {
          Segmenter: new (
            l: string,
            o?: object,
          ) => { segment: (s: string) => Iterable<{ segment: string; isWordLike?: boolean }> };
        }
      ).Segmenter(lang, { granularity: 'word' });
      const out: Token[] = [];
      for (const s of seg.segment(text)) {
        const t = s.segment;
        if (!t) continue;
        if (s.isWordLike) out.push({ kind: 'word', text: t });
        else out.push({ kind: 'space', text: t });
      }
      if (out.length) return out;
    }
  } catch {
    /* fall through to char-level */
  }

  // 3. Last-resort: per-character (current behaviour).
  return tokenize(text);
}

/** Convert a flat list of token strings (from jieba/Segmenter) into the
 *  {kind, text} shape the renderer expects. Whitespace + punctuation
 *  runs become `space` tokens; everything else is `word`. */
export function packTokens(strs: string[]): Token[] {
  const out: Token[] = [];
  for (const t of strs) {
    if (!t) continue;
    const isSpaceish = /^\s+$/.test(t) || (t.length <= 2 && PUNCT_RE.test(t));
    out.push({ kind: isSpaceish ? 'space' : 'word', text: t });
  }
  return out;
}

export function tokenize(text: string): Token[] {
  if (!text) return [];
  const tokens: Token[] = [];
  const isCjk = (c: string) => {
    const cp = c.codePointAt(0) || 0;
    return (
      (cp >= 0x3400 && cp <= 0x9fff) || // CJK Unified Ideographs (+ Ext A)
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat Ideographs
      (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
      (cp >= 0xac00 && cp <= 0xd7af) // Hangul Syllables
    );
  };
  // Match either a word ([A-Za-z0-9 + various unicode letters]+) or a
  // run of whitespace / punctuation. Single CJK chars are special-cased.
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) || 0;
    const ch = String.fromCodePoint(cp);
    const len = ch.length;
    if (isCjk(ch)) {
      tokens.push({ kind: 'word', text: ch });
      i += len;
    } else if (/\s/.test(ch) || /[.,!?;:'"()[\]{}—–\-…]/.test(ch)) {
      tokens.push({ kind: 'space', text: ch });
      i += len;
    } else {
      // Accumulate a run of word characters.
      let j = i + len;
      while (j < text.length) {
        const c2 = text.codePointAt(j) || 0;
        const s2 = String.fromCodePoint(c2);
        if (isCjk(s2) || /\s/.test(s2) || /[.,!?;:'"()[\]{}—–\-…]/.test(s2)) break;
        j += s2.length;
      }
      tokens.push({ kind: 'word', text: text.slice(i, j) });
      i = j;
    }
  }
  return tokens;
}
