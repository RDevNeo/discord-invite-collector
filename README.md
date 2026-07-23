# Discord Invite Collector

A [Tampermonkey](https://www.tampermonkey.net/) userscript that scans Discord web pages for server
invite URLs and collects them into a session list you can copy out in one click.

It is fully self-contained: no API, no database, no external requests. Whatever it finds stays in the
panel and in `localStorage` until you copy or clear it.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Click
   **[install the script](https://raw.githubusercontent.com/RDevNeo/discord-invite-collector/main/discord-invite-collector.user.js)**
   — Tampermonkey recognizes the `// ==UserScript==` header and opens its install prompt. (Installing
   from this URL is what registers the auto-update source; a copy-pasted script never updates itself.)
3. Open Discord web (`https://discord.com/*`) — the collector panel is injected on load.

Works on Discord **web** in any desktop browser with a userscript manager. It does not run inside the
Discord desktop app, which has no userscript support.

## Modes

| Mode | What it does |
| --- | --- |
| **Sidebar** | Walks every server in the sidebar, opens each member profile and reads invites from status, bio and profile links. |
| **Discover** | Searches Discord's Discover page for a term, opens each result and copies the invite URL from the "Invite to Server" dialog. A **Language** dropdown pins Discord's language filter; it defaults to *Any language*, which leaves the filter untouched. |
| **Reader** | Scrolls the current channel upward and collects invite URLs found in messages. |

Invite URLs are normalized to `https://discord.gg/<code>` and de-duplicated within the session. The log
pane shows only collected invites and failures.

## Auto-update

`@updateURL`/`@downloadURL` point straight at the raw file on `main` — no proxy, no token, no secrets.
On every push that changes the script, a GitHub Action (`.github/workflows/bump-version.yml`) bumps the
patch version, so Tampermonkey sees a new version on its next check (default: ~daily; forceable from the
dashboard). Push to `main` is all it takes to ship an update.

## Versioning

The script version lives in two places that must stay in sync: the `@version` field in the userscript
metadata header and the `SCRIPT_VERSION` constant in the body. The `bump-version` GitHub Action
increments **both** on each qualifying push, so you do not normally edit them by hand.

## Discover languages

The **Language** dropdown lists Discord's documented locales, each written in its own language, so the
options read the same whatever UI language you run. The list is built into the script rather than read
off the page, because Discord virtualizes its language dropdown — only the options scrolled into view
exist in the DOM at any moment. If Discover does not offer the language you pick, the scan says so in
the log and continues unfiltered instead of stopping.

## License

[MIT](LICENSE).
