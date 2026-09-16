# RockScreener

A gem terminal for **Solana**. Every launch is indexed, graded and tracked: five
readings, a launch-slot analysis, calls that are measured afterwards, and an
auto-trade engine that refuses what it cannot verify.

```
apps/backend       one image, four processes: gateway · indexer · scorer · trader
apps/web           Next.js 16 + shadcn/ui — dark only
packages/shared    the wire contract, imported by both sides
```

## The one idea

**A reading nobody took is never a reading of zero.**

Most facts about a Solana token minutes old are simply unknown: the holder table
has not been read, the launch has not been analysed, no third party has
published a report. A screener that substitutes a neutral value for each of
those produces a confident-looking number for a token nobody has checked — which
is exactly what made its predecessor useless. It graded everything, so its grade
meant nothing.

Every layer here keeps that distinction intact, from the database columns (every
measured field is nullable) through the scorer (a pillar with no inputs returns
`null`, not 50) to the UI (an unmeasured stratum is a hatched **void in the core
sample**, never a short bar) and finally to auto-trade, which refuses a token
whose sell could not be confirmed rather than treating "not checked" as "clean".

## The Rock Score

One number, five readings, and the findings behind them.

| Pillar | Weight | What it reads |
| --- | --- | --- |
| **Safety** | 0.28 | Mint and freeze authority, Token-2022 transfer fee, mutable metadata, and whether a real balance can be sold back into SOL |
| **Launch** | 0.24 | Supply taken in the first traded slot, in the first fifteen seconds, and by wallets sharing a funder — plus the creator's record |
| **Liquidity** | 0.20 | Depth in dollars, depth against the valuation, LP locked or burnt, market count |
| **Distribution** | 0.18 | Top-ten concentration with AMM vaults excluded, the creator's bag, holder count |
| **Momentum** | 0.10 | Distinct traders, turnover, buy/sell balance, drawdown, survival |

The weighted sum is taken **over the pillars that were measured** and
renormalised to their own weights; `coverage` reports how much of the token the
number actually describes. A **critical finding clamps the total** rather than
being averaged — a token with locked liquidity, fair distribution and good
momentum whose freeze authority is still live would otherwise score in the
sixties. Your account can still be frozen.

### The freeze authority

The Solana-native honeypot, and the reason `safety` is weighted as it is. There
is no EVM equivalent: the buy succeeds, the balance arrives, every simulation
passes — and then the holder's token account is frozen and the position is gone.
A sell check cannot catch it, because at the moment of checking the token
genuinely is sellable. It is read directly from the mint account, and it clamps.

### The launch analysis

Splitting a bag across twelve wallets defeats top-10 concentration, creator
percentage, holder count and every other distribution metric there is, and on
Solana it costs a fraction of a cent per wallet. What it cannot hide is that all
twelve were funded from the same place.

- **Bundle** — supply taken in the token's first *traded* slot. Not the creation
  slot: on pump.fun the mint, the curve and the creator's own first buy often
  land in one transaction, and anchoring there would report that single buy as
  the entire bundle for every token on the launchpad.
- **Snipers** — supply taken within fifteen seconds. A wall-clock window, not a
  slot count, because slot times vary by more than a factor of two between a
  quiet minute and a congested one. Weighted far below the bundle: a fast buyer
  is not an insider.
- **Clusters** — wallets sharing a funding source, from RugCheck's insider
  graph. The strongest of the three, because it survives the wallets being split
  up, and the only one available without a transaction-history key.

### The sell check

Two sources, in order. **What already happened**: dozens of sells in a day is a
record, not a simulation, and nothing can fake it. **What would happen**: for a
token too new to have any, a real-size exit is quoted against the live
aggregator and judged on whether it routes *and* on what it costs — a route that
returns four percent of the money is a honeypot with extra steps. Neither
answering leaves `sellOk` **null**, which is not a pass.

## Calls

A score is a continuous opinion that changes every minute, so it is never wrong.
A **call** is a moment: *at 14:02, at a $38K market cap, this was worth buying.*
It can be measured afterwards, and it can be wrong.

A call is rare by construction. It has to clear the grade, a coverage floor, an
unclamped score, real liquidity, a minimum age, a launch that was actually
analysed, a confirmed sell, and no call on the same token in the last twelve
hours. Every call is then tracked forever — where it was called, what it peaked
at, where it is now, how far it fell, and how it ended: `live`, `invalidated`,
`rugged` or `settled`.

### The record

`GET /calls/record?windowHours=168` counts **every** call in the window the same
way — the ones that ran and the ones that went to zero — and it sits above the
feed rather than behind a tab. It reports the median peak *and* the median
current multiple: the gap between those two is the honest measure of a feed like
this, because a product that publishes only its peaks is showing the best moment
of every call it ever made. Medians rather than means throughout — one 400x
carries a mean and says nothing about the typical call.

## Auto-trade

