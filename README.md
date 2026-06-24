# Discord Invite Collector

A [Tampermonkey](https://www.tampermonkey.net/) userscript that scans Discord web
pages for server invite URLs and collects them into a session list, skipping any
invite that is already known to a companion website's public catalog or blacklist.

The script is **not** a CRM. It is an external, browser-side data-collection helper
that runs on `discord.com` and talks to a deployed website over its public API.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open `discord-invite-collector.user.js` in this repo and install it (Tampermonkey
   recognizes the `// ==UserScript==` header), or paste its contents into a new
   Tampermonkey script.
3. Open Discord web (`https://discord.com/*`) — the collector UI is injected on load.

## Configure

The script reads its API base from a single constant near the top of
`discord-invite-collector.user.js`:

```js
const CONFIG = {
  BOARD_API_BASE_URL: "https://spokpay-crm.vercel.app",
};
```

Point `BOARD_API_BASE_URL` at the deployed site that exposes the public API routes
(`/api/public/servers` and `/api/public/blacklist`). The `@connect` line in the
userscript header must match that host so Tampermonkey allows the cross-origin
`GM_xmlhttpRequest` calls.

## How it works

The collector supports three contexts — **sidebar**, **Discover**, and **reader**
modes. On each run it:

- fetches the website's public server catalog (`GET /api/public/servers`)
- fetches the website's public blacklist (`GET /api/public/blacklist`)
- normalizes invite URLs it finds in the page
- skips anything already known to the catalog or blacklist
- keeps a temporary in-memory / `localStorage` session list while scanning

It does not permanently write invites anywhere by itself — it produces a clean
session list and relies on the deployed website being reachable.

See [`docs/tampermonkey-discord-invite-collector.md`](docs/tampermonkey-discord-invite-collector.md)
for more detail.

## Auto-update

The userscript carries `@updateURL`/`@downloadURL` pointing at a small proxy on the
`spokpay-crm` Vercel app (`/api/userscript?key=...`). The proxy holds a read-only
GitHub token and serves the latest script from this **private** repo, so Tampermonkey
can auto-update without the repo being public. On every push that changes the script,
a GitHub Action (`.github/workflows/bump-version.yml`) bumps the patch version so
Tampermonkey detects the update on its next check (default: ~daily; forceable from the
dashboard).

Setup steps for the proxy + token live in [`vercel-proxy/README.md`](vercel-proxy/README.md).
Install the script once from the proxy URL so Tampermonkey records the update source;
after that, updates are automatic.

## Versioning

The script version lives in two places that must stay in sync: the `@version` field
in the userscript metadata header and the `SCRIPT_VERSION` constant in the body. The
`bump-version` GitHub Action increments **both** on each qualifying push, so you do not
normally edit them by hand.
