# Tokori Companion

A browser extension for language learners. Hover over text on any website for
dictionary definitions, mine YouTube subtitles into flashcards, and export to
Anki — all local-first. Optionally pair it with the [Tokori](https://tokori.ai)
desktop app or cloud account to sync vocabulary, send articles to your reader,
and explain sentences with AI.

[![CI](https://github.com/tokoriai/tokori-chrome-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/tokoriai/tokori-chrome-extension/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Built with Manifest V3, React 18, TypeScript, Vite, and
[@crxjs/vite-plugin](https://crxjs.dev/).

Part of the **Tokori** project — the local-first AI language-learning app:

- 🖥️ [`tokoriai/tokori`](https://github.com/tokoriai/tokori) — the main desktop
  app (Tauri). Pair it with this extension for workspace sync, jieba
  tokenization, desktop dictionaries, and its AI providers.
- 🧩 `tokoriai/tokori-chrome-extension` — this repo, the browser companion.
- ☁️ [tokori.ai](https://tokori.ai) — the hosted cloud (optional).

> **Status:** pre-1.0. It works, but expect rough edges and breaking changes.

## Features

### Works out of the box (no account needed)

- **Local-first hover dictionary.** Install CC-CEDICT (Chinese) or JMdict
  (Japanese) from the options page and lookups run entirely from IndexedDB.
  Yomitan-format `.zip` dictionaries work too — just drop one in.
- **YouTube caption enhancer.** Overlays a dual-language subtitle strip on the
  video (English always under the target language, blur-until-click optional),
  with per-character **pinyin / furigana ruby** in tone colours and a
  click-any-word dictionary. Follows the player's native CC button.
- **Caption sidebar.** An asbplayer-style transcript beside the video —
  timestamps, click-to-seek, auto-follow, copy / analyze / mine per line —
  docked in the default view, live-chat-style next to the theater player, and
  overlaid in fullscreen.
- **Sentence analyzer.** The desktop app's analyzer dialog in the browser:
  translation, AI summary, word-in-context explanations, Leipzig-gloss mode,
  and ‹ › paging through subtitle lines that seeks the video along.
- **Sentence mining.** Capture a screenshot and a short A/V clip from the source
  video, cloze-mark the studied word, and turn it into a flashcard.
- **Anki export.** Saves cards through [AnkiConnect](https://foosoft.net/projects/anki-connect/),
  with a configurable field map and a one-click Migaku-style note-type preset.
- **Bring-your-own AI keys.** Explain sentences with your own OpenAI, Anthropic,
  or Gemini key. Keys live in `chrome.storage.local` and requests go **straight
  to the provider** — never through Tokori servers.

### With Tokori desktop or cloud (optional)

- **Sync vocabulary** to a Tokori workspace, in addition to (or instead of) Anki.
- **Grade words in place.** The word popup mirrors the desktop's: a
  New / Learning / Review / Known status grid, text-to-speech, add-to-collection,
  and an AI **Generate definition** for words no dictionary knows (saved to a
  personal dictionary for next time).
- **Highlight known words** in captions and pages, colored by study status
  (rose / amber / sky / emerald — underlines, or the characters themselves).
- **Send to Tokori.** Push the current article to your Tokori reader, or a
  YouTube video to your library.
- **AI fallback.** If you haven't set your own key, sentence explanations can run
  through the paired desktop app or your signed-in cloud account instead.

## Screenshots

> _TODO: add screenshots of the hover popup, YouTube overlay, and options page._

## Install

This isn't on the Chrome Web Store yet. Either grab a build from
[**Releases**](https://github.com/tokoriai/tokori-chrome-extension/releases)
(download the `.zip`, unzip it) or build from source:

```bash
git clone https://github.com/tokoriai/tokori-chrome-extension.git
cd tokori-chrome-extension
npm install
npm run build
```

Then load it:

1. Open `chrome://extensions` and enable **Developer mode** (top-right).
2. Click **Load unpacked** and select the `dist/` folder.
3. Pin the extension and open its **Options** to install a dictionary and pick
   your save targets.

## Usage

Open the options page (right-click the icon → **Options**) to configure:

| Panel            | What it does                                                 |
| ---------------- | ------------------------------------------------------------ |
| **General**      | Default language, hover vs. click trigger.                   |
| **AI**           | Your OpenAI / Anthropic / Gemini key and model (optional).   |
| **Anki**         | Deck, note type, and field mapping; Migaku preset installer. |
| **Dictionaries** | Download CC-CEDICT / JMdict, or import a Yomitan `.zip`.     |
| **Mining**       | Screenshot/clip capture defaults and cloze marking.          |
| **Desktop**      | Pair with the Tokori desktop app's local bridge.             |
| **Cloud**        | Sign in to a Tokori cloud account and pick a workspace.      |

## How it talks to Tokori (optional)

The extension is fully functional without Tokori — dictionaries and Anki export
need no account. Pairing just unlocks the sync features above.

- **Desktop:** the Tokori desktop app exposes a local HTTP bridge on
  `127.0.0.1:53210`. Pairing exchanges a bearer token (shown in the desktop app's
  _Settings → Local API_) so the extension can read your workspace and write
  vocabulary, dictionary lookups, and tokenization to it.
- **Cloud:** signing in stores a bearer token for `api.tokori.ai`, used for
  vocabulary, library, and reader-doc writes.

Some imports (reader docs, library items) are cloud-only today; the extension
surfaces a clear message and points you at the cloud target when an action isn't
available on the local bridge.

## Privacy

- API keys and tokens are stored only in `chrome.storage.local` — **never**
  synced through your browser profile, and never logged.
- BYO AI requests go directly to the provider you choose, from the extension's
  background worker. They are not proxied through Tokori.
- The extension performs **no analytics or telemetry**.

See [SECURITY.md](./SECURITY.md) for the full security model and how to report
issues.

## Project layout

```
src/
  background.ts        # MV3 service worker — message router between all surfaces
  content/             # shadow-DOM React app injected into pages
    HoverPopup.tsx     #   click/hover-to-define popover
    YouTubeEnhancer.tsx#   dual-language caption overlay
    SentenceAnalyzerModal.tsx, MiningModal.tsx
    youtube-cues.ts    #   MAIN-world hook capturing the player's caption fetches
  lib/                 # framework-agnostic logic
    settings.ts        #   config schema + storage helpers
    anki.ts            #   AnkiConnect bridge
    ai-providers.ts    #   OpenAI / Anthropic / Gemini + free-translate fallback
    languages.ts       #   language registry + script detection
    tokori-cloud.ts, tokori-local.ts   # Tokori REST / IPC clients
    dictionaries/      #   dict registry, IndexedDB layer, importers
    mining/            #   frame + clip capture
  popup/               # toolbar popup (quick status)
  options/             # full settings page
  welcome/             # first-run onboarding
  components/ui/        # shadcn/ui primitives
```

## Development

```bash
npm install
npm run dev          # Vite dev server with @crxjs hot reload
npm run build        # type-check + production build → dist/

npm run check        # typecheck + lint + format + tests (what CI runs)
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow and conventions.

## Acknowledgements

- The architecture and several patterns are indebted to the **hanpanda** Chrome
  extension, which this project generalizes across the languages Tokori supports.
- Dictionary data: **[CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cc-cedict)**
  (CC BY-SA 4.0) and **[JMdict](https://www.edrdg.org/jmdict/j_jmdict.html)** /
  EDICT (© EDRDG, CC BY-SA 4.0). Yomitan dictionary format by the
  [Yomitan](https://github.com/yomidevs/yomitan) project.
- Card export via **[AnkiConnect](https://foosoft.net/projects/anki-connect/)**.
- UI built with **[shadcn/ui](https://ui.shadcn.com/)**,
  **[Radix UI](https://www.radix-ui.com/)**, and
  **[Lucide](https://lucide.dev/)** icons.

## License

[MIT](./LICENSE)
