# Discord Invite Collector

A [Tampermonkey](https://www.tampermonkey.net/) userscript that scans Discord web pages for server
invite URLs and collects them into a session list you can copy out in one click.

It is fully self-contained: no API, no database, no external requests. Whatever it finds stays in the
panel and in `localStorage` until you copy or clear it.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open `discord-invite-collector.user.js` in this repo and install it (Tampermonkey recognizes the
   `// ==UserScript==` header), or paste its contents into a new Tampermonkey script.
3. Open Discord web (`https://discord.com/*`) — the collector panel is injected on load.

## Modes

| Mode | What it does |
| --- | --- |
| **Sidebar** | Walks every server in the sidebar, opens each member profile and reads invites from status, bio and profile links. |
| **Discover** | Searches Discord's Discover page for a term, opens each result and copies the invite URL from the "Invite to Server" dialog. |
| **Reader** | Scrolls the current channel upward and collects invite URLs found in messages. |

Invite URLs are normalized to `https://discord.gg/<code>` and de-duplicated within the session. The log
pane shows only collected invites and failures.

## Auto-update

The userscript carries `@updateURL`/`@downloadURL` pointing at a small proxy (`/api/userscript?key=...`)
that holds a read-only GitHub token and serves the latest script from this **private** repo, so
Tampermonkey can auto-update without the repo being public. On every push that changes the script, a
GitHub Action (`.github/workflows/bump-version.yml`) bumps the patch version so Tampermonkey detects the
update on its next check (default: ~daily; forceable from the dashboard).

Setup steps for the proxy + token live in [`vercel-proxy/README.md`](vercel-proxy/README.md). Install the
script once from the proxy URL so Tampermonkey records the update source; after that, `git push` is all
it takes to ship an update.

## Versioning

The script version lives in two places that must stay in sync: the `@version` field in the userscript
metadata header and the `SCRIPT_VERSION` constant in the body. The `bump-version` GitHub Action
increments **both** on each qualifying push, so you do not normally edit them by hand.
