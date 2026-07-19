# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-19

### Added

- Two-way immersion-timer sync with the Tokori desktop sidebar. Pausing
  the video now shows the session as ⏸ paused on the desktop chip
  within a second (instead of a silently creeping timer), and the
  desktop's new Pause / Resume / End controls drive the extension:
  pause/resume act on the actual player, End stops the session cleanly
  (tail seconds + title still land) without the auto-start immediately
  reviving it. Works on YouTube and the built-in Player page; the
  background polls the desktop's new `/v1/sessions/:id/control` route
  (~3 s) while a session runs and reports pause/play transitions as
  heartbeat state edges. Older desktops without the route are detected
  and left alone.
- Subtitle menu → **Off** — the extension's own captions off-switch,
  per video (resets to Auto on navigation). Previously the only way to
  dismiss the overlay was YouTube's CC button, which YouTube omits on
  videos without visible caption tracks — exactly where the extension
  can still show cues (hidden auto-generated tracks) or OCR: the
  overlay was impossible to close there. While Off, the toolbar stays
  hover-revealable so the choice is reversible.
- OCR mode for burned-in (hardcoded) subtitles on YouTube — an OCR button
  in the player's control bar right next to YouTube's own CC button (also
  Subtitle menu → "OCR: burned-in subs (AI)"). On first enable you drag a box
  over the area where the subtitles live (Esc keeps the default bottom
  strip; redo anytime via the ⛶ Region chip; persisted). The extension
  samples that region, detects subtitle changes locally with a cheap
  bright-pixel signature (no network while a line sits on screen, none at
  all while the region is empty), and reads changed frames with your own
  AI key's vision model (Options → AI; OpenAI / Anthropic / Gemini).
  Recognized lines render as the usual interactive caption bar — word
  clicks, readings, known-word colours, analyze, the transcript sidebar,
  and mining (with timing for A/V clips) all work — anchored to the
  opposite side of the player from the capture region so it never covers
  the burned-in text; the translation line rides the existing translate
  engine. The Subtitle menu now also shows on videos with no caption tracks
  at all — exactly where OCR is needed — with the toolbar revealed on
  hover. No AI key required: Options → AI → Local OCR downloads a
  tesseract language pack once (~10–20 MB, runs as WebAssembly in an
  offscreen document with binarized frame crops) and OCR then works fully
  offline and free; the engine picker chooses Auto (local when
  downloaded, else AI), local-only, or AI-only. With the local engine the
  pipeline is tuned for latency: 4 Hz change detection, recognition
  cropped to the text's own bounding box, in-page binarization, a direct
  hop to the OCR host, and a pre-warmed worker — a line typically shows
  within a few hundred milliseconds of appearing.
- The "Blur EN" toggle grew into a three-state EN pill: show / blur /
  off. Off removes the display-language line everywhere (overlay,
  sidebar, mining) AND stops the work behind it — no translate calls in
  OCR mode, and the caption hook skips its translated-track hunting
  entirely (the flicker-prone part of track selection). Persisted, and
  re-enabling mid-video re-runs a selection round so the EN line comes
  back without a reload.
- Disney+ dual-subtitle support, same treatment as Netflix: the harvester
  sniffs the HLS master playlist for subtitle renditions and fetches the
  selected track's WebVTT segments itself, so the native + translation
  lines work regardless of (and without) Disney's own subtitle setting.
  Tokenized click-to-define words, readings, and the translation line
  underneath — subtitle text only, the DRM-protected stream is untouched.
  The Netflix overlay was generalized into one shared component both sites
  configure.
- bilibili.tv (BiliIntl) dual subtitles — OCR-only for now, since most
  content there ships burned-in subs. A "Tokori OCR" pill over the player
  turns on the same pipeline the YouTube OCR mode uses (drag a capture
  region once — persisted separately per site — then local tesseract or
  your AI key reads changed frames): clickable tokenized words with
  readings, and an auto-translated line underneath via your translate
  engine. Players that block frame capture (DRM / plain cross-origin
  sources) now report "frame capture blocked" instead of watching
  forever.
