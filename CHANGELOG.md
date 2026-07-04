# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

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

[Unreleased]: https://github.com/tokoriai/tokori-chrome-extension/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tokoriai/tokori-chrome-extension/releases/tag/v0.1.0