Rules written once; an engine that follows them without asking again, in its own
process (see `src/trader.ts` for why it must not be the gateway, and why you run
exactly one — the Redis lock is released on a clean shutdown and waits out a
predecessor's TTL on a restart, so a rolling deploy does not crash-loop).

- **It buys what the product called.** Your entry rules are a filter on top of
  that, never a competing opinion — a second definition of "worth buying" living
  beside the one in `calls/engine.ts` would be two opinions disagreeing on the
  same screen.
- **Refusals are the product.** Every gate names its rule and both numbers —
  `entry.maxBundledPct: 34.1% above your 20%` — and is recorded as a `skipped`
  event whether or not anybody is watching.
- **Exits are worst-news-first**: a rug beats a stop, a stop beats a
  take-profit, the time limit is last. A gap past several rungs fills the
  highest and retires the ones below it.
- **Ceilings are not preferences.** Position size, concurrent positions, hourly
  spend and the daily loss cap are all required and all bounded, and no value of
  any of them means "unlimited". The daily cap *disarms* the engine rather than
  pausing it.

### Being told about it

The engine runs while nobody is watching, so a fill that only ever lands in a
log is one the owner finds out about from their balance. If the account signed
in with Telegram, fills and disarms are messaged to it — and **only** fills and
disarms. The engine refuses dozens of tokens a minute, and a notification per
refusal is how somebody mutes the bot on their first day and then misses the
message that mattered.

### The ROCK gate

Arming requires **$500 of ROCK held** — a position, not a subscription. A
subscription is a payment that leaves; a holding is something you keep, and it
aligns the one feature that spends money by itself with the token whose price it
moves. ROCK in the engine wallet and in any wallet you have **linked** both
count; a linked wallet is proved by signature and is read-only forever, with no
key column anywhere in the schema. The gate **fails closed**: if no source will
price ROCK, it stays shut and says exactly that.

```
ROCK  7LxC96Ag4DnBotK6bMMUj4kdneAo1kdV1xHnzVF5s7W2
```

## Trading by hand

`POST /trade` fills from the same custodial wallet through the same executor,
and is deliberately **not** run through the engine's entry rules: those are what
somebody wrote down to be applied while they are not watching, and refusing to
let them buy the token on their screen because of a rule written for a different
purpose would be the wrong product. The panel warns — a live freeze authority,
an unconfirmed sell — *above* the amount field rather than beside the button,
because a caution read after a number has been typed is one already ignored.

A sell is sized from the chain at the moment it is pressed, not from a number
the browser last rendered, so "100%" means the whole position as it is now.

## No candles

This product stores no OHLCV at all. The token page embeds DexScreener's own
chart, which is free and already correct; an OHLCV table for hundreds of
thousands of mints would have to be backfilled, pruned and reconciled to
reproduce it.

The one series that *is* stored is the thing no embed can give: a call's price
path in **multiples of the price it was called at**, where 1.0 is the line
between the call having worked and not. Twenty-six floats on the call row, seeded
from GeckoTerminal and appended on each tick.

## Running it

```bash
cp .env.example .env         # then fill in what you have — see the notes in it
pnpm install
pnpm infra:up                # postgres on 5440, redis on 6390
pnpm --filter @rockscreener/shared build
pnpm db:setup                # schema + the indexes Prisma cannot express

pnpm dev:indexer             # discovery, market, security, retention
pnpm dev:scorer              # sell check, grade, calls
pnpm dev:api                 # http://localhost:4040
pnpm dev:trader              # only once WALLET_MASTER_KEY is set
pnpm dev:web                 # http://localhost:3040
```

Everything containerised instead:

```bash
docker compose --profile app up -d --build
```

The web app runs **without a backend**: leave `NEXT_PUBLIC_API_URL` unset and it
serves fixtures from `apps/web/src/lib/mock.ts` — including unscored rows,
unchecked sells and unmeasured pillars, because those are the states the real
feed spends most of its time in and the ones a demo dataset always forgets.

### Secrets

`WALLET_MASTER_KEY` (`openssl rand -hex 32`) encrypts every custodial trading
key with AES-256-GCM. It lives only in the process environment: never written to
the database, never logged, and no endpoint returns it. **Losing it loses every
wallet and there is no recovery path** — a recoverable master key is a second
copy of it.

Without it the API still serves the whole screener and reports the terminal as
unconfigured; the trader exits cleanly with one line saying why.

## Tests

```bash
pnpm --filter @rockscreener/backend test
```

The scoring and the trading rules are pure functions precisely so they can be
argued with in a test that states its inputs rather than by watching production.
Both suites exist to protect the same thing: that `null` never becomes a number
on the way to somebody's money.

## What degrades without a key

Nothing here fills a gap with a guess.

| Missing | What stops | What does **not** happen |
| --- | --- | --- |
| `HELIUS_API_KEY` | First-slot bundle analysis, distinct trader counts | `bundledPct`/`sniperPct` stay **null**, lowering coverage and blocking calls; momentum falls back to the transaction count at a *lower* ceiling. The RugCheck insider graph still gives the funding-cluster reading. |
| `WALLET_MASTER_KEY` | Custody, auto-trade, manual fills | The whole screener serves; the API reports the terminal as unconfigured and the trader exits with one line. |
| `SESSION_SECRET` | All sign-in | Every account route answers 503; the screener is unaffected. |
| `TELEGRAM_LOGIN_BOT_TOKEN` | Telegram sign-in and fill messages | The button is greyed out *with a reason* rather than failing at the last step. |
| Redis | Wallet sign-in, caches, the trader lock | Sign-in refuses clearly rather than failing intermittently across replicas. |

### If `prisma generate` fails with `EACCES ... utime`

Prisma's shared engine cache under `~/.cache/prisma` is owned by root on this
machine. Either `sudo chown -R $(whoami) ~/.cache/prisma`, or run the command
with a cache of its own:

```bash
XDG_CACHE_HOME=/tmp/prisma-cache pnpm --filter @rockscreener/backend db:generate
```
