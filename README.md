# Kerbside

One GitHub repo, one Cloudflare Worker. The Worker serves the app, runs the F1 live-timing relay, stores shared circuit outlines, and hosts online drive races and watch-together rooms.

## Repo layout

```
wrangler.toml
src/worker.js
src/forecast-worker.js
src/poker.js
public/index.html
public/drive.js
public/hang.js
public/garage.js
public/forecast-panel.js
public/poker.js
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

Under View → Surroundings, choose **Pit garage** for a fully virtual team garage built around the circuit table, with a full pit row, pit lane, your team's pitwall stand, the main straight and a grandstand out of the open front. On an iPad or phone it's the background behind the table.

- In the headset, place the table first (you see your real room while placing), then the garage forms around it. Turning the table doesn't turn the garage; **Turn garage** on the headset panel does.
- Your F1 TV browser window can float anywhere over it, as usual in the Quest browser:
  1. Enter mixed reality or VR in Kerbside and place the table.
  2. Press **Open F1 TV** on the headset panel (or use the link under Surroundings → "Watch your F1 TV stream in the headset"). It opens in its own window.
  3. Sign in, choose **Watch live**, and make the player full screen.
  4. Move the F1 TV window to the left window slot, then minimize the Kerbside window.
  5. Set **Broadcast delay** on the Live tab until the cars match the stream.

  If F1 TV won't open from inside the headset view, do steps 2 to 4 in the normal browser first, then enter the headset view.
- **TV window** cuts a window through the garage to your real room, so you can watch your real TV. **Place window**: point at the TV and pull the trigger. **Size** cycles small, medium and large. Needs mixed reality (passthrough).
- **Screens.** The garage video wall shows timing, the track map, an onboard camera and the circuit weather. The pitwall row adds a TV-style helicopter camera. The onboard follows the car you're following; the TV camera follows the leader. These are Kerbside's own views of the 3D circuit: F1 TV's video can't be drawn into the scene.
- **Pitwall.** Choose **Pitwall ›** on the headset panel (or **On the pitwall** under Surroundings) to jump across the pit lane onto your team's stand; **‹ Back to garage** returns you. On an iPad or phone, drag to look around and pinch to zoom.
- **Cars.** Every car within about 270 m of the start/finish line drives past full size at its real speed, from the live or replay positions. Cars the timing shows in the pits use the pit lane, and stop in the working lane for their stop, at their real place along the pit lane.
- In a hangout, the host's choice of surroundings applies to everyone. The TV window and where you stand (garage or pitwall) stay personal; friends see you on the pitwall when you go there.

### Inside the car (drive mode, cockpit view)

The car you drive has an open cockpit you sit inside: padded floor and headrest, the rim of the cockpit opening, your chest, knees and arms, and a steering wheel with hand grips, paddles, buttons, dials and a screen showing shift lights, gear, speed and lap. Your arms and gloves turn with the wheel. Other cars keep the closed body with the driver's helmet.

### Shine and reflections

Surfaces have their own finish: car paint and helmets are glossy and mirror a sky with studio lights, glass and metal reflect, the garage floor is polished, asphalt has a faint sheen, and grass, felt and rubber stay matte. Satellite photos and screens are unchanged. If the headset's frame rate drops, switch **Shine and reflections** off under Surroundings.

### In the headset

- **Menu.** **Hide menu** puts the menu away. A round **MENU** button sits on the back of your left wrist: touch it with your right index finger (hand tracking), or point at it and click (controllers), and the menu appears in front of you. With no left hand in view while the menu is hidden, the button waits low in front of you.
- **Reset view.** A **RESET** button sits on the back of your right wrist: touch it with your left index finger, or point at it and click. It centres what you're doing on where you are and the way you're facing: the table (and the garage around it) moves in front of you; at the poker table your seat moves to you; on the pitwall you're put back on your spot; in drive mode the car is recentred.
- **Moving around the garage.** Pinch and hold (or hold the trigger) while pointing at the floor: a ring shows where you'll land, and letting go jumps you there. It works inside your garage and along the pit lane. A quick pinch still just clicks. The **RESET** button on your right wrist takes you back to the circuit table; the menu stays where it was, so use the left-wrist button to bring it to you.
- **Thumbsticks are off** unless you switch **Thumbsticks** on in the menu, so a nudge can't turn or resize the table. Use **Turn**, **Smaller** and **Bigger** on the menu instead. Steering with a thumbstick in drive mode is separate: choose it in the drive menu.
- **Invite friends** opens a room if you aren't in one and shows its 4-letter code; friends choose Watch with friends and enter it. The invite link is also copied, to paste in a message. The microphone prompt can't appear inside the headset view: a room started there connects without voice after a couple of seconds. Join a room once from the page to allow the mic, and voice works from then on.
- **Load a race** at the bottom of the headset menu lists finished sessions by year (the same list as the page); pick one to load it. **Go live** connects to the live timing.
- **Drive this circuit** opens drive mode without leaving the headset. Choose Time trial, AI race or **Race friends** on the drive menu. In a hangout with friends the button reads **Race friends here**: it sets up a race on your circuit and brings everyone in the hangout straight into it (on the page, Race friends → Create room does the same). You host and press Start. A friend who's in the middle of their own race gets a message instead.
- **Your hands** appear as gloves in the pit garage and casino. In your own room you see your real ones.
- Messages that appear as pop-ups on the page are shown on a small card in front of you.

### Casino and poker

Under Surroundings → Pit garage, choose **Casino** to dress the garage for a night in Vegas: carpet, neon, chandeliers, slot machines and a poker table at the back. In a hangout the host's choice applies to everyone; in the headset it's the **Casino** button on the panel.

**Poker** is no-limit Texas hold'em for up to six friends in a hangout, for chips with **no cash value**. Open it from the hangout card (**♠ Poker and race bets**).

- Everyone starts with 10,000 chips. Your stack is saved on your relay and follows you from race to race. If you run out, **Top up** brings you back to 10,000 (the leaderboard counts top-ups). Blinds are 50/100.
- You have 40 seconds to act; after that you check if you can, otherwise you fold and sit out until you press **I'm back**. If you drop out of the hangout you keep your seat for 45 seconds.
- **iPad, phone and computer:** the poker panel shows the table, your cards and the buttons. In the casino garage you also sit at the 3D table: drag to look around.
- **Practice bots:** **Practise with bots** (poker panel, or the seat panel in the headset) sits you down and fills three seats with bots; **+ Bot**, **Fill with bots** and **Remove bots** manage them. Sitting at a glowing seat when you're the only one in the room brings in three bots automatically. Bots play a simple game (bet strong hands, call when the price is right, the odd bluff), top themselves up when they bust and leave when you do. Chips you win or lose against them count towards your stack.
- **Glowing seats:** in the casino, in the headset, each poker chair has a glowing ring. Point at one and click (or pinch): it starts a room with friends if you aren't in one, and sits you there.
- **Starting from the headset:** **♠ Poker** on the headset menu starts a hangout if you aren't in one, opens the casino (if you're the host) and puts a panel at the poker table where you pick a seat. Cards are only dealt once two players are seated, so alone you'll see your chips but no cards.
- **Headset:** when you sit down you're moved to your chair at the table.
  - Pick up your cards (pinch, or grip button) to look at them; throw them into the middle to fold.
  - Take chips from the three trays in front of you (100, 500 and 1,000) and drop them in the gold circle; knock on the felt (a quick tap, down and up) to bet or call what's in the circle. Knock with nothing in the circle to check.
  - The action bar over the felt has the same buttons, for pointing and clicking.
  - **Place here** on the action bar: stand or sit where you want your seat to be in your real room (a real chair works well), face the way you want to face the table, and press it. The table is re-placed around you.

**Race bets** are pool bets on the race: everything staked is shared by whoever picked the winner, in proportion to their stake, and if nobody picked it everyone gets their stake back. The host opens them (**Next to pit**, **Leader in 3 laps**, **Safety car in the next 10 laps?**); betting stays open for a minute. The host's app settles them from the race on the host's screen, at the host's broadcast delay, so pick a host who's watching. The host can also call a bet off.

**Friends' race winner.** When friends race each other (Drive → Race friends), the race host can press **Open bets** in the lobby. Everyone in the hangout can back a driver until the race starts: 500 a press on the drive menu, or any amount under Race bets. The pool is paid when the race host finishes; if the race host leaves early the bet is called off and stakes are returned.

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

## Credits

Race car: "Ferrari F1 2019" by valvetin (https://sketchfab.com/3d-models/ferrari-f1-2019-1b050bffe4e749b586b4782ee7ff4fd0), CC BY 4.0, stripped to solid colours with every decal removed and simplified (`public/models/f1`, see its LICENSE.md). The built-in car stays if the model can't load.
