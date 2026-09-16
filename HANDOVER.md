# RockScreener — handover

A Solana gem terminal: every launch indexed, graded on five readings, a few of
them **called**, and an auto-trade engine that refuses what it cannot verify.

Read `README.md` first for what the product claims. This file is what you need
to work on it: where things are, what was learned the hard way, and what is
deliberately not there.

---

## The one idea, because everything else follows from it

**A reading nobody took is never a reading of zero.**

Most facts about a Solana token minutes old are unknown. A screener that
substitutes a neutral value for each of them produces confident numbers for
tokens nobody has checked — which is exactly what made the product this
replaces useless: it graded everything, so its grade meant nothing.

Every layer preserves that distinction, and the temptation to break it appears
at **every** boundary:

| Layer | The temptation | What is there instead |
| --- | --- | --- |
| Schema | `Float @default(0)` | every measured column is nullable |
| Source clients | return `0` on failure | return `null`, caller leaves the row alone |
| Pillars | substitute 50 for a missing pillar | return `null`, renormalise over what was measured |
| `coverage` | ignore it | below 60 the grade is provisional and never called or bought |
| Serializer | `?? 0` to make types line up | nulls survive to the client |
| Formatter | `toFixed()` on a null | em dash |
| UI | a short bar | a hatched **void** in the core sample |
| Entry gates | treat unknown as pass | `null` FAILS the launch gates |

If you change one thing in this codebase, do not change that.

---

## Layout

```
packages/shared     the wire contract. Both sides import it; it has no runtime deps.
apps/backend        one image, four processes
  src/gateway.ts    HTTP. Reads, never writes the index.
  src/indexer.ts    seven workers: discovery, market, metadata, curve,
                    security, trader-count, retention
  src/scorer.ts     sell check -> grade -> calls. One pipeline, one process.
  src/trader.ts     the engine. EXACTLY ONE (Redis lock).
apps/web            Next.js 16 + shadcn, dark only
```

**Pure functions carry every decision that involves money**, so they can be
argued with in a test rather than by watching production:

- `score/pillars.ts` — the five readings
- `score/score.ts` — weighting, renormalisation, clamps
- `calls/gate.ts` — every gate a call must clear
- `autotrade/entry.ts` / `exit.ts` — what to buy, when to sell

75 tests, all on those four files. If you are changing behaviour and no test
breaks, you have probably changed something nobody is protecting.

---

## Data sources

| Source | Key | Gives | Note |
| --- | --- | --- | --- |
| PumpPortal (WS) | — | new mints, migrations, **metadata URI** | `txType === 'migrate'` is the ONLY migration test |
| pump.fun API | — | name, symbol, **artwork**, description, socials for pump.fun mints | the only copy — no Metaplex account exists; market numbers deliberately ignored |
| DexScreener | — | price, mcap, liquidity, volume, txns, socials, boosts, paid orders | **the only source of displayed prices** |
| RugCheck | — | authorities, LP lock, holder table (AMM labelled), **insider graph**, transfer fee, risks | its own 0-1000 score is deliberately ignored |
| Solana RPC | — | mint account, **bonding curve**, balances, `stillHeld`, Metaplex metadata | all batched 100/call |
| Jupiter | opt. | routing (sell check), swaps, ROCK + SOL price | **never** a displayed price |
| GeckoTerminal | — | seeds a call's sparkline once | no candles are stored anywhere |
| Helius | **yes** | first-slot bundle, distinct traders | absent ⇒ those readings stay `null` |
| Telegram | opt. | sign-in, fill + disarm messages | |

**Two sources for one number is how a card and a row disagree on the same
screen.** Jupiter is routing and execution; DexScreener is price. Do not blur
that.

---

## Things that cost real time to find

Each of these was found by running against mainnet, not by reading code.

**Every new mint was being promoted to ACTIVE.** PumpPortal's `create` messages
carry a `pool` field naming the *launchpad* (`pump`, `bonk`). The migration test
read any `pool` as a graduation, so the entire firehose went through the
expensive pipeline and got graded. Only `txType === 'migrate'` is a migration.

