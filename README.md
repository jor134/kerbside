# Kerbside

One GitHub repo, one Cloudflare Worker. The Worker serves the app and runs the F1 live-timing relay.

## Repo layout

```
wrangler.toml
src/worker.js
public/index.html
public/sw.js
public/manifest.webmanifest
public/icon-192.png
public/icon-512.png
```

## Deploy (GitHub web UI + Cloudflare dashboard only)

1. Create a GitHub repo `kerbside` and upload the files above in that layout.
2. Cloudflare dashboard: Workers & Pages → Create → Import a repository → pick `kerbside` → Deploy.
   Every push to GitHub redeploys automatically.
3. Worker → Settings → Variables and Secrets → add two **Secrets**:
   - `RELAY_KEY`: any long random string. The app asks for it before connecting live.
   - `F1TV_TOKEN`: your F1 TV token (see below).
4. Open `https://kerbside.<your-subdomain>.workers.dev` on the Quest 3. Leave "Relay address" blank; it uses the same site.
5. Check the relay any time at `/status?key=<RELAY_KEY>`.

## Getting the F1 TV token (unverified, may change)

1. Log in at f1tv.formula1.com in desktop Chrome.
2. DevTools → Application → Cookies → find the cookie named `login-session` on a formula1.com domain.
3. Paste its whole value into `F1TV_TOKEN`. The relay accepts the cookie value or the bare token inside it.

`/status` shows when the token expires. When positions stop and the status mentions a refused token, paste a fresh one.
