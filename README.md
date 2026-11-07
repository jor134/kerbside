# Kerbside

One GitHub repo, one Cloudflare Worker. The Worker serves the app, runs the F1 live-timing relay, stores shared circuit outlines, and hosts online drive races and watch-together rooms.

## Repo layout

```
wrangler.toml
src/worker.js
src/forecast-worker.js
public/index.html
public/drive.js
public/hang.js
public/garage.js
public/forecast-panel.js
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

## Circuit weather and alerts

The menu's **Circuit weather** section shows the forecast for each session of the next Grand Prix (in your own time zone), with a matching sign at the table and a line on the headset panel. The Worker checks every 15 minutes, from 9 days before the weekend.

- **Turn on alerts** on each device you want them on. Pick any of: rain expected during a session, a daily 8 am forecast on race weekends, rain at the circuit within the hour, strong wind (gusts 60 km/h+), heat (35 °C+) or storms, and any change in a session's forecast. More than three at once arrive as one summary.
- iPad and iPhone: alerts only work from the Home Screen app (Share → Add to Home Screen, then open Kerbside from there).
- Anyone with your relay key (your share link) can turn alerts on. Nothing to set up in Cloudflare: the Worker makes its own signing keys the first time.
- Forecasts: Open-Meteo, for the town the circuit is named after (within about 10 km of the track). Schedule: OpenF1.
- Check it any time at `/weather`; force a check with `/weather/run?key=<RELAY_KEY>`.

## Circuits saved on Cloudflare

The Worker saves every circuit's outline ahead of time, so the track still loads when OpenF1 locks its free data (from about 30 minutes before a session until 30 minutes after).

- Once an hour (the first of the 15-minute runs in `wrangler.toml`'s `[triggers]`), it finds the most recent race at each circuit from the last three seasons and saves an outline from one lap. It saves a few circuits per run, so a fresh deploy has them all within about two hours. After that it only refreshes a circuit when a newer race has been run there, which keeps changed layouts up to date.
- Don't want to wait after the first deploy? Open `/tracks/fill?key=<RELAY_KEY>` a couple of times; each visit saves more.
- See what's saved at `/tracks` (no key needed). Circuits are numbered as OpenF1 numbers them.
- Reading outlines needs no key, so Replay finds them for anyone. Saving one does. A device only fills a gap, or replaces an outline it found doesn't match the live cars.
- A brand-new circuit has no data until its first session. During that first live session the app still draws it from the leader's first lap and saves it.

## Drive mode

"Drive this circuit" in the menu loads `drive.js` and races on whichever circuit is loaded.

- **Race types:** time trial (with your best-lap ghost), the real field's fastest laps from an OpenF1 session (ghosts, no contact), computer rivals, or online with a 4-letter room code.
- **Online:** uses the relay and its key, so friends need your share link first. Up to 12 players a room. The host picks the circuit and laps and starts the race.
- **Controls:** iPad tilt or on-screen buttons with pedals; keyboard; Bluetooth game controller; Quest controllers as a wheel or thumbstick; Quest hand tracking (both hands as a wheel, pinch right for throttle, left for brake).
- **Views:** cockpit, chase, and a table-top RC view. In the headset, cockpit and chase are full size with a comfort vignette; the table view drives a miniature car on your real table.
- **Headset buttons:** B or Y opens the menu, pressing a thumbstick in recentres the seat.

## Watch with friends (hangout and voice)

"Watch with friends" in the menu loads `hang.js`. Start a room, then use **Invite** to send a link (it includes your relay key and the room code). Up to 10 people; voice works best with 6 or fewer.

- Friends appear as avatars around your table in the Tabletop view: where they actually stand if they're in a headset, in a seat if they're on an iPad or phone.
- The host's choice of replay or live is followed by everyone with "Follow what the host watches" ticked. Live uses each person's own broadcast delay.
- Join before entering the headset: the microphone prompt can't appear inside it. In the headset, X on the left controller mutes and unmutes.
- Use headphones: microphones pick up your TV otherwise.

### Pit garage

Under View → Surroundings, choose **Pit garage** for a fully virtual team garage built around the circuit table, with the pit lane, pit wall and a grandstand out of the open front and a timing monitor on the gantry. On an iPad or phone it's the background behind the table.

- In the headset, place the table first (you see your real room while placing), then the garage forms around it. Turning the table doesn't turn the garage; **Turn garage** on the headset panel does.
- Your F1 TV browser window can float anywhere over it, as usual in the Quest browser:
  1. Enter mixed reality or VR in Kerbside and place the table.
  2. Press **Open F1 TV** on the headset panel (or use the link under Surroundings → "Watch your F1 TV stream in the headset"). It opens in its own window.
  3. Sign in, choose **Watch live**, and make the player full screen.
  4. Move the F1 TV window to the left window slot, then minimize the Kerbside window.
  5. Set **Broadcast delay** on the Live tab until the cars match the stream.

  If F1 TV won't open from inside the headset view, do steps 2 to 4 in the normal browser first, then enter the headset view.
- **TV window** cuts a window through the garage to your real room, so you can watch your real TV. **Place window**: point at the TV and pull the trigger. **Size** cycles small, medium and large. Needs mixed reality (passthrough).
- In a hangout, the host's choice of surroundings applies to everyone. The TV window stays personal.

### Voice on every network (Cloudflare TURN)

Without this, voice connects device to device and fails on some mobile, office and carrier networks.

1. Cloudflare dashboard → **Realtime** (may be listed as Calls) → **TURN Server** → **Create**. Give it a name.
2. It shows a **Turn Token ID** and an **API Token**. Copy both now; the token is only shown once.
3. Worker `kerbside` → Settings → Variables and Secrets → add two **Secrets**: `TURN_KEY_ID` (the Turn Token ID) and `TURN_KEY_API_TOKEN` (the API Token).
4. Check it: open `/ice?key=<RELAY_KEY>`. `"turn": true` means it's working.

The first 1,000 GB of TURN traffic each month is free. A voice stream is roughly 25 MB an hour.

## Getting the F1 TV token (unverified, may change)

1. Log in at f1tv.formula1.com in desktop Chrome.
2. DevTools → Application → Cookies → find the cookie named `login-session` on a formula1.com domain.
3. Paste its whole value into `F1TV_TOKEN`. The relay accepts the cookie value or the bare token inside it.

`/status` shows when the token expires. When positions stop and the status mentions a refused token, paste a fresh one.