**A token with 3 holders scored 97/100 on distribution.** A top-ten share of
3.4% looks like a beautifully spread supply when there is nothing to
concentrate. Concentration is not credited below 25 holders; the pillar falls
back to holder count alone.

**An empty pool read as an unmeasured one**, which renormalised the worst pillar
out of the average and made dead tokens score *higher* than thin ones. A
measured zero is a zero; only a token with no pair at all is `null`.

**The engine called PUMP at a $1.67bn market cap.** It graded 83.9 honestly and
was not a call anybody could act on. Calls now have a market-cap ceiling and a
holder floor — and deliberately still **no maximum age**, because a three-week
old token that finally clears the grade is a sleeper waking up, which is the
call worth making.

**Safety saturated at 98 for half the index.** Revoked authorities, no transfer
fee and a known launchpad are nearly free on this chain — a fact true of 99% of
a population separates nothing. The free facts were cut to a token of their
value and the **sell check** now carries the pillar: clean-but-unchecked scores
47, clean-and-confirmed scores 77.

**The screener rendered zero rows against a working API.** A paginated route's
envelope *is* the page (`{ data, nextCursor }`) and the client unwrapped
`body.data` anyway. There are now two reader functions so the wrong one fails to
compile.

**`?? 0` at the serialisation boundary** turned "no market yet" into "$0".

**Jupiter price v2 answers 404.** v3 also renamed the field to `usdPrice` and
dropped the `data` wrapper.

**The curve pass starved itself.** It ordered by `lastActivityAt`, which a
*failed* read does not touch — so the hundred tokens with no curve account came
back every tick and nothing behind them was ever reached. It orders on its own
`curveReadAt` now, stamped even on a miss.

**One-at-a-time RPC reads were the whole performance problem.** Metadata for
11,000 tokens took half an hour at 12 per pass. Every PDA-derived read —
metadata, curve, mint — is now one `getMultipleAccountsInfo` of 100 accounts.
Metadata went 360/min → 2,500/min for the same number of requests. **If you add
another account read, batch it.**

**Creator "rugged" is deliberately narrow** (reached a real valuation, then lost
its liquidity), so a creator whose launches never go anywhere rugs nothing. One
address had 63 launches, 1 rug and zero survivors and read as *neutral*. Eight
launches with nothing alive is now `suspect`.

**pump.fun tokens have no Metaplex metadata account.** Verified: BONK's PDA
reads perfectly, every pump.fun mint's is absent. Live mints get their URI from
the PumpPortal stream; everything discovered before that, or missed by it, is
covered by a third `metadata-sync` pass against pump.fun's own `/coins/{mint}`
(no batch endpoint — `?mint=a&mint=b` is accepted and ignored, returning an
unrelated listing, which is why the source verifies the mint in the body before
writing anything). `pump_read_at` is a SEPARATE stamp from `metadataReadAt`
because they answer different questions; sharing one would mean "the chain said
nothing" also read as "pump.fun was asked". The PDA reader is still needed — it
covers every other token on the chain.

**Three defects lived in the execution layer, where nothing else could see
them.** None showed up in a test or a typecheck, because none of them is about
what the code computes — they are about what happens when the cluster is slow.

- *A timed-out send was recorded as a failed trade.* `confirmTransaction`
  throwing and the program rejecting the transaction were caught by the same
  `catch`, so a buy that was broadcast and then not confirmed in time marked its
  position `failed` — leaving tokens in a real wallet that no exit rule was
  watching, and freeing the engine to buy the same token again with money it had
  already spent. There is now an `UnconfirmedTrade` type carrying the signature,
  the signature is written to the position BEFORE the wait begins, and an
  `autotrade-reconcile` pass settles those rows against the wallet.
