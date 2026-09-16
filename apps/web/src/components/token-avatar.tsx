'use client';

import * as React from 'react';
import Image from 'next/image';
import { cn } from '@/lib/cn';

/**
 * A token's picture, or the rock in its place.
 *
 * MOST TOKENS HAVE NO USABLE IMAGE. The metadata points at an IPFS gateway that
 * answers in its own time or not at all, the launchpad published nothing, or
 * the art is a 4MB PNG nobody should be loading sixty of. A grey box for all of
 * them makes a column unscannable — the reader loses the one non-textual thing
 * that lets them find the same card again after a scroll.
 *
 * SO THE FALLBACK IS THE MARK, ON A TINTED PLINTH. The rock says "we could not
 * load this token's art" in the product's own voice rather than with a broken
 * image glyph, and the plinth's hue is derived FROM THE MINT — deterministic,
 * no request, the same two colours on every device and every reload — so sixty
 * fallbacks in a column are still sixty distinguishable cards rather than one
 * repeated sixty times.
 *
 * REMOTE ART IS NEVER PROXIED. It is arbitrary, attacker-supplied content from
 * an arbitrary host; it renders in a plain <img> with no optimiser touching it,
 * and a load failure falls through to the mark rather than leaving a hole.
 */
function hueOf(mint: string): number {
  let h = 0;
  for (let i = 0; i < mint.length; i += 1) h = (h * 31 + mint.charCodeAt(i)) % 360;
  return h;
}

export function TokenAvatar({
  mint,
  symbol,
  imageUrl,
  size = 40,
  className,
}: {
  mint: string;
  symbol: string;
  imageUrl: string | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = React.useState(false);

  if (imageUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn(
          'shrink-0 rounded-[var(--radius-sm)] border border-rule-faint object-cover',
          className
        )}
        style={{ width: size, height: size }}
      />
    );
  }

  const hue = hueOf(mint);

  return (
    <div
      className={cn(
        'relative grid shrink-0 place-items-center overflow-hidden rounded-[var(--radius-sm)] border border-rule-faint',
        className
      )}
      style={{
        width: size,
        height: size,
        /*
         * Low saturation, but NOT low lightness. The mark is a granite boulder
         * whose own shadow side is nearly black, so a dark plinth swallows half
         * of it and at 22px the whole tile reads as a smudge. The plinth is
         * therefore lighter than the surface it sits on — it is a lit tray, and
         * the stone has to be visible on it.
         *
         * The hue still comes from the mint, so sixty fallbacks in a column are
         * sixty distinguishable tiles rather than one repeated sixty times.
         */
        backgroundImage: `linear-gradient(145deg, hsl(${hue} 14% 34%) 0%, hsl(${(hue + 40) % 360} 12% 20%) 100%)`,
      }}
      title={`${symbol} — no artwork available`}
    >
      <Image
        src="/rock-logo.svg"
        alt=""
        width={Math.round(size * 0.8)}
        height={Math.round(size * 0.8)}
        /* Harder than `.mark-lit`: a 22px tile has a few hundred pixels to say
           "rock" with, so the contrast is pushed until the silhouette survives
           at that size rather than only at the sidebar's 38. */
        className="[filter:brightness(1.45)_contrast(1.12)_drop-shadow(0_0_0.5px_#00000099)]"
      />
    </div>
  );
}
