'use client';

import * as React from 'react';
import {
  MIN_COVERAGE_FOR_VERDICT,
  PILLAR_LABEL,
  PILLAR_ORDER,
  ROCK_WEIGHTS,
  rockTierLabel,
  type RockPillars,
  type RockTier,
} from '@rockscreener/shared';
import { cn } from '@/lib/cn';

/**
 * THE CORE SAMPLE — five readings drawn as a section through the rock.
 *
 * A core is the right picture for this number and a radar chart is the wrong
 * one, for a reason that is about the data rather than about the theme. The
 * five pillars are NOT five equal axes: safety is worth 28% of the grade and
 * momentum 10%, and a pentagon draws both as the same spoke. Here each stratum
 * is as THICK as its weight, so the shape of the core tells you what the score
 * is mostly made of before you read a single label.
 *
 * AN UNMEASURED PILLAR IS A VOID IN THE CORE — hatched, unfilled, obviously a
 * gap in the sample rather than a thin layer. This is the one idea the whole
 * system is built to protect: a chart that plots a missing reading at zero says
 * "this token scored nothing on safety", which is a claim about the token; the
 * honest statement is "nobody has read its safety yet", which is a claim about
 * us. Every layer below this — the scorer returning null, `coverage` reporting
 * how much was measured, auto-trade refusing a provisional score — exists to
 * keep those two apart, and this is where the distinction finally reaches an
 * eye.
 *
 * THE DRAWING IS NEVER THE ONLY CARRIER. The number sits beside it and the tier
 * label under it, because roughly one man in twelve cannot separate the middle
 * three tier hues, and because a stack of bands is not a quantity.
 */

export const TIER_TEXT: Record<RockTier, string> = {
  diamond: 'text-tier-diamond',
  solid: 'text-tier-solid',
  rough: 'text-tier-rough',
  brittle: 'text-tier-brittle',
  dust: 'text-tier-dust',
};

export const TIER_VAR: Record<RockTier, string> = {
  diamond: 'var(--color-tier-diamond)',
  solid: 'var(--color-tier-solid)',
  rough: 'var(--color-tier-rough)',
  brittle: 'var(--color-tier-brittle)',
  dust: 'var(--color-tier-dust)',
};

/** Diagonal hatching, in the rule colour. Used everywhere a reading is absent. */
export const VOID_HATCH =
  'repeating-linear-gradient(118deg, var(--color-rule) 0 2px, transparent 2px 6px)';

const TOTAL_WEIGHT = PILLAR_ORDER.reduce((sum, k) => sum + ROCK_WEIGHTS[k], 0);

/**
 * The compact core, for a feed card.
 *
 * Deliberately narrow and tall: it sits in the left gutter of a card the way a
 * sample sits in a tray, and its silhouette is recognisable at a glance from
 * across a scrolling column — which is the whole job of a verdict glyph in a
 * feed.
 */
