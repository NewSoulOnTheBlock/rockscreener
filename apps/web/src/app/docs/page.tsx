import { MIN_COVERAGE_FOR_VERDICT, PILLAR_LABEL, PILLAR_ORDER, ROCK_GATE_USD, ROCK_WEIGHTS } from '@rockscreener/shared';
import { Panel, PanelHead } from '@/components/ui/panel';

/**
 * WHAT THE GRADE MEANS, and — more importantly — WHAT IT REFUSES TO CLAIM.
 *
 * This page exists so the masthead can be one line. It is also the page that
 * makes the product arguable: every threshold here is a decision somebody made,
 * and a screener that will not say what its number is built from is asking to
 * be trusted rather than checked.
 */
export const metadata = { title: 'How the grade works — RockScreener' };

export default function DocsPage() {
  return (
    <article className="mx-auto w-full max-w-[52rem] px-4 py-6 sm:px-6">
      <h1 className="font-display text-[32px] leading-none text-bone sm:text-[38px]">
        How the grade works
      </h1>
      <p className="mt-2 max-w-[40rem] text-[13px] leading-relaxed text-ash">
        One number, five readings, and the findings behind them. The number is not the product —
        the readings are.
      </p>

      <Section title="A reading nobody took is never a reading of zero">
        <p>
          This is the rule everything else follows from. Most facts about a Solana token minutes
          old are simply unknown: the holder table has not been read, the launch analysis has not
          run, no third party has published a report. A screener that substitutes a neutral value
          for each of those produces a confident-looking number for a token nobody has checked.
        </p>
        <p>
          So every pillar is tri-state at the source. A pillar with no inputs returns{' '}
          <code className="rounded bg-sunk px-1 font-mono text-[11px] text-ash">null</code>, not
          50. The weighted sum is taken over the pillars that were <em>measured</em> and
          renormalised to their own weights, and <strong>coverage</strong> reports how much of the
          token the number actually describes. Below {MIN_COVERAGE_FOR_VERDICT}% coverage the
          score is shown as provisional and auto-trade refuses to act on it.
        </p>
        <p>
          On screen this reaches you as a stone with a facet missing: an unmeasured pillar is a
          chip cut out of the shape, never a short vertex. A dashed chip means a check that has
          not run — not a check that came back clean.
        </p>
      </Section>

      <Section title="The five readings">
        <Panel className="not-prose my-3">
          <PanelHead label="Pillars" hint="weighted for not losing money" />
          <div className="divide-y divide-rule-faint">
            {PILLAR_ORDER.map((key) => (
              <div key={key} className="flex gap-3 px-3.5 py-2.5">
                <span className="tnum w-10 shrink-0 text-[12px] text-rock">
                  {Math.round(ROCK_WEIGHTS[key] * 100)}%
                </span>
                <div>
                  <div className="text-[12px] font-semibold text-bone">{PILLAR_LABEL[key]}</div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-dim">{PILLAR_NOTE[key]}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
        <p>
          Safety and launch dominate because they are the two that take the whole position rather
          than part of it. Momentum is weighted lowest on purpose: it is the one a manipulator can
          manufacture cheaply, and the one already visible on the chart you are looking at anyway.
        </p>
        <p>
          <strong>A critical finding clamps the total</strong> rather than being averaged. A token
          with locked liquidity, a fair distribution and good momentum whose freeze authority is
          still live would otherwise score in the sixties, because four fifths of it is genuinely
          fine. It can still freeze your account.
        </p>
      </Section>

      <Section title="The launch analysis">
        <p>
          The reading this product exists for. Splitting a bag across twelve wallets defeats
          top-10 concentration, creator percentage, holder count and every other distribution
          metric there is, and on Solana it costs a fraction of a cent per wallet. What it cannot
          hide is that all twelve were funded from the same place.
        </p>
        <ul>
          <li>
            <strong>Bundle</strong> — supply taken in the token&rsquo;s first traded <em>slot</em>.
          </li>
          <li>
            <strong>Snipers</strong> — supply taken within fifteen seconds. Deliberately weighted
            far below the bundle: a fast buyer is not an insider, and a signal that fires on a
            third of all buyers is not a signal.
          </li>
          <li>
            <strong>Clusters</strong> — wallets sharing a funding source. The strongest of the
            three, because it is the one that survives the wallets being split up.
          </li>
        </ul>
      </Section>

      <Section title="The sell check">
        <p>
          Two sources, in order. <strong>What already happened</strong>: three or more unrelated
          wallets having sold in the last six hours is a record, not a simulation, and nothing can
          fake it. <strong>What would happen</strong>: for a token too new to have any, a
          real-size exit is quoted against the real router, and judged on whether it routes{' '}
          <em>and</em> on what it costs — a route that exists but returns four percent of the
          money is a honeypot with extra steps.
        </p>
        <p>
          Neither answering leaves the check <code className="rounded bg-sunk px-1 font-mono text-[11px] text-ash">null</code>,
          which is not a pass.
        </p>
      </Section>

      <Section title="Calls, and the record">
        <p>
          A score is a continuous opinion that changes every minute, so it is never wrong. A{' '}
          <strong>call</strong> is a moment: at 14:02, at a $38K market cap, this was worth
          buying. It can be measured afterwards and it can be wrong.
        </p>
        <p>
          A call is rare by construction. It has to clear the grade, a coverage floor, a closed
          launch window with the bundle actually analysed, a confirmed sell, real liquidity, a
          minimum age, and no call at the same tier in the last twelve hours. Every call is then
          tracked forever — where it was called, what it peaked at, where it is now, how far it
          fell on the way, and how it ended.
        </p>
        <p>
          The record counts every call in the window the same way, the ones that ran and the ones
          that went to zero, and it sits above the feed rather than behind a tab. It reports the
          median peak <em>and</em> the median current multiple: the gap between those two is the
          honest measure of a feed like this one, because a product that publishes only its peaks
          is showing the best moment of every call it ever made. Medians rather than means
          throughout — one 400x carries a mean and says nothing about the typical call.
        </p>
      </Section>

      <Section title="Auto-trade, and the ROCK gate">
        <p>
          The engine buys what the product called; your entry rules are a filter on top of that,
          never a competing opinion. Every refusal names its rule and both numbers, and is
          recorded whether or not anybody is watching — &ldquo;why didn&rsquo;t it buy that
          one&rdquo; is the first question anyone asks, and an engine that cannot answer it is one
          people turn off after a day.
        </p>
        <p>
          Exits are evaluated worst-news-first: a rug signal beats a stop, a stop beats a
          take-profit, and the time limit is last. Position size, concurrent positions, hourly
          spend and the daily loss cap are all required and all bounded — there is no value of any
          of them meaning &ldquo;unlimited&rdquo;, because the failure mode of automated buying is
          not one bad trade, it is forty bad trades in ninety seconds. The daily cap{' '}
          <em>disarms</em> the engine rather than pausing it.
        </p>
        <p>
          Arming requires <strong>${ROCK_GATE_USD} of ROCK held</strong> — a position, not a
          subscription. A subscription is a payment that leaves; a holding is something you keep,
          and it aligns the one feature that spends money by itself with the token whose price it
          moves. ROCK in your engine wallet and in any wallet you have linked both count.
        </p>
      </Section>

      <Section title="What this is not">
        <p>
          It is not advice, and nothing here predicts a price. It is a set of measurements about
          what a contract permits, who holds the supply, how it was distributed at launch and
          whether an exit exists — each of them stated with its own uncertainty attached. Most
          tokens on this chain go to zero. A good grade means the specific ways this one could
          already be rigged were checked, not that it will go up.
        </p>
      </Section>
    </article>
  );
}

const PILLAR_NOTE: Record<string, string> = {
  safety:
    'Mint and freeze authority, Token-2022 transfer fees, mutable metadata, and whether a real balance can actually be sold back into SOL.',
  launch:
    'Supply taken in the first traded slot, in the first fifteen seconds, and by wallets sharing a funder. Plus the creator’s own record.',
  liquidity:
    'Pool depth in dollars, depth against the valuation being asked, how much of the LP is locked or burnt, and how many markets it really trades in.',
  distribution:
    'Top-ten concentration with AMM vaults, lockers and burn excluded, the creator’s own bag, and how many holders sit behind those numbers.',
  momentum:
    'Distinct traders rather than transaction count, the buy/sell balance, turnover against depth, drawdown from its own high, and survival.',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="text-[17px] font-semibold tracking-tight text-bone">{title}</h2>
      <div className="mt-2 space-y-3 text-[13px] leading-relaxed text-ash [&_code]:text-[11px] [&_li]:mt-1 [&_strong]:text-bone [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}
