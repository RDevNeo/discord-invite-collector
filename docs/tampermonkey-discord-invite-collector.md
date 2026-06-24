# Tampermonkey Discord Invite Collector

This doc describes `discord-invite-collector.user.js`, the Tampermonkey userscript used on Discord web.

## What it is

The script scans Discord web pages for invite URLs and collects them into a local session list.

It is designed to avoid duplicates by checking against:

- the website's public server catalog
- the website's public blacklist catalog

The script is not the CRM itself. It is an external data-collection helper that runs in the browser.

## How it works

The userscript supports three collection contexts:

- sidebar mode
- Discover mode
- reader mode

Its main fetch path is:

- `GET /api/public/servers` from the deployed website
- `GET /api/public/blacklist` from the deployed website

From the code:

- `BOARD_API_BASE_URL` points at the deployed site that exposes the public API routes

The collector then:

- normalizes invite URLs
- checks them against the local catalog sets
- skips anything already known by the website catalog or blacklist
- keeps a temporary in-memory/localStorage state while the scan is running

## Why it exists

This script exists to automate invite harvesting from Discord web without manually copying each invite.

In practice it is used to:

- gather Discord invite URLs from public profiles
- run Discover-mode collection from Discord's server discovery pages
- keep the collected data clean by skipping duplicates already known to the site

## Important behavior

- It does not permanently write invites into the CRM by itself.
- It keeps a session list and local state for the current run.
- It relies on the deployed website being reachable.
- The script version is tracked in both the userscript metadata header and the `SCRIPT_VERSION` constant.

## Related files

- `discord-invite-collector.user.js`
- `README.md` for install and configuration
