'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Panel, PanelHead } from '@/components/ui/panel';
import { Button } from '@/components/ui/button';
import { SortableTable, type Column } from '@/components/etherrock/table';
import { MonthlyBars, PriceScatter } from '@/components/etherrock/charts';
import { TooltipLayer, useTip } from '@/components/etherrock/tooltip';
import { cn } from '@/lib/cn';
import {
  RAMP,
  RAMP_INK,
  SERIES,
  dstr,
  eth,
  etherscan,
  nf,
  rampStep,
  short,
  type Rock,
  type Snapshot,
} from '@/lib/etherrock';

/**
 * THE ETHERROCK BOARD.
 *
 * A snapshot, served as a static file and fetched once — deliberately not
 * wired to the gateway. Nothing on this page is a live reading of Solana, and
 * routing it through the screener's API would put an Ethereum collection behind
 * an endpoint whose every other answer is a token this product graded.
 *
 * The one rule the rest of the product lives by still applies: a figure that
 * could not be reconstructed is an em dash, never a zero. `reconciliation`
 * therefore sits on the page rather than in a footnote — it is the page saying
 * how much of itself it can actually vouch for.
 */

export function EtherRockBoard() {
  const { data, isLoading, isError } = useQuery<Snapshot>({
    queryKey: ['etherrock-snapshot'],
    queryFn: async () => {
      const res = await fetch('/etherrock-snapshot.json');
      if (!res.ok) throw new Error('snapshot unavailable');
      return res.json() as Promise<Snapshot>;
    },
    staleTime: Infinity,
  });

  if (isLoading) return <Skeleton />;
  if (isError || !data) {
    return (
      <div className="card px-4 py-8 text-center text-[13px] text-dim">
        The snapshot could not be loaded. Nothing is shown rather than a page of zeroes.
      </div>
    );
  }

  return (
    <TooltipLayer>
      <div className="space-y-10">
        <Markets snapshot={data} />
        <PriceHistory snapshot={data} />
        <Monthly snapshot={data} />
        <TheHundred snapshot={data} />
        <Holders snapshot={data} />
        <Affinity snapshot={data} />
        <Provenance snapshot={data} />
      </div>
    </TooltipLayer>
  );
}

function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="h-[168px] animate-pulse rounded-[var(--radius-lg)] bg-slab" />
      <div className="h-[420px] animate-pulse rounded-[var(--radius-lg)] bg-slab" />
    </div>
  );
}

/* ---------------------------------------------------------------- section ---- */

function Section({
  title,
  lede,
  children,
}: {
  title: string;
  lede: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="label tracking-[0.09em] uppercase">{title}</h2>
      <p className="mt-1 mb-4 max-w-[78ch] text-[13px] leading-relaxed text-ash">{lede}</p>
      {children}
    </section>
  );
}

/* ---------------------------------------------------------------- markets ---- */

/**
 * TWO MARKETS THAT CANNOT OVERLAP, drawn as two cards with a ratio between them
 * rather than as one blended floor.
 *
 * The eligibility strips under each card are the argument: 100 segments, lit for
 * the rocks that venue can actually trade, and because wrapping moves a rock out
 * of one market and into the other the two strips are exact complements. A
 * single "floor" figure averaged across both would describe a market no buyer
 * can transact in.
 */
