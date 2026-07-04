/**
 * Caption styling model for the YouTube overlay + transcript sidebar:
 * the user-tweakable style record, its defaults, and the status →
 * colour mapping. Pure data/logic — the settings UI lives in
 * CaptionSettingsPanel, the rendering in YouTubeEnhancer.
 */

/** User-tweakable caption styling. Sizes are px (number); colors are
 *  any CSS color string. Defaults are tuned for a 1080p YouTube player
 *  on the default 88%-from-top anchor. Customised via the gear icon in
 *  the overlay toolbar; persisted in `chrome.storage.local`. */
export interface CaptionStyle {
  nativeFontSize: number;
  translatedFontSize: number;
  /** Native (target-language) CC text colour — usually white; exposed in
   *  case the user wants to match their player theme. */
  nativeColor: string;
  /** Translated (English) CC text colour. Default is bright white so
   *  the line is actually readable against the dark video frame; the
   *  previous muted-gray was effectively invisible on a bright shot. */
  translatedColor: string;
  /** Highlight colours by vocab status — one per SRS bucket, matching
   *  the desktop app's palette (new=rose, learning=amber, review=sky,
   *  known/mastered=emerald). `unseen` covers any word the user has
   *  never met (not present in the workspace at all). */
  newColor: string;
  learningColor: string;
  reviewColor: string;
  knownColor: string; // status: mastered
  unseenColor: string; // word not in the known-words map
  /** Master switch for the "every word coloured" treatment. When off,
   *  only words present in the workspace are decorated and unseen
   *  words render plain — matches the pre-feature behaviour. */
  highlightUnseen: boolean;
  /** How the status colour is applied: a coloured underline beneath the
   *  word, or colouring the characters themselves (nice for hanzi). */
  highlightMode: 'underline' | 'text';
  /** Ruby readings (pinyin / furigana) above each word — on the CC
   *  overlay and the sidebar's active row. Sourced from the installed
   *  dictionaries (IDB first, paired desktop fallback). */
  showReading: boolean;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  nativeFontSize: 22,
  translatedFontSize: 16,
  nativeColor: '#ffffff',
  translatedColor: '#f5f5f5',
  newColor: '#fb7185', // rose-400
  learningColor: '#fbbf24', // amber-400
  reviewColor: '#38bdf8', // sky-400
  knownColor: '#34d399', // emerald-400
  unseenColor: '#a1a1aa', // zinc-400 — neutral so it doesn't shout over the SRS hues
  highlightUnseen: true,
  highlightMode: 'underline',
  showReading: true,
};

export function statusColorFor(
  status: string | undefined,
  highlightUnseen: boolean,
  style: CaptionStyle,
): string | null {
  if (status === 'new') return style.newColor;
  if (status === 'learning') return style.learningColor;
  if (status === 'review') return style.reviewColor;
  if (status === 'mastered') return style.knownColor;
  // No vocab row, or an inactive one (cloud `unseen`): only decorated
  // when the user opted into marking unseen words.
  return highlightUnseen ? style.unseenColor : null;
}
