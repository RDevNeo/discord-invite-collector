# Userscript delivery proxy

This is **reference documentation** for the auto-update mechanism. The actual proxy
lives in the `spokpay-crm` project (TanStack Start), at:

    src/routes/api.userscript.ts   →   https://spokpay-crm.vercel.app/api/userscript

It holds a read-only GitHub token server-side and serves the latest script from this
**private** repo, gated by a shared `?key=` secret — so Tampermonkey can auto-update
without the repo being public. The token never touches the userscript or this repo.

```
you push to main ──▶ GitHub Action bumps @version ──▶ commit on main
                                                          │
Tampermonkey ──GET /api/userscript?key=SECRET──▶ proxy ──GitHub API (token)──▶ main
   (daily check)                                  (checks key,   (private repo)
                                                   holds token)
```

## Setup (one-time)

1. **Fine-grained GitHub token** — Settings → Developer settings → Fine-grained tokens:
   resource owner `RDevNeo`, repository access **only** `discord-invite-collector`,
   permission **Contents → Read-only**.
2. **Vercel env vars** on the `spokpay-crm` project (Production + Preview):
   - `USERSCRIPT_KEY` = `589dab264b9024eb4ec66a3ddd7e834619a226048a2b7383`
   - `GH_USERSCRIPT_TOKEN` = the token from step 1
3. **Deploy** `spokpay-crm` (the route file is already added), then verify:
   ```bash
   curl -s "https://spokpay-crm.vercel.app/api/userscript?key=589dab264b9024eb4ec66a3ddd7e834619a226048a2b7383" | head -12   # script header
   curl -s -o /dev/null -w '%{http_code}\n' "https://spokpay-crm.vercel.app/api/userscript?key=wrong"                          # 403
   ```
4. **Install the script once** from the `?key=...` URL so Tampermonkey records the
   update source. After that, updates are automatic.

## Token expiry

Fine-grained tokens cap at ~1 year. When `GH_USERSCRIPT_TOKEN` expires the proxy
returns 502 and Tampermonkey keeps the last good version until you rotate it: generate
a new token with the same scope, update the Vercel env var, redeploy. No userscript
change needed.

## Rotating the `?key=` secret

The key only gates downloading this one script (revocable, low blast radius). To
rotate: pick a new value, update `USERSCRIPT_KEY` in Vercel **and** the `@updateURL` /
`@downloadURL` in `discord-invite-collector.user.js`, then push (the Action bumps the
version so installed copies pull the new URL on their next check).
