# Contributing to Tokori Companion

Thanks for your interest in improving the extension! This document covers how to
get a dev build running and the conventions we follow.

## Prerequisites

- **Node.js 20+** (an `.nvmrc` is provided — run `nvm use`).
- Google Chrome, Chromium, or any Chromium-based browser for loading the build.

## Getting started

```bash
git clone https://github.com/tokoriai/tokori-chrome-extension.git
cd tokori-extension
npm install
npm run dev      # Vite dev server with @crxjs hot reload
```

To load the extension:

1. Build it: `npm run build` (outputs to `dist/`).
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the `dist/` folder.

During `npm run dev`, @crxjs writes an unpacked build you can also load from
`dist/`; most edits hot-reload, but changes to `manifest.json` or the background
service worker need a reload from `chrome://extensions`.

## Quality gates

Everything below runs in CI. Run them locally before opening a PR:

```bash
npm run typecheck     # tsc, no emit
npm run lint          # ESLint (flat config)
npm run format:check  # Prettier
npm run test:run      # Vitest
npm run build         # production build

npm run check         # all of the above in one shot
```

Auto-fix what's fixable:

```bash
npm run lint:fix
npm run format
```

## Code style

- **TypeScript** everywhere, `strict` mode. Avoid `any`; prefer precise types or
  `unknown` with narrowing.
- **Formatting and linting are enforced** by Prettier + ESLint — don't hand-format.
- Match the existing house style: each module opens with a `/** … */` purpose
  docblock, and longer files use `// ── Section ──` comment dividers.
- React components are function components; follow the rules of hooks (the
  `react-hooks` ESLint plugin will flag violations).
- Keep secrets out of the repo and out of logs. User API keys and tokens live in
  `chrome.storage.local` and must never be logged or synced.

## Project layout

See the "Project layout" section of the [README](./README.md#project-layout) for
a map of `src/`.

## Commits & pull requests

- Keep PRs focused; one logical change per PR where practical.
- Describe what changed and why, and include before/after screenshots for UI
  changes.
- Update `CHANGELOG.md` under **Unreleased** for user-facing changes.
- Make sure `npm run check` passes.

## Reporting bugs & requesting features

Use the GitHub issue templates. For security issues, **do not** open a public
issue — see [SECURITY.md](./SECURITY.md).
