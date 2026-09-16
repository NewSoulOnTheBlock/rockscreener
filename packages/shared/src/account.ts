/**
 * Who is signed in, and what that entitles them to.
 *
 * TWO WAYS IN, ONE ACCOUNT. A Solana wallet signature proves control of an
 * address; a Telegram login proves control of an account. Neither is better and
 * both land on the same row, because the thing a person actually wants back is
 * their rules and their positions, not their login method.
 */
export interface Session {
  userId: string;
  /** The wallet the session signed in with, or the custodial one it was given. */
  address: string | null;
  /** How they proved it. Shown in settings so nobody is surprised. */
  via: 'wallet' | 'telegram';
  telegramUsername: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
}

/**
 * The ROCK holding that opens auto-trade.
 *
 * WHY A HOLDING RATHER THAN A SUBSCRIPTION. A subscription is a payment that
 * leaves; a holding is a position the holder keeps, and it aligns the one
 * feature that spends money automatically with the token whose price it moves.
 * It is also checkable on-chain in one call, with no invoice, no expiry and
 * nothing to refund.
 *
 * EVERY FIELD IS A MEASUREMENT, and `checkedAt` is what makes the banner
 * honest. A balance read four minutes ago is not a fact about now, and a user
 * whose position just moved is entitled to know whether the number in front of
 * them is stale rather than wrong.
 */
export interface RockGate {
  /** Whether auto-trade is open to this account right now. */
  unlocked: boolean;
  /** Dollar value of ROCK required. Server-side truth, not a client constant. */
  requiredUsd: number;
  /** What the account actually holds, across every wallet it has proven. */
  heldUsd: number;
  /** The same in whole ROCK, for the number people recognise. */
  heldTokens: number;
  /** Shortfall in dollars, or zero when unlocked. */
  missingUsd: number;
  /**
   * Live ROCK price, so the page can say WHY the requirement moved.
   *
   * Null when no source answered — and when it is null the gate reports
   * `unlocked: false` with `reason` saying so, rather than guessing a price. A
   * gate that fails open on a pricing outage is not a gate.
   */
  priceUsd: number | null;
  /** Per-wallet breakdown, so somebody holding in the wrong wallet can see it. */
  wallets: { address: string; kind: 'custodial' | 'linked'; tokens: number }[];
  /** One sentence, already fit to render. Null when unlocked. */
  reason: string | null;
  /** ISO-8601 of the read. */
  checkedAt: string;
}

/**
 * A custodial trading wallet.
 *
 * The private key is encrypted at rest with a master key that lives only in the
 * process environment — never in the database, never in a log, never in any
 * response. `exportable` says whether this deployment will ever hand the key
 * back; a wallet that cannot be exported is a wallet a user cannot rescue, and
 * saying so up front is the difference between a policy and a surprise.
 */
export interface TradingWallet {
  id: string;
  address: string;
  label: string | null;
  /** Lamports, as a decimal string. */
  solLamports: string;
  /** ROCK held by this wallet, whole tokens. Counts toward the gate. */
  rockTokens: number;
  isDefault: boolean;
  exportable: boolean;
  createdAt: string;
}