- Immersion time tracking (study mode): a ⏱ pill in the YouTube caption
  toolbar starts/stops a session that accrues time while a video from your
  watch library actually plays (optionally wall-clock via the new "keep
  counting while paused" setting). Only library videos count: a session left
  running while browsing other videos accrues nothing — the pill flips to a
  paused ⏸ hint — and each heartbeat is attributed to the video the time was
  actually watched on, not whatever page was open when it flushed. A
  dedicated statistics page (popup → Stats) shows today / 7-day / 30-day /
  all-time totals, a 14-day chart, and the session log; sessions can be
  deleted from the log (the time is returned from all totals — a copy
  already mirrored to the desktop stays there). All stored locally, no
  account needed. When the Tokori desktop is paired, starting
  the timer also starts a LIVE "video" session in the desktop's own session
  tracking (heartbeat-refreshed, finished with the video title), so the
  desktop dashboard, heatmap, streak, and Activities view include the time;
  a one-shot completed-session log remains the fallback for desktops
  without the live API.
- Documentation: README rebuilt around real screenshots (`docs/`), plus
  `docs/ARCHITECTURE.md` describing the surfaces, caption pipeline, OCR
  pipeline, and background caches. Builds now ship the tesseract.js
  Apache-2.0 license texts alongside the OCR runtime.
- Subtitle track menu — the single caption-source control, with the same
  choices as YouTube's own CC menu: Auto (the extension's pick for your
  target language), any of the video's real caption tracks verbatim
  ("original"), or any auto-translate language for the native line. The
  per-video CC language picker is gone; the target language (auto track
  pick, dictionary, highlighting) is the one set in Options → General, and
  open YouTube tabs follow an Options change live.

### Fixed

- YouTube videos that aren't in the workspace language are now left
  alone. Auto mode used to force YouTube's auto-translation of some
  base track into the target language on such videos, which broke in
  every direction at once: YouTube's own CC menu showed the selection
  as "… → undefined" (the translation was activated without its
  `languageName`, sometimes into a language the player doesn't even
  offer), untranslatable tracks produced no cues at all, YouTube's own
  rendering of machine-translated tracks can pile the entire transcript
  on screen as one block of text, and on videos with real English subs
  the overlay hid YouTube's native captions while rendering nothing —
  so even the English CC disappeared. Auto now engages only when the
  video actually has a caption track in the target language (the zh
  Hant→Hans handling included); otherwise the extension stands down for
  that video — no track steering, no overlay, stock YouTube captions —
  with a hover hint ("No Chinese CC") and the Subtitle menu still
  offering the explicit ways in: an Auto-translate language, a specific
  caption track, or OCR. Entering hands-off also unwinds any
  auto-translate track left active by earlier steering, so the
  whole-transcript pile-up can't linger. Translations the extension
  still activates (Hant→Hans, menu pins, the English-line hunt) now
  carry the full `translationLanguage` entry from the player's own
  list, so YouTube's menu names them properly instead of "undefined",
  and translate attempts are skipped entirely when the player doesn't
  offer the language.
- The player-bar OCR button now appears on live streams: `/live/<id>`
  URLs carry no `?v=` query, and the watch-page gate read only the
  query string, so every live stream silently lost the button.
- A crashed surface now heals itself: the site enhancers ride host-page
  DOM that shifts under A/B tests, and one transient render/effect
  exception used to unmount that surface for good — on YouTube that
  reads as "the OCR button (and overlay) never appeared" until a manual
  tab reload. The error boundary now remounts the surface after 4 s, up
  to 3 tries per page, so a one-off DOM race costs seconds, not the
  session.
- Local OCR now reads burned-in subtitles over BRIGHT scenes (sky, white
  walls, light clothing). Both halves of the pipeline keyed on "bright
  pixel = subtitle": the change detector's signature saturated over a
  bright strip (white text appearing barely moved any cell, so frames
  were never sent — or, with no text at all, were sent constantly), and
  the binarizer turned the whole strip into a black slab that tesseract
  read as noise (`conf=0`, stray digits). Detection now keys on
  outlined-bright pixels (bright with dark nearby), and extraction
  additionally requires fill to be sealed inside its outline (a border
  flood over non-dark pixels separates glyph fill from the scene rim
  hugging the outline), followed by speck removal and a per-row density
  gate; on dark scenes both collapse to the previous behaviour. Local
  crops are also no longer downscaled to the AI path's 800 px cap —
  full-resolution glyphs keep their outline structure intact. Verified
  end-to-end (Chromium + Brave): a white-sky worst case goes from
  "nothing, forever" to confidence 72–91 reads; dark scenes are
  unchanged at 90+.
