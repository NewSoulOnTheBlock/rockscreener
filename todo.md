# What is not done

Written down rather than left as a surprise.

> The full list of what was found by running against mainnet now lives in
> `HANDOVER.md`. This file is only what is still open.

## Found and fixed on the live runs

Kept here because each one is a class of bug this codebase will meet again.

- **Every new mint was being promoted to ACTIVE.** PumpPortal's create messages
  carry a `pool` field naming the LAUNCHPAD (`pump`, `bonk`); the migration test
  read any `pool` as a graduation, so the whole firehose went through the
  expensive pipeline and got graded. Only `txType === 'migrate'` is a migration.
- **A token with 3 holders scored 97/100 on distribution**, because a top-ten
  share of 3.4% looks like a beautifully spread supply when there is nothing to
  concentrate. Concentration is now not credited below 25 holders.
- **An empty pool was treated as an unmeasured one**, which renormalised the
  worst pillar out of the average and made dead tokens score HIGHER than thin
  ones. A measured zero is now a zero.
- **The engine called PUMP at a $1.67bn market cap.** It graded 83.9 honestly
  and was not a call anybody could act on. Calls now have a market-cap ceiling
  and a holder floor; there is still deliberately no maximum age.
- **`?? 0` at the serialisation boundary** turned "this token has no market yet"
  into "$0". The market fields are nullable all the way to the client.
- **The screener rendered zero rows against a working API**, because a
  paginated route's envelope IS the page (`{ data, nextCursor }`) and the client
  unwrapped `body.data` anyway. Two reader functions now, so the wrong one fails
  to compile.
- **Jupiter's price v2 host answers 404.** Moved to v3, which also renamed the
  field to `usdPrice` and dropped the `data` wrapper.
- **The curve pass starved itself** by ordering on a column a failed read does
  not touch. It orders on its own `curveReadAt`, stamped even on a miss.
- **One-at-a-time RPC reads were the whole performance problem.** Metadata,
  curve and mint accounts are all PDA-derived, so all three are now one
  `getMultipleAccountsInfo` of 100. Metadata went 360/min to 2,500/min for the
  same number of requests.
- **Safety and distribution saturated**: half the index sat at 95+ on a pillar
  worth 28% of the grade, because revoked authorities and a known launchpad are
  nearly free on this chain. Recalibrated so the sell check carries safety and
  holder count carries distribution.
- **pump.fun tokens have no Metaplex metadata account** — verified against BONK,
  whose PDA reads perfectly. Their URI comes from the PumpPortal stream instead.

## Deliberately not built, with the reason

- **`creatorLinkedPct`** — supply held by wallets the creator FUNDED. Finding
  them means walking each bundle wallet's own history back to where its SOL came
  from, and that funding almost always happens before the token existed, in
  transactions the mint's history does not contain. RugCheck's insider graph
  already walks exactly those edges and its answer arrives as `clusteredPct`,
  which the launch pillar weights ABOVE the bundle. A worse second version of
  the same reading is not worth the twenty per-wallet fetches.

- **An export route for custodial keys.** One request that turns the master
  key's entire blast radius into a plaintext key in a browser's memory, a proxy
  log, and whatever the user pastes it into. The wallet page says so plainly
  instead: fund it with what you intend the engine to risk and no more.

- **`watch` calls.** The tier exists in the wire contract because the bands are
  shared with the grade, but a watch is not a claim that something is worth
  buying, and publishing them beside real calls would treble the feed with
  entries the record would then have to count.

- **Live calls were tracked against prices up to forty minutes old.** The market
  sync is a round robin over the whole index — thirty mints per six seconds,
  twelve thousand rows, a forty minute lap — and the calls engine reads the
  token's price column to mark its own claim. Twenty-six calls had closed with
  "25 minutes on and it has not moved", which was never a fact about those
  tokens; it was the same stale price read twice. `market-sync` now runs a HOT
  LANE beside the round robin covering every live call and every open position,
  one extra request per tick. The first pass after the fix re-marked live calls
  from a flat 1.00x to a real spread of 0.09x to 2.37x.
- **Nothing was ever written in the Bundle column.** It needs a Helius key for
  the first-slot analysis, so without one it is an em dash on every row in the
  index — dead width rather than honest reporting. The table now shows the
  RugCheck INSIDER percentage there, which is measured for about a third of the
  index and is the more predictive of the two anyway; bundle keeps its meaning
  in the drawer and in the entry gates.

- **The execution layer had three defects that only appear under congestion.**
  A timed-out send was written off as failed (leaving an untracked bag in a real
  wallet); the confirmation waited on a blockhash fetched after the send rather
  than the transaction's own; and fill sizes came from a balance delta that the
  entry and exit loops could contaminate for each other. See HANDOVER for what
  replaced each. The trader now also runs an `autotrade-reconcile` pass.

- **The signal engine was ranking on a constant and entering at the top.** Half
  the score's weight sat in two pillars that barely varied, and momentum read
  only 24-hour totals so it had no concept of where in its own move a token was.
  Momentum was rewritten with acceleration and extension terms, the weights moved
  to the pillars that discriminate, the top band was reset from the measured
  distribution (82 was unreachable — nothing in the index scored above 81), and
  the call gate got three timing vetoes. `scripts/backtest.ts` settled every
  threshold; see HANDOVER for the numbers and for the two it refused to settle.

## Still open

- **Re-run the record once the new calls have history.** The 7-day record shown
  in the header still counts the seventy-nine calls made under the old engine,
  including forty-one made at a local top. It will look bad for a week and
  should: deleting them would be publishing a different set of claims from the
  ones that were made.
- **The backtest cannot see the slow facts.** Safety, holders, liquidity and the
  launch analysis are taken as they are now. Testing whether the QUALITY gates
  earn their place needs a history of those columns, which nothing stores. The
  cheapest honest version is to start snapshotting them per token per hour and
  come back in a month.

- **Auto-trade has never executed a trade.** Zero users, zero positions, zero
  events. Every path above is reasoned and typed, and none of it has been proven
  against mainnet with money. The first real arm should be one wallet, the
  smallest ticket the rules allow, and somebody watching the event log.
- **No Jito tip / bundle path.** Priority fee only, via Jupiter's
  `priorityLevelWithMaxLamports`. Fine at this size; it is the next thing to add
  if fills start losing races rather than failing outright.

- **Image backlog is draining, not closed.** The pump.fun pass added to
  `metadata-sync` covers what the PDA reader structurally cannot, at ~340
  tokens/min, and `pump_read_at` records which mints have been asked so the
  queue never revisits one. Until it laps the index, older rows still show a
  blank circle.
- **Curve liquidity is still catching up** at ~900 tokens/min over the bonding
  set; it is correct, just not instant on a cold index.

## Degrades without a key, by design

`HELIUS_API_KEY` unset means no first-slot bundle analysis and no distinct
trader counts. Neither is filled in with a guess: `bundledPct` and `sniperPct`
stay null, which lowers coverage and blocks calls on unanalysed launches, and
the momentum pillar falls back to the transaction count at a LOWER ceiling so
the cheap-to-fake number never earns what the expensive one is worth. The
RugCheck insider graph still supplies the funding-cluster reading, which is the
more predictive half of the launch analysis.

## Worth revisiting against outcomes, not intuition

- `sellCheck.maxImpactPct` (12%) and the probe size. These decide `sellOk` for
  thin pools and were chosen, not measured.
- `calls.stagnantAfterMinutes` (25) — the number gemhood derived from a
  time-to-peak distribution. It has not been re-derived on Solana data.
- The tier bands. They are shared with the call thresholds on purpose, so
  changing one changes both.
