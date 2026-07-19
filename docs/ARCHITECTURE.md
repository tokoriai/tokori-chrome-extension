# Architecture

A map of how the pieces fit together — read this before your first PR.
File paths below are relative to `src/`.

## The surfaces

```
┌────────────────────────────── browser tab ──────────────────────────────┐
│  MAIN world                     ISOLATED world (content script)         │
│  ┌──────────────────┐           ┌──────────────────────────────────┐    │
│  │ youtube-cues.ts  │  window   │ content/index.tsx (shadow host)  │    │
│  │ netflix-cues.ts  │  events   │  ├ HoverPopup                    │    │
│  │ disney-cues.ts   │ ────────▶ │  ├ YouTubeEnhancer (+ sidebar)   │    │
│  │ (document_start) │ ◀──────── │  ├ StreamingDualSubs             │    │
│  └──────────────────┘           │  ├ OcrDualSubs                   │    │
│                                 │  └ Analyzer / MiningModal        │    │
│                                 └───────────────┬──────────────────┘    │
└─────────────────────────────────────────────────┼───────────────────────┘
                                       chrome.runtime messages
                                                  │
                              ┌───────────────────▼───────────────────┐
                              │ background.ts (MV3 service worker)    │
                              │  message router · settings · caches   │
                              │  save fan-out · known-words · alarms  │
                              └──┬──────────┬──────────┬──────────┬───┘
                                 │          │          │          │
                            IndexedDB   AnkiConnect  Tokori    Tokori
                            dictionaries (:8765)     desktop   cloud
                            (lib/dictionaries)      (:53210)  (api.tokori.ai)
```

Extension pages (`options`, `popup`, `welcome`, `stats`, `library`,
`player`, `offscreen`) talk to the same background router.

## Caption capture (YouTube)

`content/youtube-cues.ts` runs in the **MAIN world at `document_start`**
— current player builds capture `fetch`/XHR references early, so the
hooks must be installed before the player boots. It:

1. Wraps `fetch` + XHR and captures every `/api/timedtext` response body.
2. Reads the track list (player API, with a `getPlayerResponse()`
   fallback) and picks a **resting track** for the target language —
   the pure decision ladder lives in `lib/yt-track-pick.ts` (unit
   tested). No target-language track → the extension stands down for
   that video (no steering, stock YouTube).
3. Classifies each captured body as the **native** or **translated**
   line by its `lang`/`tlang` URL params and dispatches cues as window
   events (`tokori-yt-native-cues` / `tokori-yt-translated-cues`).
4. **Retains** every body it saw (keyed by URL, per video) and re-serves
   it on demand — the overlay mounts at `document_idle` and asks for a
   replay, which recovers every "captions sometimes don't load" race
   without refetching.

The English line comes from YouTube's auto-translate of the active track
(or a real display-language track), fetched in short, budgeted
"excursions" so the player's rate limits are never tripped.

Netflix and Disney+ are simpler: their MAIN-world scripts sniff the HLS
master playlist for subtitle renditions (`lib/m3u8.ts`) and fetch the
selected track's WebVTT segments directly — subtitle text only, the
DRM-protected stream is never touched. Both feed the shared
`StreamingDualSubs` overlay.

## OCR mode (burned-in subtitles)

`content/ocr/useOcrCues.ts` samples the user-selected capture region and
detects subtitle changes locally with a cheap outline-aware bright-pixel
signature — no work while a line sits on screen. Changed frames go to:

- **Local:** the offscreen document (`offscreen/`) hosts a
  [tesseract.js](https://github.com/naptha/tesseract.js) worker
  (WebAssembly, language packs cached in IndexedDB). Frames are cropped
  and binarized in-page (`lib/ocr-cues.ts` — see the comments there for
  the bright-scene extraction algorithm).
- **AI:** the user's own OpenAI / Anthropic / Gemini key, vision model.

Recognized lines flow into the same cue pipeline as real captions, so
mining, readings, and the sidebar all work.

## The background worker

`background.ts` is a message router around a handful of caches. MV3
workers die after ~30 s idle, so every module-scope cache follows the
same pattern: persist a snapshot in `chrome.storage.local`, restore it
on boot (`bootCache`), and let every reader go through a lazy
`ensure…()` with a TTL (stale-while-revalidate). The known-words map is
pushed to open tabs through the snapshot write itself (tabs relay
`storage.onChanged` as a window event).

Saving a card fans out to the enabled targets — Anki (`lib/anki.ts`),
Tokori desktop (`lib/tokori-local.ts`), Tokori cloud
(`lib/tokori-cloud.ts`) — and reports per-target results.
`resolveSaveTargets()` in `lib/settings.ts` merges the global defaults
with the per-tab override stored in `chrome.storage.session`.

## Dictionaries

`lib/dictionaries/` — a registry plus IndexedDB store. CC-CEDICT and a
pre-parsed JMdict snapshot install from the options page; Yomitan zips
and flat CSV/JSON import into the same store. Lookups run
longest-prefix-first entirely locally; when paired, a miss falls back to
the desktop's dictionaries, then the cloud. AI "generate definition"
results are persisted into a per-language personal dictionary so the
next lookup hits locally.

## Immersion & library

`lib/immersion.ts` (pure, tested) owns the time bookkeeping:
per-day totals, capped session log, stale-session finalization. The
YouTube pill (`content/youtube/useImmersion.ts`) ticks only while a
watch-library video actually plays and flushes deltas every 10 s.
`lib/local-library.ts` is the storage-backed watch library used when no
desktop is paired; paired, media and live sessions mirror to the
desktop's `/v1/media` and `/v1/sessions` APIs instead (30 s heartbeat
throttle).

## AI + translate fallback chains

- **Explain / define:** BYO key (`lib/ai-providers.ts`, direct to the
  provider) → paired desktop's AI proxy → cloud → disabled.
- **Translate:** desktop AI when paired (engine `auto`) → keyless
  Google endpoint (`free`).

Keys and tokens never leave `chrome.storage.local`.

## Conventions

- **Pure logic goes in `lib/`** with a Vitest test in `test/lib/` —
  everything that can be tested without a browser is.
- Content-script UI uses the `--tk-*` design tokens and `.tk-btn`
  classes from `lib/theme.ts` (shadow-DOM equivalents of the desktop's
  shadcn theme); extension pages use the shared shadcn/ui components.
- Shadow-DOM gotcha: events originating inside the shadow root are
  retargeted — use `e.composedPath()` for outside-click checks, never
  `el.contains(e.target)`.
- Every site surface is wrapped in a crash boundary that remounts after
  a few seconds — host-page DOM shifts under A/B tests must never take
  the whole extension down.