- The tesseract worker no longer spams the extension's Errors page with
  red `Warning: Parameter not found: language_model_ngram_on` (& co)
  entries on every OCR engine start. The LSTM-only core prints these
  via `console.error` while parsing legacy-engine parameters embedded
  in the traineddata config — harmless, recognition is unaffected — so
  `copy-tesseract.mjs` now mutes exactly that class inside the shipped
  worker.
- YouTube captions that "sometimes" never appeared even on a captioned
  video are now recovered instead of lost. The MAIN-world cue script
  runs at `document_start` and could capture — and dispatch — a video's
  cues before the overlay (which mounts at `document_idle`, after a React
  commit) had added its listeners; because each cue line was emitted
  exactly once, that first dispatch landed in the void and captions
  never showed until a navigation. The equivalent race hit the
  target-language handshake too: a timedtext body the player fetched
  before the content script reported the study language was dropped and
  only ever recovered by a fragile, rate-limit-prone track "excursion"
  refetch (and never at all when the English line was off). The script
  now retains every timedtext body it sees (keyed by URL, per video) and
  re-serves it — with no player refetch — whenever the target settles, a
  track is pinned, or the overlay asks for a replay on mount (the same
  retain-and-replay model the Netflix/Disney paths already use). A
  pinned track the player had already fetched now shows instantly from
  that cache instead of triggering an excursion.
- Reloading/updating the extension used to leave already-open tabs
  silently dead ("the extension stopped loading") — the orphaned
  content script can't reach the extension anymore, but nothing said
  so. A small toast now appears in affected tabs naming the fix, with a
  one-click Reload.
- The hunt for the EN translated line is now budgeted at six excursions
  per video (it previously kept flipping tracks across every retry
  round). Each excursion costs two `/api/timedtext` fetches, and
  YouTube rate-limits that endpoint — on a video whose EN line simply
  wasn't available, the unbounded hunt could get the whole session
  rate-limited (empty caption responses everywhere, which looks like
  the extension dying). Verified against live YouTube that telemetry
  beacon counts (the `ERR_BLOCKED_BY_CLIENT` console noise with
  ad-blockers) are the same with and without the extension — that spam
  is the ad-blocker eating YouTube's own analytics, not us.
- YouTube subtitles stopped appearing entirely on current player builds
  (Subtitle menu stuck on "Auto", no cues) — two independent breakages
  from a YouTube player update, both fixed:
  - `getOption('captions','tracklist')` now returns an empty array even
    while a track is actively rendering, which starved the whole track
    selection pipeline (no resting pick, no menu, no steering). Track +
    auto-translate lists are now read from `getPlayerResponse()` as a
    fallback — `setOption('captions','track', …)` accepts tracks built
    from those fields, verified against the live player.
  - The cue capture (fetch/XHR hooks) ran at `document_idle`, but the
    new player captures its network functions early — the hooks were
    installed too late to ever see a timedtext response. The MAIN-world
    script now runs at `document_start` (like the Netflix/Disney ones),
    and the XHR hook reads the body through whatever `responseType` the
    player uses instead of assuming text.
- Turning YouTube's CC button off could freeze caption selection for the
  NEXT video: the CC-state mirror carried its last reading across SPA
  navigations, so the player re-applying a sticky CC-off preference
  while re-initializing was misread as the user dismissing captions
  (`ccUserOff`), silently killing track selection. The mirror now
  baselines per video, ignores on→off flips within a 5s post-navigation
  settling window unless they follow a real CC gesture (button click or
  the "c" shortcut — the shortcut now also syncs the overlay instantly),
  and picking any source from the overlay's Subtitle menu lifts a
  standing CC-off veto.
- Toggling YouTube's CC button off now hides the whole caption overlay —
  toolbar included — instead of leaving a hover-revealed bar floating
  over the video. OCR mode is exempt (it owns the overlay independently
  and stays reachable from the player-bar OCR button).
