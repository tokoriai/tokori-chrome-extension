/**
 * YouTube resting-track selection — the pure decision core of the
 * MAIN-world caption script (content/youtube-cues.ts), extracted so the
 * ladder that decides what the native caption line rests on is
 * unit-testable:
 *
 *   1. a REAL caption track in the target language (exact match first,
 *      then the Simplified variant for zh, then any prefix match);
 *   2. for a zh learner whose only real track is Traditional: YouTube's
 *      own Hant→Hans translation of that track (until the caller finds
 *      it cue-less and re-plans with `allowHantToHans: false`, which
 *      makes rung 1 win verbatim);
 *   3. no target-language track at all: resting is NULL — the caller
 *      stays HANDS-OFF and leaves YouTube's own captions alone.
 *
 * Rung 3 used to auto-translate a base track into the target
 * (workspace) language, and it produced exactly the breakage it was
 * meant to prevent: a "… → undefined" entry in YouTube's CC menu, no
 * cues at all on untranslatable tracks, and YouTube's own renderer
 * piling the whole machine-translated transcript on screen at once.
 * A video that isn't in the workspace language now gets NO automatic
 * takeover — translation into the target is something the user asks
 * for explicitly (a subtitle-menu tlang pin), never the default.
 *
 * `baseTrack` is still computed as the SOURCE for those explicit
 * translate pins (and for the display-language line's excursions): an
 * English track that is actually translatable first, then ANY
 * translatable track, then English/first as a last resort — a
 * non-translatable base would silently yield no cues.
 */

export interface PickableTrack {
  languageCode?: string;
  vssId?: string;
  kind?: string;
  /** Player builds expose the translate flag under either spelling
   *  (InnerTube's `isTranslatable`, the legacy API's misspelled
   *  `is_translateable`). Absent means "assume translatable". */
  isTranslatable?: boolean;
  is_translateable?: boolean;
}

export const SIMPLIFIED_CODES = ['zh', 'zh-hans', 'zh-cn', 'zh-sg', 'zh-my'];
export const TRADITIONAL_CODES = ['zh-hant', 'zh-tw', 'zh-hk', 'zh-mo'];

export function matchesLang(actual: string, target: string): boolean {
  const a = actual.toLowerCase();
  const t = target.toLowerCase();
  if (!a || !t) return false;
  if (a === t) return true;
  // YouTube uses zh-CN / zh-TW / zh-Hans / pt-BR / etc. — match by prefix.
  if (a.startsWith(t + '-') || a.startsWith(t + '_')) return true;
  if (t.startsWith(a + '-') || t.startsWith(a + '_')) return true;
  // Cross-script Chinese: target 'zh' should accept 'zh-Hans' etc., which
  // the above covers. Treat 'zh-Hans' / 'zh-Hant' / 'zh-CN' / 'zh-TW' as
  // interchangeable when target is just 'zh'.
  if (t === 'zh' && a.startsWith('zh')) return true;
  if (a === 'zh' && t.startsWith('zh')) return true;
  return false;
}

export type RestingPick<T> =
  { mode: 'track'; track: T } | { mode: 'translate'; source: T; tlang: string };

export interface RestingPlan<T> {
  /** REAL track matching the target (exact > zh Simplified > prefix). */
  targetTrack: T | null;
  /** Auto-translate SOURCE for an explicit translate pin / the
   *  display-language excursions (en translatable > any translatable >
   *  en > first). Never drives the automatic resting pick. */
  baseTrack: T | null;
  /** What the native caption line should rest on. Null ⇒ the video has
   *  no target-language track (or no tracks at all): stay hands-off. */
  resting: RestingPick<T> | null;
  /** The resting pick is the zh Hant→Hans translation — the caller's
   *  timed "translation produced no cues" fallback keys on this. */
  hantToHans: boolean;
}

export function planRestingPick<T extends PickableTrack>(
  tracklist: readonly T[],
  target: string,
  opts: {
    /** Map a language to the translate code the player actually offers
     *  (zh → the listed zh-Hans variant, pt → pt-BR, …). */
    resolveTlang: (target: string) => string;
    /** False once the Hant→Hans translation proved cue-less (or a user
     *  pin is in charge) — rung 2 is skipped. Defaults to true. */
    allowHantToHans?: boolean;
  },
): RestingPlan<T> {
  const tgt = target.toLowerCase();
  const lower = (t: T) => (t.languageCode || '').toLowerCase();

  const exact = tracklist.find((t) => lower(t) === tgt);
  const scriptPreferred =
    tgt === 'zh' ? tracklist.find((t) => SIMPLIFIED_CODES.includes(lower(t))) : undefined;
  const targetTrack =
    exact || scriptPreferred || tracklist.find((t) => matchesLang(lower(t), tgt)) || null;

  const translatable = (t: T) => t.isTranslatable !== false && t.is_translateable !== false;
  const baseTrack =
    tracklist.find((t) => lower(t).startsWith('en') && translatable(t)) ||
    tracklist.find(translatable) ||
    tracklist.find((t) => lower(t).startsWith('en')) ||
    tracklist[0] ||
    null;

  const hantToHans =
    (opts.allowHantToHans ?? true) &&
    tgt === 'zh' &&
    !!targetTrack &&
    TRADITIONAL_CODES.includes(lower(targetTrack));

  const resting: RestingPick<T> | null = targetTrack
    ? hantToHans
      ? { mode: 'translate', source: targetTrack, tlang: opts.resolveTlang('zh') }
      : { mode: 'track', track: targetTrack }
    : null;

  return { targetTrack, baseTrack, resting, hantToHans };
}
