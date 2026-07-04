/**
 * Shared sentence tokeniser used by the analyzer and the miner.
 *
 * Pure Intl.Segmenter — good enough for v0.1 across all listed
 * languages, including Chinese / Japanese / Thai. The full jieba+mecab
 * dispatch lives in the Tokori desktop app; the visual breakdown in
 * the popups doesn't need that fidelity.
 */

import { getLanguage, type LanguageCode } from '../lib/languages';

export interface Token {
  text: string;
  /** True when the segmenter classified the piece as a real word (vs
   *  punctuation / whitespace). Drives clickability + ruby annotation. */
  word: boolean;
}

export function tokenise(text: string, lang: LanguageCode | null): Token[] {
  try {
    const locale = lang ? getLanguage(lang)?.locale || 'en' : 'en';
    const seg = new Intl.Segmenter(locale, { granularity: 'word' });
    return Array.from(seg.segment(text), (s) => ({ text: s.segment, word: !!s.isWordLike }));
  } catch {
    return [{ text, word: false }];
  }
}