export function CoreSample({
  pillars,
  tier,
  coverage,
  width = 26,
  height = 44,
  className,
}: {
  pillars: RockPillars;
  tier: RockTier;
  coverage: number;
  width?: number;
  height?: number;
  className?: string;
}) {
  const colour = TIER_VAR[tier];
  const provisional = coverage < MIN_COVERAGE_FOR_VERDICT;

  return (
    <div
      className={cn(
        'relative shrink-0 overflow-hidden rounded-[3px] border border-rule-faint bg-sunk',
        className
      )}
      style={{ width, height }}
      aria-hidden="true"
    >
      {PILLAR_ORDER.map((key) => {
        const value = pillars[key];
        const share = (ROCK_WEIGHTS[key] / TOTAL_WEIGHT) * 100;
        return (
          <div
            key={key}
            className="relative w-full"
            style={{
              height: `${share}%`,
              /* A hairline between strata, so the layers read as deposited
                 rather than as one gradient. */
              boxShadow: 'inset 0 -1px 0 #00000059',
            }}
          >
            {value === null ? (
              <div className="absolute inset-0" style={{ backgroundImage: VOID_HATCH, opacity: 0.6 }} />
            ) : (
              <div
                className="absolute inset-y-0 left-0 transition-[width] duration-500"
                style={{
                  width: `${Math.max(4, value)}%`,
                  background: colour,
                  opacity: provisional ? 0.45 : 0.85,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The verdict glyph: the core, the number, and the tier.
 *
 * One component rather than three call sites arranging the same three things,
 * because the number must never appear without the core beside it. A bare 88 is
 * exactly the thing this product exists not to publish.
 */
export function Verdict({
  pillars,
  score,
  tier,
  coverage,
  className,
}: {
  pillars: RockPillars;
  score: number;
  tier: RockTier;
  coverage: number;
  className?: string;
}) {
  const provisional = coverage < MIN_COVERAGE_FOR_VERDICT;
  return (
    <div className={cn('flex shrink-0 items-center gap-1.5', className)}>
      <CoreSample pillars={pillars} tier={tier} coverage={coverage} />
      <div className="leading-none">
        <div className={cn('tnum text-[16px] font-bold', TIER_TEXT[tier], provisional && 'opacity-65')}>
          {Math.round(score)}
        </div>
        <div className={cn('label mt-1', provisional && 'text-warn')}>
          {provisional ? 'prov.' : rockTierLabel(tier).toLowerCase()}
        </div>
      </div>
      <span className="sr-only">
        {`Rock score ${score} of 100, ${rockTierLabel(tier)}. ${coverage}% of this token could be measured.`}
      </span>
    </div>
  );
}

/** The unscored glyph: an empty tray, and it says so. */
export function NoCore({ className }: { className?: string }) {
  return (
    <div className={cn('flex shrink-0 items-center gap-1.5', className)}>
      <div
        className="h-[44px] w-[26px] shrink-0 rounded-[3px] border border-dashed border-rule bg-sunk/50"
        aria-hidden="true"
      />
      <div className="leading-none">
        <div className="tnum text-[16px] font-bold text-dim">{'—'}</div>
        <div className="label mt-1">unscored</div>
      </div>
    </div>
  );
}

/**
 * The labelled core, for the drawer and the token page.
 *
 * Read left to right: the stratum, how much of the grade it is worth, and what
 * it came out at. An unread stratum prints the WORD "unread" rather than a
 * blank or a zero — an empty bar and a zero bar are the same pixels and they
 * are opposite facts.
 */
export function CoreStrata({
  pillars,
  tier,
  className,
}: {
  pillars: RockPillars;
  tier: RockTier;
  className?: string;
}) {
  const colour = TIER_VAR[tier];
  return (
    <div className={cn('overflow-hidden rounded-[var(--radius-sm)] border border-rule-faint', className)}>
      {PILLAR_ORDER.map((key) => {
        const value = pillars[key];
        const weight = Math.round(ROCK_WEIGHTS[key] * 100);
        return (
          <div
            key={key}
            className="relative flex items-center gap-2 bg-sunk px-2.5"
            style={{
              /* Height carries the weight here too, so the drawer and the card
                 are the same drawing at two sizes rather than two charts. */
              height: `${22 + weight * 0.55}px`,
              boxShadow: 'inset 0 -1px 0 var(--color-rule-faint)',
            }}
          >
            {value === null ? (
              <div
                className="absolute inset-0"
                style={{ backgroundImage: VOID_HATCH, opacity: 0.5 }}
              />
            ) : (
              <div
                className="absolute inset-y-0 left-0 transition-[width] duration-500"
                style={{ width: `${Math.max(3, value)}%`, background: colour, opacity: 0.16 }}
              />
            )}

            <span className="relative z-1 w-[5.5rem] shrink-0 text-[12px] font-medium text-bone">
              {PILLAR_LABEL[key]}
            </span>
            <span className="label relative z-1">{weight}% of the grade</span>
            <span
              className={cn(
                'tnum relative z-1 ml-auto text-[13px] font-semibold',
                value === null ? 'text-dim' : TIER_TEXT[tier]
              )}
            >
              {value === null ? 'unread' : Math.round(value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The coverage line. It says the same thing twice on purpose — as a number and
 * as a consequence — because "62% measured" means nothing to a first-time
 * reader and "provisional" means nothing to somebody comparing two tokens.
 */
export function CoverageNote({ coverage, className }: { coverage: number; className?: string }) {
  const provisional = coverage < MIN_COVERAGE_FOR_VERDICT;
  return (
    <p className={cn('text-[11px] leading-relaxed', provisional ? 'text-warn' : 'text-dim', className)}>
      {provisional
        ? `Provisional — only ${coverage}% of this token could be measured. Auto-trade refuses anything under ${MIN_COVERAGE_FOR_VERDICT}%.`
        : `${coverage}% of this token could be measured.`}
    </p>
  );
}

/**
 * The core, laid on its side, for a dense table row.
 *
 * SAME DRAWING, SAME RULES, ROTATED. Each segment is as wide as its pillar's
 * weight and as full as its score, and an unread pillar is the same hatched
 * void it is everywhere else. Rotating it rather than inventing a second glyph
 * matters: a reader who has learned the core in the drawer must not have to
 * learn a different mark in the table, and the void is the one thing that has
 * to survive every size this product draws it at.
 *
 * At 8 pixels tall it is a TEXTURE, not a reading — the eye picks up "mostly
 * full", "mostly empty", "has gaps" from thirty rows at once, and the exact
 * numbers are one click away in the drawer. That is the correct division of
 * labour for a table nobody reads a single row of.
 */
export function CoreStrip({
  pillars,
  tier,
  coverage,
  width = 58,
  height = 9,
  className,
}: {
  pillars: RockPillars;
  tier: RockTier;
  coverage: number;
  width?: number;
  height?: number;
  className?: string;
}) {
  const colour = TIER_VAR[tier];
  const provisional = coverage < MIN_COVERAGE_FOR_VERDICT;

  return (
    <span
      className={cn('flex shrink-0 overflow-hidden rounded-[2px] bg-sunk', className)}
      style={{ width, height }}
      aria-hidden="true"
    >
      {PILLAR_ORDER.map((key) => {
        const value = pillars[key];
        const share = (ROCK_WEIGHTS[key] / TOTAL_WEIGHT) * 100;
        return (
          <span
            key={key}
            className="relative block h-full"
            style={{ width: `${share}%`, boxShadow: 'inset -1px 0 0 #00000066' }}
          >
            {value === null ? (
              <span
                className="absolute inset-0 block"
                style={{ backgroundImage: VOID_HATCH, opacity: 0.65 }}
              />
            ) : (
              <span
                className="absolute inset-x-0 bottom-0 block"
                style={{
                  height: `${Math.max(8, value)}%`,
                  background: colour,
                  opacity: provisional ? 0.4 : 0.8,
                }}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}
