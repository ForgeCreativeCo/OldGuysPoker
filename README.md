# Old Guys Poker

8-seat Texas Hold'em in the browser. Play money only, 2.5D tables, live voice chat, and a computer dealer that runs every hand.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000, pick a name, then click any open seat (in the lobby or at the table) to buy in.

Want company while testing? Seat some bots at a table:

```bash
npm run bots -- porch 4
```

Table ids: `penny` (1/2), `porch` (5/10), `vfw` (10/20), `backroom` (25/50), `highroller` (100/200).

## How it works

- **Server** (`server/`): Node + Express + Socket.IO. The server holds all game state: shuffling (CSPRNG), blinds, turn order, side pots, showdowns and payouts. Clients only ever see their own hole cards until showdown.
  - `poker/table.js`: the dealer and table state machine
  - `poker/cards.js`: deck and hand evaluator
  - `store.js`: play-money bankrolls in `data/players.json` (10,000 to start, free refills)
- **Client** (`public/`): plain JS, no build step. The table is a CSS‑3D tilted felt. Cards lie flat, chips are real stacked discs, and the players are standees turned back up to face you.
- **Voice**: WebRTC audio mesh per table. The server only relays signaling. Speakers get a green glow on their seat.

## Rules and behavior

- Buy-in is 40–100 big blinds. Stand up any time and your stack goes back to your bankroll. If you stand mid-hand, your hand folds.
- You get 20s to act. When time runs out you check if you can, otherwise you fold. Two timeouts in a row sit you out.
- Disconnects: your seat is held for 90s. Reload and you're put right back in it.
- Keyboard: `F` fold, `C` check/call, `R` raise.

## Deploying: Netlify (page) + Render (game server)

Netlify hosts the web page and Render runs the game server. They're split because the dealer, tables, bots and voice-chat connection setup need a server that stays running, and Netlify only serves static files.

**1. Render (game server)**
1. In Render, choose **New → Blueprint** and pick this repo. It reads [render.yaml](render.yaml): `npm start`, health check `/healthz`, free plan.
2. Note the service URL. If it isn't `https://oldguyspoker.onrender.com`, put the real one in `GAME_SERVER` in [public/config.js](public/config.js).
3. `ALLOWED_ORIGINS` lists the sites allowed to connect, comma-separated. Add your custom domain there if you get one.

**2. Netlify (web page)**
- [netlify.toml](netlify.toml) publishes `public/` with no build step, so a push to `main` redeploys automatically.

**Things to know**
- **Cold starts:** the free Render plan sleeps after about 15 minutes idle. The first visit after that shows "Waking up the game server…" for up to a minute.
- **Restarts don't lose chips:** when Render stops or restarts the server, everyone at a table gets their chips back in their bankroll first.
- **Bankrolls reset on redeploy:** they live in `data/players.json`, and Render's free disk is wiped on each deploy. To keep them, add a Render disk (paid plans only) and set `DATA_FILE` to a path on it, or move bankrolls to a database.
- **HTTPS:** both hosts provide it, and the microphone requires it.
- **Local dev:** nothing changes. `npm start` serves the page and the server together on localhost:3000.

### Voice
- Some players are on strict NATs, such as some mobile carriers or corporate networks. For their voice to connect you need a TURN server. Set `TURN_URL`, `TURN_USER` and `TURN_PASS`; coturn or a hosted TURN service both work.
- Mesh voice is fine for 8 people at a table. If you ever want bigger rooms, switch to an SFU such as LiveKit.

## Installing as an app (PWA)

In Chrome or Edge, use the install icon in the address bar. On a phone, use **Add to Home Screen**.

- The manifest `id` is fixed at `/apps/forgecreativeco-old-guys-poker` and doesn't depend on `start_url`. The browser keeps this install separate from any other installed game, and you can change the start URL later without breaking existing installs. Don't change the `id`: doing so creates a second app.
- `launch_handler: focus-existing` means opening the app again focuses the window you already have instead of starting another one.
- The service worker (`public/sw.js`) caches only the app shell, and only in caches named `ogp-*`. It never touches `/socket.io/`. To ship UI changes to installed apps, bump `VERSION` in `sw.js`.
- **One app per origin:** the app's scope is `/`. If you ever host another game on the *same* domain, put each game on its own path, give each its own `scope` and `start_url`, and keep the `id`s different. Otherwise links can open in the wrong app.

## Tests

```bash
npm test
```

The tests cover hand rankings and kickers, side-pot payouts, and a randomized multi-hand simulation that checks no chips are created or lost.

## Credits

Sound effects in `public/sounds/` (from Pixabay; check each sound's page for its license terms):
- `all-in.mp3`: "All In Push Chips" by freesound_community
- `card.mp3`: "Taking Playing Card" by oxidvideos
- `chips.mp3`: "Placing Poker Chips" by oxidvideos
