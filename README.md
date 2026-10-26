# Best guess?

A party game for friends and family, played on everyone's own phone.

Each turn one player gets 5 random cards and ranks them from **1 (favorite)** to **5 (least favorite)** — pure opinion. Everyone else sees the same 5 cards and tries to guess that exact order. After the guessing, the ranking is revealed one card at a time, from #5 up to #1.

## Scoring

- Guessers get **+1 point for every card placed in exactly the right spot**.
- The ranker gets **+3 for each guesser who goes 5/5** (the bonus is only for the ranker, so it pays to rank honestly instead of trying to be tricky).
- 3 rounds. Everyone ranks once per round. Most points wins.
- Ranker has 1:00, guessers have 1:30.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer. There is nothing to install — the game has no dependencies.

```
node server.js
```

It prints two addresses. Open the first one on your computer. Phones on the **same Wi-Fi** can open the second one (`http://192.168.x.x:3000`).

## Put it online (free)

The game needs a small always-on server, so it can't live on a static host like Netlify. [Render](https://render.com) has a free tier that works well:

1. Put this folder in a GitHub repository.
2. On Render: **New → Web Service**, pick the repo, choose the **Free** instance type.
   - Build command: `npm install`
   - Start command: `npm start`
   - (A `render.yaml` is included if you prefer a Blueprint.)
3. Render gives you a link like `https://best-guess.onrender.com`. Open it, tap **Create a game**, and send the invite link to everyone.

Free-tier notes:
- The server goes to sleep after ~15 minutes with no activity. The first visit after that takes a little while to wake up. Games in progress stay awake because every move is a request.
- Games live in the server's memory. If the server sleeps or restarts, open games are gone — so create the game right before you play.

## Make it yours

**The cards** are in `cards.json` — a plain list of text. Replace it with your own (at least 5, but you'll want 100+ so cards don't repeat much; a hand never contains the same card twice). Restart the server after editing.

**Game settings** can be changed with environment variables (on Render: *Environment* tab), or by editing the `CFG` block at the top of `server.js`:

| Setting | Default | Meaning |
|---|---|---|
| `ROUNDS` | 3 | Rounds per game |
| `RANK_SECONDS` | 60 | Time for the ranker |
| `GUESS_SECONDS` | 90 | Time for the guessers |
| `PERFECT_BONUS` | 3 | Ranker's bonus per 5/5 guesser |

## Good to know

- **Joining:** share the invite link (or the 4-letter code). Players just type a name. Up to 8 players.
- **Rejoining:** if a phone drops or the page is refreshed, it reconnects to the same seat automatically. Anything missed counts as zero for that turn. People can also join mid-game — they get a turn ranking at the end of the current round.
- **Timeouts:** if the ranker runs out of time, their unfinished ranking is filled in randomly. Guessers who run out of time keep whatever they'd placed.
- **Host controls:** the host (👑) sees a small button on each screen to skip a stuck turn, jump to the reveal, or move to the next turn. If the host disconnects, someone else takes over.
- **Sound:** the 🔊 button in the top bar mutes the drumroll and fanfares.

## Look & feel

- **Logo:** `public/logo.png` (and `public/icon.png` for the browser tab). Replace those files to change it.
- **Font:** Barriecito, loaded from Google Fonts, so phones need an internet connection to see it. Without one the game falls back to a similar handwriting-style font and still works fine.
- **Colors:** all in the `:root` block at the top of `public/style.css`. The background is the logo blue; red and green are used for wrong and right.
- **Handwriting effect:** headings are "written" in letter by letter by a small function in `public/app.js` (`scribbleEl`). It switches itself off for people who have reduced motion turned on.

## Files

- `server.js` — the whole game server (rooms, turns, timers, scoring)
- `cards.json` — the deck
- `public/` — the phone interface (`index.html`, `style.css`, `app.js`, `logo.png`, `icon.png`)
