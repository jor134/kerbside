# Kerbside

One GitHub repo, one Cloudflare Worker. The Worker serves the app, runs the F1 live-timing relay, stores shared circuit outlines and hosts online drive races.

## Repo layout

```
wrangler.toml
src/worker.js
public/index.html
public/drive.js
public/sw.js
public/manifest.webmanifest
public/icon-192.png
public/icon-512.png
```

## Deploy (GitHub web UI + Cloudflare dashboard only)

1. Create a GitHub repo `kerbside` and upload the files above in that layout.
2. Cloudflare dashboard: Workers & Pages → Create → Import a repository → pick `kerbside` → Deploy.
   Every push to GitHub redeploys automatically. New Durable Objects listed in `wrangler.toml` are created on deploy.
3. Worker → Settings → Variables and Secrets → add two **Secrets**:
   - `RELAY_KEY`: one or more long random strings, separated by commas. The app asks for one before connecting live or racing online.
   - `F1TV_TOKEN`: your F1 TV token (see below).
4. Open `https://kerbside.<your-subdomain>.workers.dev` on the Quest 3 or iPad. Leave "Relay address" blank; it uses the same site.
5. Check the relay any time at `/status?key=<RELAY_KEY>`.

## Drive mode

"Drive this circuit" in the menu loads `drive.js` and races on whichever circuit is loaded.

- **Race types:** time trial (with your best-lap ghost), the real field's fastest laps from an OpenF1 session (ghosts, no contact), computer rivals, or online with a 4-letter room code.
- **Online:** uses the relay and its key, so friends need your share link first. Up to 12 players a room. The host picks the circuit and laps and starts the race.
- **Controls:** iPad tilt or on-screen buttons with pedals; keyboard; Bluetooth game controller; Quest controllers as a wheel or thumbstick; Quest hand tracking (both hands as a wheel, pinch right for throttle, left for brake).
- **Views:** cockpit, chase, and a table-top RC view. In the headset, cockpit and chase are full size with a comfort vignette; the table view drives a miniature car on your real table.
- **Headset buttons:** B or Y opens the menu, pressing a thumbstick in recentres the seat.

## Getting the F1 TV token (unverified, may change)

1. Log in at f1tv.formula1.com in desktop Chrome.
2. DevTools → Application → Cookies → find the cookie named `login-session` on a formula1.com domain.
3. Paste its whole value into `F1TV_TOKEN`. The relay accepts the cookie value or the bare token inside it.

`/status` shows when the token expires. When positions stop and the status mentions a refused token, paste a fresh one.
