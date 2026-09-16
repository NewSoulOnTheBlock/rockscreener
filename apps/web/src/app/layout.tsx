import type { Metadata, Viewport } from 'next';
import { Instrument_Serif, JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { MobileNav } from '@/components/mobile-nav';
import { Providers } from '@/components/providers';
import { Sidebar } from '@/components/sidebar';
import { StatusLine } from '@/components/status-line';

/**
 * THE TYPE SYSTEM — three faces, and each of them earns its place.
 *
 * PLUS JAKARTA SANS carries the interface AND the data. It has a tall x-height
 * and properly drawn tabular figures, so a column of market caps lines up down
 * its length without a monospace face. It is deliberately not Inter: the default
 * UI sans is the fastest way to make a product look assembled rather than
 * designed.
 *
 * INSTRUMENT SERIF is for page titles only. One editorial serif at the top of a
 * screen is a signature; the same serif inside a table is a costume.
 *
 * JETBRAINS MONO is reserved for text that is genuinely machine written: mints,
 * signatures, wallet addresses. Those are the only places where the reader is
 * checking the shape of each character rather than reading a word — and putting
 * mono on every number is most of what makes a product read as instrumentation.
 */
const instrument = Instrument_Serif({
  subsets: ['latin', 'latin-ext'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument',
  display: 'swap',
});

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-jakarta',
  display: 'swap',
});

const jet = JetBrains_Mono({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-jet',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'RockScreener — Solana, cut and graded',
  description:
    'Every Solana launch indexed, graded and tracked. Launch-slot bundle analysis, funding clusters, creator records, and auto-trade that refuses what it cannot verify.',
  applicationName: 'RockScreener',
};

export const viewport: Viewport = {
  themeColor: '#0b0c0d',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${instrument.variable} ${jakarta.variable} ${jet.variable}`}>
      <body className="min-h-dvh antialiased">
        {/*
          The aurora, and it is furniture: fixed, behind everything, and
          announced to nobody. See `.aurora` in globals.css for why it is a
          stone-coloured mass with two faint Solana hues rather than the three
          saturated blobs this effect usually ships as.
        */}
        <div className="aurora" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        <Providers>
          {/*
            The bench: a fixed sidebar, a scrolling workspace, a status line
            pinned to the bottom. GRID RATHER THAN FLEX because the sidebar must
            not participate in the workspace's own scroll — navigation that
            scrolls away is navigation you lose your place in.

            ONE COLUMN ON A PHONE. Below `lg` the sidebar is removed entirely
            rather than collapsed, and `MobileNav` floats at the bottom where
            the thumb is.
          */}
          <div className="above-aurora grid min-h-dvh grid-cols-1 grid-rows-[1fr_auto] lg:grid-cols-[auto_1fr]">
            <Sidebar />
            {/*
              The bottom padding is the floating bar's seat. Without it the last
              row of every feed sits underneath it — the one bug this pattern
              always ships with. It exists only while the bar does.
            */}
            <main className="min-w-0 overflow-x-hidden pb-[calc(var(--statusline)+5rem)] lg:pb-0">
              {children}
            </main>
            <MobileNav />
            <StatusLine className="lg:col-span-2" />
          </div>
        </Providers>
      </body>
    </html>
  );
}