- *The confirmation was waiting on the wrong blockhash.* The code fetched a
  fresh one AFTER sending, so `lastValidBlockHeight` was a different
  transaction's deadline, about a minute late. Jupiter returns the right one in
  the `/swap` response and it was being discarded.
- *Fill sizes came from a balance delta bracketing the swap.* The entry and exit
  loops run on the same wallet and can overlap, so each contaminated the other's
  cost basis — the number every exit rule is measured from. Sizes now come from
  the confirmed transaction's own `meta.preBalances` / `preTokenBalances`.

**A round robin is not a price feed for something you have staked a claim on.**
The market sync laps the index in about forty minutes, which is fine for a
screener row and wrong for a live call: the calls engine marks its own claim
against the token's price column, so calls were being scored on prices up to
forty minutes old and twenty-six of them closed with "25 minutes on and it has
not moved". `market-sync` now runs a HOT LANE — every token with a live call or
an open position, one extra request per tick, unioned in SQL so a token in both
sets does not eat two of the thirty slots. **Anything else that reads a price to
make or close a decision belongs in that union.**

---

## The signal, and how its numbers were settled

**The first seventy-nine calls had a median peak of 1.00x.** Forty-one of them
never traded above their entry price — not by a cent, not for a second. That is
not a token-picking failure; it is an entry-timing failure, and it had two
causes that were both measurable.

**Half the score was a constant.** Across six thousand graded tokens the pillar
standard deviations were: distribution 25.2, liquidity 17.1, safety 13.9, launch
10.0, momentum 6.8. A pillar ranks in proportion to its weight TIMES its spread
— and safety and launch carried 52% of the weight while barely varying. Safety
sat at its 77 ceiling for more than half the set, because revoking a mint
authority is free and every launchpad does it; launch sat at 66 for nearly all
of it, because without a Helius key there is no bundle reading to move it. The
top of the table was every token scoring 79 to 82, ranked by whichever had the
deepest pool — a big-token finder wearing a gem finder's badge. Safety and launch
are DISQUALIFIERS, and their real work is done by the clamps; the weight moved to
the three pillars that discriminate.

**And the momentum pillar read nothing but 24-hour totals.** It could not
answer the only question that decides an entry — where in its own arc is this
token right now — because "it was busy today" is a fact about a move that has
already finished. Every reading that pushes a token over the grade threshold
(volume, turnover, buy share, distinct traders) peaks at the same instant the
price does, so the moment a token crossed into `buy` was, on average, the top.
The short-window columns were being fetched, stored and displayed the whole
time; the scorer simply never read them.

### The backtest

`scripts/backtest.ts` replays every 5-minute bar of a sampled token's history
as a hypothetical entry and measures what happened an hour later. It is possible
despite this product storing no candles because **every input to the timing
rules is reconstructible from GeckoTerminal's OHLCV** — `priceChange5m` is one
bar, `priceChange1h` twelve, `volume1hUsd` a twelve-bar sum. Bars are cached on
disk, so re-running after changing a threshold is instant.

Over 28,444 entries on tokens that clear the quality gates, by how far the price
had already run in the preceding hour:

| preceding hour | median +1h | fell 20%+ |
| --- | --- | --- |
| calm 0–30% | 0.998 | 0% |
| rising 30–80% | 0.997 | 33% |
| hot 80–150% | 0.719 | 57% |
| ran 150–400% | **0.477** | **85%** |

**What it settled, and what it refused to settle.** The first draft of the
ceilings was 120% over an hour and 20% over five minutes; the sweep showed both
would have refused essentially nothing, so they moved to where the damage
measurably begins. The five-minute ceiling went to 25 rather than 10 because two
independent windows disagreed about the 10–25% band (medians 0.902 and 0.997 on
91 and 149 entries) and agreed about 25–60%. And `minVolume1hUsd` came DOWN from
4,000, because that floor was refusing a third of all entries with no measurable
improvement to them; it is kept at all for a reason the backtest cannot see —
being able to exit, which the sell check tests properly.

