/**
 * SRT / WebVTT parsing → the same `{ start, dur, text }` cue shape the
 * YouTube pipeline uses, so every dual-subtitle surface (player page,
 * Netflix enhancer) renders through one contract.
 *
 * Deliberately tolerant: real-world subtitle files disagree about
 * comma vs dot milliseconds, BOM, blank-line spacing, and styling
 * tags. We normalize all of it and strip inline markup — the overlay
 * tokenizes plain text.
 */

export interface SubtitleCue {
  /** Seconds. */
  start: number;
  /** Seconds. */
  dur: number;
  text: string;
}

/** `01:02:03.456`, `02:03,456`, `3.456` → seconds. */
function parseTimestamp(raw: string): number | null {
  const m = raw.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return (
    (h ? Number(h) * 3600 : 0) + Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, '0')) / 1000
  );
}

/** Drop `<i>`, `<c.class>`, `{\an8}` ASS-style tags, ruby markup … */
function stripMarkup(text: string): string {
  return text
    .replace(/<[^>\n]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * Parse SRT or WebVTT (auto-detected — VTT declares itself with a
 * `WEBVTT` header; everything else is treated as SRT). Returns cues
 * sorted by start time; unparseable blocks are skipped, not fatal.
 */
export function parseSubtitles(raw: string): SubtitleCue[] {
  const src = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues: SubtitleCue[] = [];

  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    // Find the timing line — SRT puts a numeric index before it, VTT
    // may put a cue id; both may omit it.
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx < 0) continue; // WEBVTT header / NOTE / STYLE blocks
    const timing = lines[timingIdx]!;
    const [startRaw, endRawWithSettings] = timing.split('-->');
    if (!startRaw || !endRawWithSettings) continue;
    // VTT appends cue settings after the end time ("… align:start").
    const endRaw = endRawWithSettings.trim().split(/\s+/)[0] ?? '';
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw);
    if (start == null || end == null || end <= start) continue;
    const text = stripMarkup(lines.slice(timingIdx + 1).join('\n'));
    if (!text) continue;
    cues.push({ start, dur: end - start, text });
  }

  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/** The cue whose window contains `t`, or null. Linear scan is fine at
 *  subtitle scale (a two-hour film is ~2k cues). */
export function cueAt(cues: readonly SubtitleCue[], t: number): SubtitleCue | null {
  for (const c of cues) {
    if (t >= c.start && t < c.start + c.dur) return c;
    if (c.start > t) break; // sorted — nothing later can contain t
  }
  return null;
}

/** Merge per-segment cue lists (HLS subtitle tracks arrive as many
 *  small VTT files) into one clean track: exact duplicates dropped
 *  (segments repeat cues across their boundaries), sorted, and
 *  same-text cues that touch/overlap coalesced into a single span —
 *  a cue crossing a segment boundary otherwise shows up twice with
 *  slightly different windows. */
export function mergeSegmentCues(lists: readonly SubtitleCue[][]): SubtitleCue[] {
  const seen = new Map<string, SubtitleCue>();
  for (const list of lists) {
    for (const c of list) {
      const key = `${Math.round(c.start * 100)}|${c.text}`;
      if (!seen.has(key)) seen.set(key, c);
    }
  }
  const sorted = [...seen.values()].sort((a, b) => a.start - b.start);
  const out: SubtitleCue[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && last.text === c.text && c.start <= last.start + last.dur + 0.25) {
      last.dur = Math.max(last.dur, c.start + c.dur - last.start);
    } else {
      out.push({ ...c });
    }
  }
  return out;
}
