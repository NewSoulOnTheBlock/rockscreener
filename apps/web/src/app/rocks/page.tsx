import { EtherRockBoard } from '@/components/etherrock/board';

/**
 * THE ETHERROCK BOARD — the other rocks.
 *
 * It sits below "How it works" because it is not part of the screener: nothing
 * here is graded, nothing is called, and no number on it can be acted on with
 * the trade panel. It is a finished reconstruction of a hundred-item Ethereum
 * collection whose contract emits no events at all, kept here because the
 * problem it solves is the one this product argues about everywhere else —
 * what you are allowed to claim when the chain will not simply tell you.
 */
export const metadata = { title: 'EtherRock — RockScreener' };

export default function RocksPage() {
  return (
    <article className="mx-auto w-full max-w-[84rem] px-4 py-6 sm:px-6">
      <header className="mb-8">
        <h1 className="font-display text-[32px] leading-none text-bone sm:text-[38px]">
          EtherRock market monitor
        </h1>
        <p className="mt-2 max-w-[44rem] text-[13px] leading-relaxed text-ash">
          A hundred rocks on Ethereum, two markets that cannot overlap, and a contract from 2017
          that emits no events — so every figure below was decoded from raw transaction input and
          reconciled against the contract&rsquo;s own counters.
        </p>
      </header>

      <EtherRockBoard />
    </article>
  );
}