**The honest headline is that the median entry returns 0.999 whatever you do.**
The base rate on this market is flat. These gates are not worth anything for
the typical entry and are worth a great deal for the tail: their whole job is to
refuse the bucket where the median entry loses half its money and 85% of them
fall a fifth within the hour. A screener with no such term recommends most
loudly at exactly that moment, because every other signal it reads peaks there.

**What the backtest does not test**, and it matters: the slow facts (safety,
holders, liquidity, launch analysis) are taken as they are NOW, not replayed —
so this measures the timing rules in isolation. And the sample is tokens still
in the index with a live pool, so every absolute number is survivorship-biased
and optimistic. The comparison between passing and refused entries survives that
bias, because both are drawn from the same tokens over the same bars; the
absolute returns do not.

**One finding was deliberately NOT acted on.** Entering after a sharp fall
(−20% or worse in the hour) was the best bucket in both windows — median 1.058
to 1.218, with roughly half the entries up 10% within the hour. It is also where
survivorship bias bites hardest: a collapse that was terminal removes the token
from the sample entirely. Building a buy-the-dip rule on two hundred survivor
observations would be fitting the bias, not the market.

---

## What is deliberately absent

- **`creatorLinkedPct`.** Finding creator-funded wallets means walking each
  bundle wallet's history back to its funding, which happened before the token
  existed. RugCheck's insider graph already walks those edges and arrives as
  `clusteredPct`, which the launch pillar weights *above* the bundle.
- **An export route for custodial keys.** One request that turns the master
  key's blast radius into a plaintext key in a browser, a proxy log, and
  wherever the user pastes it.
- **`watch` calls.** A watch is not a claim that something is worth buying.
- **Candles.** The token page embeds DexScreener's chart. The only series stored
  is a call's path in multiples of its entry — twenty-six floats, and nothing
  else can produce it.
- **Entry rules on manual trades.** Those rules are for when nobody is watching.

---

## Operating it

```bash
pnpm infra:up                 # postgres 5440, redis 6390
pnpm db:setup                 # schema + the indexes Prisma cannot express
pnpm dev:indexer / dev:scorer / dev:api / dev:trader / dev:web
```

- `apps/backend/.env` is a **symlink** to the root `.env` — the Prisma CLI reads
  from its own cwd while every process uses `--env-file=../../.env`.
- `prisma generate` may fail with `EACCES … utime`: `~/.cache/prisma` is
  root-owned on this machine. Prefix with `XDG_CACHE_HOME=/tmp/prisma-cache`.
- `tsx watch` does **not** reload `.env`. Restart the process after editing it.
- The trader releases its lock on SIGTERM and waits out a predecessor's TTL on
  start, so a rolling restart does not crash-loop.

### Without a Helius key

`bundledPct` and `sniperPct` stay `null`, which lowers coverage and blocks calls
on unanalysed launches — and **auto-trade buys nothing**, because
`entry.maxBundledPct` fails on `null` by design. Calls still fire on the
RugCheck cluster reading. This is the designed degradation, not a bug; the log
says exactly which rule refused each token.

Because of that, **the table's narrow distribution column shows the RugCheck
insider percentage, not the bundle**: with no key the bundle column is an em
dash on every one of twelve thousand rows, which is dead width rather than
honest reporting. The bundle number keeps its meaning everywhere it is actually
used — the drawer, the launch pillar, the entry gates — and if the key lands and
you want it back in the table, it is one entry in `COLUMNS` and one cell.

---

## Where to be careful

1. **The envelope.** `{ data }` for everything, `{ data, nextCursor }` for pages.
2. **Batch every account read.** See above.
3. **`null` is load-bearing.** Adding `?? 0` anywhere is almost always a bug.
4. **One writer per column.** The curve sync owns `liquidityUsd` while bonding;
   the market sync owns it after. Two writers make a row flicker.
5. **The calls engine is the product.** Changing `calls/gate.ts` changes what
   this thing claims. Tests there are the specification.