function Markets({ snapshot }: { snapshot: Snapshot }) {
  const c = snapshot.summary.contractMarket;
  const o = snapshot.summary.openseaMarket;
  const t = snapshot.totals;
  const s = snapshot.summary.totals;
  const conc = snapshot.summary.concentration;

  const spread =
    c.floorEth != null && o.floorEth != null
      ? (Math.max(c.floorEth, o.floorEth) / Math.min(c.floorEth, o.floorEth)).toFixed(2) + '×'
      : '—';

  const peak = React.useMemo(() => {
    const top = [...snapshot.events]
      .filter((e) => e.type === 'sale')
      .sort((a, b) => b.priceEth - a.priceEth)[0];
    return top ? `rock #${top.rockId} · ${dstr(top.ts)}` : '';
  }, [snapshot.events]);

  const kpis: [string, string, string][] = [
    ['Rocks', nf(s.supply), `${s.wrapped} wrapped · ${s.unwrapped} raw`],
    ['Unique holders', nf(s.uniqueHolders), `${conc.singletons} own exactly one`],
    ['Lifetime sales', nf(t.lifetimeSales), 'across both contracts'],
    ['Lifetime volume', eth(t.lifetimeVolumeEth) + ' ETH', 'all recorded buys'],
    ['Record sale', eth(t.peakSaleEth) + ' ETH', peak],
    ['Top holder', conc.top1 + ' rocks', `top 10 hold ${conc.top10}`],
  ];

  return (
    <Section
      title="Two markets, one collection"
      lede={
        <>
          All 100 rocks live in the 2017 contract, which predates ERC-721 and is invisible to
          OpenSea. Wrapping mints an ERC-721 that <em>does</em> trade there — but the wrapper then
          owns the rock, so <Code>sellRock()</Code> can no longer be called on it. The two markets
          are therefore mutually exclusive: no rock can be listed in both, and the floors are never
          blended.
        </>
      }
    >
      <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr]">
        <MarketCard
          colour={SERIES.contract}
          title="Contract floor"
          note={
            <>
              Binding on-chain ask — <Code>buyRock()</Code> settles atomically
            </>
          }
          floor={c.floorEth}
          sub={
            c.floorEth != null ? (
              <>
                cheapest is <B>rock #{c.floorRockId}</B> · <B>{c.listed}</B> of <B>{c.eligible}</B>{' '}
                unwrapped rocks carry a live ask
              </>
            ) : (
              'no open asks'
            )
          }
          rocks={snapshot.rocks}
          lit={(r) => !r.wrapped}
          caption={`${c.eligible} of 100 tradeable on-contract`}
        />

        <div className="flex min-w-[108px] flex-col items-center justify-center px-2 text-center">
          <div className="tnum font-display text-[28px] leading-none text-bone">{spread}</div>
          <div className="label mt-1.5 tracking-[0.07em] uppercase">floor spread</div>
        </div>

        <MarketCard
          colour={SERIES.opensea}
          title="OpenSea floor"
          note="Signed Seaport order — cancellable, can fail"
          floor={o.floorEth}
          sub={
            o.floorEth != null ? (
              <>
                cheapest is <B>rock #{o.floorRockId}</B> · <B>{o.listed}</B> of <B>{o.eligible}</B>{' '}
                wrapped rocks listed
              </>
            ) : (
              'no live listings'
            )
          }
          rocks={snapshot.rocks}
          lit={(r) => r.wrapped}
          caption={`${o.eligible} of 100 tradeable on OpenSea`}
        />
      </div>

      <div className="mt-3 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(146px,1fr))]">
        {kpis.map(([label, value, note]) => (
          <div key={label} className="card px-3.5 py-3">
            <div className="label tracking-[0.06em] uppercase">{label}</div>
            <div className="tnum mt-1 font-display text-[25px] leading-tight text-bone">{value}</div>
            <div className="mt-0.5 text-[12px] text-ash">{note}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function MarketCard({
  colour,
  title,
  note,
  floor,
  sub,
  rocks,
  lit,
  caption,
}: {
  colour: string;
  title: string;
  note: React.ReactNode;
  floor: number | null;
  sub: React.ReactNode;
  rocks: Rock[];
  lit: (r: Rock) => boolean;
  caption: string;
}) {
  return (
    <div className="card flex flex-col px-4 py-4">
      <h3 className="flex items-center gap-2 text-[15px] font-semibold text-bone">
        <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: colour }} />
        {title}
      </h3>
      <p className="mt-0.5 mb-3.5 text-[12.5px] text-dim">{note}</p>
      <div className="tnum font-display text-[46px] leading-none text-bone">
        {floor != null ? (
          <>
            {eth(floor)}
            <span className="ml-1.5 text-[17px] font-medium text-ash">ETH</span>
          </>
        ) : (
          '—'
        )}
      </div>
      <div className="mt-2 text-[13px] text-ash">{sub}</div>

      {/* 100 segments, one per rock, lit for the rocks this venue can trade. */}
      <div className="mt-auto flex gap-px pt-4" aria-hidden="true">
        {rocks.map((r) => (
          <span
            key={r.id}
            className="h-[13px] flex-1 rounded-[1px]"
            style={{ background: lit(r) ? colour : 'var(--color-raised)' }}
          />
        ))}
      </div>
      <div className="mt-1.5 font-mono text-[11px] text-dim">{caption}</div>
    </div>
  );
}

/* ----------------------------------------------------------- price history ---- */

function PriceHistory({ snapshot }: { snapshot: Snapshot }) {
  const [logScale, setLogScale] = React.useState(true);
  return (
    <Section
      title="Every recorded sale"
      lede={
        <>
          One dot per sale, from the first 0.001 ETH mint in December 2017 to today. A log scale is
          on by default because the range spans six orders of magnitude.
        </>
      }
    >
      <Panel>
        <PanelHead label="Sale price over time" hint="hover any point for rock, buyer and block">
          <Button
            size="sm"
            variant={logScale ? 'rock' : 'outline'}
            aria-pressed={logScale}
            onClick={() => setLogScale((v) => !v)}
          >
            Log scale
          </Button>
        </PanelHead>
        <div className="px-3 py-3">
          <PriceScatter snapshot={snapshot} logScale={logScale} />
        </div>
      </Panel>
    </Section>
  );
}

/* ----------------------------------------------------------------- monthly ---- */

function Monthly({ snapshot }: { snapshot: Snapshot }) {
  return (
    <Section
      title="Activity by month"
      lede="Volume and trade count are plotted separately rather than on twin axes — two scales on one frame invite false correlations."
    >
      <div className="grid gap-3 xl:grid-cols-2">
        <Panel>
          <PanelHead label="Volume per month" hint="ETH" />
          <div className="px-3 py-3">
            <MonthlyBars rows={snapshot.monthly} metric="volumeEth" color={SERIES.contract} />
          </div>
        </Panel>
        <Panel>
          <PanelHead label="Sales per month" hint="count" />
          <div className="px-3 py-3">
            <MonthlyBars rows={snapshot.monthly} metric="sales" color={SERIES.opensea} />
          </div>
        </Panel>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------- the hundred ---- */

type RockRow = {
  id: number;
  owner: string;
  form: string;
  wrapped: boolean;
  timesSold: number;
  volumeEth: number;
  peakEth: number | null;
  ask: number | null;
  venue: string;
  mint: number | null;
  last: string;
};

function TheHundred({ snapshot }: { snapshot: Snapshot }) {
  const [tableOpen, setTableOpen] = React.useState(true);
  const tip = useTip();
  const max = Math.max(...snapshot.rocks.map((r) => r.timesSold));

  const rows: RockRow[] = React.useMemo(
    () =>
      snapshot.rocks.map((r) => ({
        id: r.id,
        owner: r.owner,
        form: r.wrapped ? 'wrapped' : 'raw',
        wrapped: r.wrapped,
        timesSold: r.timesSold,
        volumeEth: r.volumeEth,
        peakEth: r.peakEth,
        ask: r.forSale ? r.askEth : (r.osListing?.priceEth ?? null),
        venue: r.forSale ? 'contract' : r.osListing ? 'opensea' : '—',
        mint: r.primaryPriceEth,
        last: r.lastSale ? dstr(r.lastSale.ts) : '—',
      })),
    [snapshot.rocks]
  );

  const columns: Column<RockRow>[] = [
    { key: 'id', label: 'Rock', num: true },
    {
      key: 'form',
      label: 'Form',
      render: (r) => (
        <span
          className={cn(
            'inline-block rounded-[var(--radius-xs)] border px-1.5 py-px text-[10.5px]',
            r.wrapped ? 'border-action/40 text-action' : 'border-rule text-dim'
          )}
        >
          {r.form}
        </span>
      ),
    },
    {
      key: 'owner',
      label: 'Owner',
      addr: true,
      render: (r) => <Addr address={r.owner} />,
    },
    { key: 'timesSold', label: 'Sales', num: true, sort: true },
    { key: 'volumeEth', label: 'Volume (ETH)', num: true, render: (r) => eth(r.volumeEth) },
    { key: 'peakEth', label: 'Peak (ETH)', num: true, render: (r) => eth(r.peakEth) },
    { key: 'ask', label: 'Live ask (ETH)', num: true, render: (r) => (r.ask != null ? eth(r.ask) : '—') },
    { key: 'venue', label: 'Venue' },
    { key: 'mint', label: 'Mint (ETH)', num: true, render: (r) => eth(r.mint) },
    { key: 'last', label: 'Last sale' },
  ];

  return (
    <Section
      title="The hundred"
      lede="Every rock, shaded by how many times it has changed hands. A violet ring marks a wrapped rock; a dot marks one with a live ask. Colour encodes magnitude, the ring encodes form — so the two never compete."
    >
      <Panel>
        <PanelHead label="All 100 rocks" hint="brighter = traded more often">
          <Button
            size="sm"
            variant={tableOpen ? 'rock' : 'outline'}
            aria-pressed={tableOpen}
            onClick={() => setTableOpen((v) => !v)}
          >
            Table view
          </Button>
        </PanelHead>

        <div className="px-3 py-3.5">
          <div className="grid grid-cols-10 gap-1.5 sm:grid-cols-[repeat(20,minmax(0,1fr))]">
            {snapshot.rocks.map((r) => {
              const step = rampStep(r.timesSold, max);
              const live = r.forSale ? r.askEth : (r.osListing?.priceEth ?? null);
              return (
                <div
                  key={r.id}
                  className={cn(
                    'relative flex aspect-square cursor-pointer items-center justify-center rounded-[5px] border-2 font-mono text-[10px]',
                    'transition-[outline] hover:outline-2 hover:outline-offset-1 hover:outline-bone',
                    r.wrapped ? 'border-action' : 'border-transparent'
                  )}
                  style={{ background: RAMP[step], color: RAMP_INK[step] }}
                  {...tip(`Rock #${r.id}`, [
                    ['Owner', short(r.owner)],
                    ['Status', r.wrapped ? 'Wrapped (ERC-721)' : 'Raw (2017 contract)'],
                    ['Times sold', nf(r.timesSold)],
                    ['Volume', eth(r.volumeEth) + ' ETH'],
                    ['Peak', eth(r.peakEth) + ' ETH'],
                    [
                      'Live ask',
                      live != null ? eth(live) + ' ETH' + (r.forSale ? ' (contract)' : ' (OpenSea)') : 'not listed',
                    ],
                    ['Mint price', eth(r.primaryPriceEth) + ' ETH'],
                  ])}
                >
                  {r.id}
                  {live != null ? (
                    <span className="absolute top-0.5 right-0.5 size-[5px] rounded-full bg-slab ring-[1.5px] ring-bone" />
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap gap-4 text-[12.5px] text-ash">
            <Key swatch={RAMP[1]}>traded rarely</Key>
            <Key swatch={RAMP[6]}>traded often</Key>
            <span className="flex items-center gap-2">
              <span className="size-[11px] shrink-0 rounded-[3px] border-2 border-action" />
              wrapped (ERC-721)
            </span>
            <span className="flex items-center gap-2">
              <span className="mx-0.5 size-[7px] shrink-0 rounded-full bg-slab ring-[1.5px] ring-bone" />
              has a live ask
            </span>
          </div>
        </div>
      </Panel>

      {tableOpen ? (
        <div className="mt-3.5">
          <SortableTable columns={columns} rows={rows} rowKey={(r) => r.id} />
        </div>
      ) : null}
    </Section>
  );
}

/* ----------------------------------------------------------------- holders ---- */

type HolderRow = {
  address: string;
  count: number;
  wrapped: number;
  listedAsk: number;
  volume: number;
  rocks: string;
};

function Holders({ snapshot }: { snapshot: Snapshot }) {
  const c = snapshot.summary.concentration;

  const rows: HolderRow[] = React.useMemo(
    () =>
      snapshot.summary.holders.map((h) => {
        const owned = h.rocks
          .map((id) => snapshot.rocks.find((r) => r.id === id))
          .filter((r): r is Rock => Boolean(r));
        return {
          address: h.address,
          count: h.rocks.length,
          wrapped: h.wrapped,
          listedAsk: owned.filter((r) => r.forSale).length,
          volume: owned.reduce((s, r) => s + r.volumeEth, 0),
          rocks: [...h.rocks].sort((a, b) => a - b).join(', '),
        };
      }),
    [snapshot]
  );

  const columns: Column<HolderRow>[] = [
    { key: 'address', label: 'Wallet', addr: true, render: (r) => <Addr address={r.address} /> },
    { key: 'count', label: 'Rocks', num: true, sort: true },
    { key: 'wrapped', label: 'Wrapped', num: true },
    { key: 'listedAsk', label: 'Live asks', num: true },
    { key: 'volume', label: 'Lifetime vol (ETH)', num: true, render: (r) => eth(r.volume) },
    { key: 'rocks', label: 'Rock IDs' },
  ];

  return (
    <Section
      title="Who holds them"
      lede={
        <>
          Top holder owns <B>{c.top1}</B>. Top 5 own <B>{c.top5}</B>, top 10 own <B>{c.top10}</B> of
          100. <B>{c.singletons}</B> of {snapshot.summary.totals.uniqueHolders} wallets hold exactly
          one rock.
        </>
      }
    >
      <SortableTable columns={columns} rows={rows} rowKey={(r) => r.address} maxHeight={440} />
    </Section>
  );
}

/* ---------------------------------------------------------------- affinity ---- */

function Affinity({ snapshot }: { snapshot: Snapshot }) {
  const tip = useTip();
  const rows = snapshot.affinity.filter((a) => a.holderCount > 1).slice(0, 18);
  const max = rows[0]?.holderCount ?? 1;
  const feed = snapshot.acquisitions.filter((a) => a.name).slice(0, 80);

  return (
    <Section
      title="What else rock holders own"
      lede={
        <>
          <B>{snapshot.affinity.length}</B> distinct collections are co-held by the{' '}
          {snapshot.summary.totals.uniqueHolders} rock wallets.
        </>
      }
    >
      <div className="grid gap-3 xl:grid-cols-2">
        <Panel>
          <PanelHead label="Most co-held collections" hint="by number of rock wallets holding it" />
          <div className="px-3.5 py-3">
            {rows.length ? (
              rows.map((a) => {
                const step = Math.min(RAMP.length - 1, 2 + Math.floor((a.holderCount / max) * 4));
                return (
                  <div
                    key={a.address}
                    className="grid grid-cols-[130px_1fr_74px] items-center gap-3 py-[5px] sm:grid-cols-[210px_1fr_96px]"
                  >
                    <div className="truncate text-[13px] text-ash" title={a.name ?? a.address}>
                      {a.name || short(a.address)}
                    </div>
                    <div
                      className="relative h-5 rounded-[4px] bg-raised"
                      {...tip(a.name || short(a.address), [
                        ['Rock holders owning it', nf(a.holderCount)],
                        ['Tokens held in total', nf(a.totalTokens)],
                        ['Collection floor', a.floorEth != null ? eth(a.floorEth) + ' ETH' : '—'],
                      ])}
                    >
                      <div
                        className="h-full rounded-r-[4px]"
                        style={{ width: (a.holderCount / max) * 100 + '%', background: RAMP[step] }}
                      />
                    </div>
                    <div className="tnum text-right font-mono text-[12.5px] text-ash">
                      {a.holderCount} holders
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="py-6 text-center text-[12px] text-dim">No portfolio data.</p>
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHead label="Latest acquisitions" hint="newest NFTs entering rock-holder wallets" />
          <div className="max-h-[470px] overflow-y-auto px-3.5 py-1">
            {feed.length ? (
              feed.map((a, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[92px_1fr_auto] items-baseline gap-3 border-b border-rule-faint py-2.5 text-[13px] last:border-b-0"
                >
                  <div className="font-mono text-[11.5px] text-dim">{String(a.ts ?? '').slice(0, 10)}</div>
                  <div className="truncate text-ash" title={a.name ?? ''}>
                    {a.name}
                    {a.tokenId ? ' #' + a.tokenId : ''}
                  </div>
                  <Addr address={a.holder} className="text-[11.5px]" />
                </div>
              ))
            ) : (
              <p className="py-6 text-center text-[12px] text-dim">No recent acquisitions.</p>
            )}
          </div>
        </Panel>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------- provenance ---- */

/**
 * HOW MUCH OF THIS THE PAGE CAN VOUCH FOR, stated before the caveats.
 *
 * The same rule as the screener: the reconciliation is a reading that was
 * actually taken, so it is shown as one. If the counters had not balanced this
 * block would say how many gaps remain rather than quietly dropping them.
 */
function Provenance({ snapshot }: { snapshot: Snapshot }) {
  const rc = snapshot.reconciliation;
  const g = snapshot.ghostMarket;

  return (
    <Section
      title="How these numbers were built"
      lede="The 2017 contract emits no events, so none of this is available from logs. Every figure is reconstructed and then checked against the contract's own counters."
    >
      <div className="card mb-3.5 px-4 py-3.5 text-[13.5px] leading-relaxed text-ash">
        <span className={cn('font-semibold', rc.complete ? 'text-rock' : 'text-warn')}>
          {rc.complete ? '✓ Fully reconciled' : `⚠ ${rc.unexplainedGaps.length} gap(s)`}
        </span>{' '}
        — the contract&rsquo;s own <Code>timesSold</Code> counters total <B>{rc.onchainTimesSoldTotal}</B>.
        Of those, <B>{rc.seededPreMigration}</B> were inherited through the 2017 redeployment,{' '}
        <B>{rc.decodedPostMigration}</B> were decoded from transaction input, and{' '}
        <B>{rc.recoveredHidden}</B> was recovered from archive state because a contract — not a
        wallet — executed it.
      </div>

      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(290px,1fr))]">
        <Note title="No events to read">
          A disassembly of the runtime bytecode finds a single <Code>LOG1</Code>, and it sits inside
          the trailing metadata blob rather than reachable code. <Code>eth_getLogs</Code> returns
          nothing, so trades are decoded from raw transaction input instead.
        </Note>
        <Note title="Two contracts, not one">
          The canonical contract is itself a redeployment. Its predecessor shipped{' '}
          <Code>require(... = true)</Code> — an assignment rather than a comparison — letting anyone
          buy any rock at its last price. Rocks 0–10 carry their pre-migration counters in the new
          constructor.
        </Note>
        <Note title="Sales wallets can't see">
          Etherscan&rsquo;s transaction list only returns wallet-originated calls, so a purchase made{' '}
          <em>by a contract</em> is invisible. Those are found by diffing against{' '}
          <Code>timesSold</Code> and binary-searching an archive node for the block where the counter
          moved.
        </Note>
        <Note title="Price without tracing">
          <Code>buyRock</Code> enforces <Code>msg.value == price</Code> exactly, so the price stored
          at the buying block <em>is</em> the amount paid. That recovers hidden sale prices with no
          trace API — including rock #44, bought for <B>444 wei</B> in the same block it was listed,
          then resold for 234 ETH.
        </Note>
        <Note title="The ghost market">
          {g ? (
            <>
              The abandoned first contract still trades: <B>{nf(g.sales)}</B> buys worth{' '}
              <B>{eth(g.volumeEth)} ETH</B> since {dstr(g.firstTs)}. Those rocks are a separate,
              orphaned set — excluded from every figure above.
            </>
          ) : (
            'No activity recorded on the abandoned first contract.'
          )}
        </Note>
        <Note title="Refreshing">
          The snapshot is rebuilt offline and shipped as a static file. Keys stay server-side; this
          page ships only finished data and never holds a credential.
        </Note>
      </div>

      <p className="mt-6 border-t border-rule-faint pt-4 text-[12.5px] leading-relaxed text-dim">
        Snapshot {snapshot.generatedAt.slice(0, 16).replace('T', ' ')} UTC · block{' '}
        {nf(snapshot.headBlock)}. Sources: Ethereum mainnet via Alchemy · Etherscan · OpenSea API v2.
        Rock contract <Code>{short(snapshot.contracts.fixed)}</Code> · wrapper{' '}
        <Code>{short(snapshot.contracts.wrapper)}</Code>. Figures are reconstructed from chain data
        and reconciled against on-chain counters; verify before trading.
      </p>
    </Section>
  );
}

/* ------------------------------------------------------------------- atoms ---- */

function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card px-4 py-3.5">
      <h4 className="mb-1.5 text-[14px] font-semibold text-bone">{title}</h4>
      <p className="text-[13.5px] leading-relaxed text-ash">{children}</p>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-sunk px-1 font-mono text-[11.5px] text-ash">{children}</code>
  );
}

function B({ children }: { children: React.ReactNode }) {
  return <b className="font-semibold text-bone">{children}</b>;
}

function Key({ swatch, children }: { swatch: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="size-[11px] shrink-0 rounded-[3px]" style={{ background: swatch }} />
      {children}
    </span>
  );
}

function Addr({ address, className }: { address: string; className?: string }) {
  return (
    <a
      href={etherscan(address)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('font-mono text-rock hover:underline', className)}
    >
      {short(address)}
    </a>
  );
}