- Saving a mined card with an A/V clip (mining modal or sentence
  analyzer) failed against the desktop with "audio_data is not valid
  base64", and the same clip landed in Anki corrupted: the recorded
  WebM's MIME carries codec params (`video/webm;codecs=vp9,opus`), and
  the data-URL prefix was cut at the FIRST comma — inside the codec
  list — instead of at the `;base64,` marker, shipping
  `opus;base64,GkXf…` as the payload. Both save paths now share one
  prefix-stripper that cuts at the marker.
- With the EN line off, pinning the already-active track (from either
  menu) could leave the overlay blank: a same-track selection doesn't
  refetch, and there is no translated-line excursion to recover the
  cues. Selection rounds now reload the caption track data outright
  while the EN line is off.
- Videos opened while YouTube's sticky CC preference was OFF never showed
  any Tokori captions ("Subtitle: Auto" with nothing underneath, even on
  captioned videos): the player doesn't load its captions module until CC
  turns on, so the tracklist read empty and track selection gave up. The
  selection round now force-loads the captions module when the tracklist
  reads empty, and turning CC on later (after the bounded retries expired)
  restarts selection instead of staying dead until the next navigation.
- The no-target-track fallback ("auto-translate into your target/workspace
  language") could silently produce no captions when the English/first
  track wasn't translatable: the base track now prefers a translatable
  one. The whole resting-pick ladder (target track → zh Hant→Hans
  translation → auto-translate a base track) moved to a pure, unit-tested
  module (`lib/yt-track-pick`).
- On some YouTube layouts (playlist pages among them) the whole extension
  UI failed to appear: the player-bar OCR button was inserted next to a CC
  button that sits inside a wrapper there, the `insertBefore` threw, and
  the error unmounted the entire content tree. The injection now anchors
  on the correct direct child, never throws out of the attach loop, and —
  belt and braces — every surface (YouTube, Netflix, Disney+, popup,
  analyzer, miner) is wrapped in its own crash boundary, so one site's
  DOM experiment can no longer take everything else down.
- Turning YouTube's CC button off used to remove the whole caption
  toolbar with it, leaving no way back into the Subtitle/OCR controls
  from the player. The caption LINES still follow the CC toggle, but the
  toolbar now stays mounted and reveals on hover.
- The player-bar OCR button sat slightly off the row of YouTube's own
  control-bar icons (a text-only button among SVG buttons is at the
  mercy of baseline alignment and the bar's inherited line-height) — its
  label is now flex-centered and the button pinned flush with its
  neighbours.
- Switching YouTube videos sometimes kept showing the PREVIOUS video's
  captions — worst when opening a video from a link. Two causes: the cue
  overlay never dropped the old transcript on navigation (it kept matching
  the old lines against the new video's clock), and a caption response for
  the old video landing after the switch was mistaken for the new video's
  track, which also blocked the real one from loading for the whole retry
  round. Cue responses are now checked against the video id they belong to,
  cue events carry that id, the overlay clears its state the moment the
  video id changes, and a watch page whose caption round never ran (e.g.
  language changed while off a watch page, or a missed navigation event)
  now self-heals within a second.
  desktop: the clip was sent twice (as `audio_data` and a legacy `clip_data`
  copy the desktop ignores), pushing the request past the desktop's 2 MB
  body limit (HTTP 413). The clip is now sent once, and the desktop
  (2026-07 build) accepts larger bodies. The mining modal now also names
  which save target failed and why, instead of a generic "one or more
  targets failed".
- The theater-mode caption sidebar no longer stays pinned on top of the
  comments when scrolling: it now lives in the page itself beside the
  player (like YouTube's live chat), scrolls away with it, and passes under
  the masthead instead of floating above everything.
- Known-word highlighting missed early-learned words (e.g. 在) in workspaces
  with more than 500 vocab entries: the desktop `/vocab` route caps responses
  at the newest 500 rows, silently dropping the oldest — typically most
  mastered — words. The refresh now fetches each SRS status on its own
  500-row budget and merges.
- A brief desktop/cloud outage no longer wipes caption colours mid-video —
  the last good known-words map keeps serving (with the error surfaced in
  the vocab pill) until a refresh succeeds.

### Changed

- OCR line stability: consecutive reads of the SAME on-screen line that
  differ by a glyph or two (engine noise) no longer close and reopen
  the cue — the open cue updates in place and the higher-confidence
  read wins, so the displayed line stops flickering between variants
  and the transcript stops collecting one cue per misread. Short lines
  (< 4 glyphs) are exempt — 他来了 / 她来了 are different lines.
- OCR latency: the change detector now reacts to a 2-cell signature
  flip (was 5) — dialogue that cuts straight from line to line without
  a blank gap was previously missed until the next big change, showing
  the stale line for seconds. Local recognition runs 30-110 ms per
  frame at full resolution (now logged per read in the offscreen
  console), so extra sensitivity costs nothing.
- Picking a caption track or auto-translate language in YouTube's OWN
  settings menu now carries over to the Tokori overlay: the choice is
  adopted as a pin (the Subtitle pill follows, the caption lines switch
  to that source). Previously the two menus could disagree — the native
  pick's cues were classified away while the overlay kept showing the
  old track, or the next translated-line excursion simply reverted the
  pick. Detection is steering-aware: only a settled, repeated read that
  belongs to the video's own track/translate lists counts as a user
  pick, so the automatic selection dance can't false-positive it.
- The YouTube caption toolbar's track picker is now labelled "Subtitle"
  and lands on the concrete entry the automatic pick resolved to — the
  target-language caption track, or the auto-translate language it fell
  back to — instead of resting on an opaque "Auto" (same feel as the
  Netflix/Disney+ "Native" select). Reflection only: the automatic
  pick's fallback ladder (zh script handling, Hant→Hans translation,
  auto-translate) stays in charge until you pin something yourself.
- Known-words loading is now instant after the service worker idles out: the
  map is persisted to `chrome.storage.local` and served stale-while-revalidate
  instead of blocking every consumer on a network round trip. Refreshes are
  pushed to open tabs through the snapshot write itself, the cache is
  pre-warmed as soon as a YouTube navigation starts, and the fixed 5-minute
  refresh alarm and 30-second caption poll are gone (network is only hit
  while something is actually reading).

## [0.1.0] - 2026-07-02

First public release.

### Added

- Local-first hover dictionary (CC-CEDICT, JMdict, Yomitan imports), YouTube
  caption enhancer, send-to-Tokori actions, Anki export via AnkiConnect, and
  optional Tokori desktop pairing / cloud sync.

- Desktop-parity word popup: New / Learning / Review / Known status grading,
  text-to-speech, add-to-collection ("+ List"), and AI **Generate definition**
  for dictionary misses (persisted to a per-language personal dictionary).
  Works against the paired desktop app or a signed-in cloud account.
- Per-status caption colors on YouTube (rose / amber / sky / emerald, matching
  the desktop) with an underline vs. colour-the-characters mode.
- Pinyin / furigana ruby over captions, the transcript sidebar, and the
  analyzer — per-character alignment with tone colours (Pleco palette).
- Caption sidebar (asbplayer-style transcript): timestamps, click-to-seek,
  auto-follow, copy / analyze / mine row actions, English-blur with
  click-to-reveal, live-chat-style beside-the-player layout in theater mode,
  and fullscreen support.
- Sentence analyzer redesigned to match the Tokori desktop dialog: Plain /
  Linguist modes, translation + AI summary section cards, word-in-context
  explanations, and a ‹ › pager that steps through subtitle lines while
  seeking the video.
- Bring-your-own AI keys: explain sentences with your own OpenAI, Anthropic, or
  Gemini key. Keys are stored in `chrome.storage.local` and calls go straight to
  the provider — never through Tokori servers.
- Sentence mining: capture a screenshot and short A/V clip from the source video,
  cloze-mark the studied word, and fan the card out to Anki / Tokori desktop / cloud.
  Clips are also stored as card audio on the Tokori desktop.
- ESLint, Prettier, and a Vitest test suite; GitHub Actions CI.

### Fixed

- YouTube's native CC button now reliably hides/restores the custom subtitles
  (track selection no longer re-enables captions the user just turned off).
- Known-word highlighting survives MV3 service-worker restarts (lazy cache
  refresh) and reports fetch problems in the caption toolbar instead of
  failing silently; workspaces are auto-adopted after pairing / sign-in.
- Clicks inside the dictionary popup no longer dismiss it (shadow-DOM event
  retargeting).

[Unreleased]: https://github.com/tokoriai/tokori-chrome-extension/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/tokoriai/tokori-chrome-extension/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tokoriai/tokori-chrome-extension/releases/tag/v0.1.0
