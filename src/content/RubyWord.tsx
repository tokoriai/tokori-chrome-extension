/**
 * RubyWord — one word with its reading rendered as ruby, the way the
 * desktop app does it:
 *
 *   • Chinese: the reading is split into syllables (`parsePinyin`, the
 *     same segmenter the desktop uses) and, when the syllable count
 *     matches the character count, each hanzi gets ITS OWN syllable
 *     with a per-tone colour (`data-tone` + the Pleco palette in
 *     SHADOW_CSS). 成都 renders as 成/chéng 都/dū — not one "chéng dū"
 *     blob floating over the whole word.
 *   • Everything else (or unalignable readings): a single word-level
 *     annotation.
 *
 * Real <ruby>/<rt> elements keep mixed lines on one baseline and are
 * skipped by underline painting, so status underlines stay under the
 * characters only. Shared by the caption overlay, the transcript
 * sidebar, and the sentence analyzer.
 */

import { parsePinyin } from '../lib/pinyin';
import type { LanguageCode } from '../lib/languages';

export function RubyWord({
  word,
  reading,
  lang,
}: {
  word: string;
  reading: string | null | undefined;
  lang: LanguageCode | null;
}) {
  if (!reading) return <>{word}</>;
  if (lang === 'zh') {
    const chars = Array.from(word);
    const syls = parsePinyin(reading);
    if (chars.length > 1 && syls.length === chars.length) {
      return (
        <>
          {chars.map((ch, i) => (
            <ruby key={i}>
              {ch}
              <rt className="tk-rt" data-tone={syls[i].tone || undefined}>
                {syls[i].pretty}
              </rt>
            </ruby>
          ))}
        </>
      );
    }
    // Single char (or unalignable): still tone-colour the whole reading
    // when it parses to exactly one syllable.
    if (chars.length === 1 && syls.length === 1) {
      return (
        <ruby>
          {word}
          <rt className="tk-rt" data-tone={syls[0].tone || undefined}>
            {syls[0].pretty}
          </rt>
        </ruby>
      );
    }
  }
  return (
    <ruby>
      {word}
      <rt className="tk-rt">{reading}</rt>
    </ruby>
  );
}
