# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" under the repository's **Security** tab), or email
**security@tokori.ai**.

We'll acknowledge your report as quickly as we can and keep you updated on a fix.

## Security model

The extension is built to keep your data on your machine:

- **API keys and tokens** (your BYO OpenAI/Anthropic/Gemini key, the Tokori cloud
  bearer token, and the Tokori desktop local-API token) are stored only in
  `chrome.storage.local`. They are **never** written to `chrome.storage.sync`, so
  they don't leave the device through profile sync, and they are never logged.
- **BYO AI requests go directly to the provider** you choose (e.g.
  `api.openai.com`) from the extension's background service worker. They are not
  proxied through Tokori servers.
- The extension makes **no analytics or telemetry calls**.
- Network access is limited to the hosts declared in `manifest.json`
  (`host_permissions`): the AI providers you may configure, AnkiConnect on
  `127.0.0.1`, the optional Tokori desktop bridge on `127.0.0.1`, the optional
  Tokori cloud API, and the dictionary download sources.

## Supported versions

This project is pre-1.0; security fixes are applied to the latest release only.
