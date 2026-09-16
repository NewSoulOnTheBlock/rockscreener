import type {
  AutoPosition,
  AutoTradeEvent,
  AutoTradeSettings,
  Call,
  CallRecord,
  CursorPage,
  HolderRow,
  RockGate,
  RockScore,
  ScreenerQuery,
  Session,
  SystemStatus,
  TokenDetail,
  TokenSummary,
  TradingWallet,
} from '@rockscreener/shared';
import {
  MOCK_CALLED,
  MOCK_CALLS,
  MOCK_EVENTS,
  MOCK_POSITIONS,
  MOCK_RECORD,
  MOCK_SETTINGS,
  MOCK_STATUS,
  MOCK_TOKENS,
  MOCK_WALLETS,
  mockDetail,
  mockGate,
  mockHolders,
  mockScore,
} from './mock';

/**
 * The one place the interface talks to anything.
 *
 * RIGHT NOW IT TALKS TO A FIXTURE. `NEXT_PUBLIC_API_URL` is unset, so every
 * method below answers out of `lib/mock.ts` after a short, deliberate delay —
 * the delay is not decoration, it is what makes the loading states real enough
 * to be designed against. Set the variable and every method switches to `fetch`
 * with no other change anywhere in the app, because nothing outside this file
 * knows which of the two it got.
 *
 * THE RETURN TYPES ARE THE WIRE CONTRACT, imported from @rockscreener/shared.
 * That is what makes the swap safe: a mock that satisfies the same interface the
 * server will satisfy cannot quietly drift into a shape the server never sends —
 * which is the usual way a mocked front end turns out to need a rewrite on the
 * day the API arrives.
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

/** True while this build has no backend to talk to. */
export const USING_MOCK = BASE === '';

/** Enough delay to see a skeleton; little enough not to be annoying. */
const LATENCY_MS = 180;

function later<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * TWO READERS, BECAUSE THERE ARE TWO ENVELOPE SHAPES.
 *
 * The contract in @rockscreener/shared is "every success is `{ data, ... }`",
 * and a paginated endpoint uses that same envelope with one extra field:
 * `{ data: [...], nextCursor }`. So `CursorPage` IS the envelope, not something
 * inside it — and unwrapping `body.data` for a paginated route hands back the
 * bare array, after which the caller's own `.data` is `undefined` and the
 * screener renders zero rows against an API that is answering perfectly.
 *
 * That is exactly what happened, and it is why the two are separate functions
 * rather than one with a flag: the shape is a property of the ROUTE, and a
 * caller choosing the wrong reader now fails to compile instead of failing
 * silently at runtime.
 */
async function fetchJson(path: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  // Cookies carry the session; the API is on another origin in production.
  const res = await fetch(url, { credentials: 'include' });
  const body = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `The API answered ${res.status}.`);
  }
  return body ?? {};
}

/** A route whose payload sits under `data`. */
async function get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  return (await fetchJson(path, params)).data as T;
}

/** A paginated route, where the envelope itself is the page. */
async function getPage<T>(path: string, params?: Record<string, unknown>): Promise<CursorPage<T>> {
  const body = await fetchJson(path, params);
  return { data: (body.data ?? []) as T[], nextCursor: (body.nextCursor ?? null) as string | null };
}

async function send<T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) throw new Error(parsed?.error?.message ?? `The API answered ${res.status}.`);
  return parsed.data as T;
}

/* ------------------------------------------------------------------ mock -- */

function mockScreener(q: ScreenerQuery): CursorPage<TokenSummary> {
  let rows = [...MOCK_TOKENS];

  switch (q.preset) {
    case 'calls':
      rows = [...MOCK_CALLED];
      break;
    case 'rocks':
      /*
       * The graded shortlist HOLDS BACK PROVISIONAL SCORES. A 91 computed from
       * two of five pillars is not a better token than a measured 74, and a
       * lane that sorts them together teaches the reader to trust the number
       * least when it is most confident-looking.
       */
      rows = rows
        .filter((t) => t.rock && t.rock.coverage >= 60)
        .sort((a, b) => b.rock!.score - a.rock!.score);
      break;
    case 'bonding':
      // Nulls last, as the server orders them: a curve nobody has read is not
      // a curve at zero.
      rows = rows
        .filter((t) => t.status === 'BONDING')
        .sort((a, b) => (b.progressBps ?? -1) - (a.progressBps ?? -1));
      break;
    case 'graduated':
      rows = rows
        .filter((t) => t.status === 'MIGRATED')
        .sort((a, b) => Date.parse(b.migratedAt ?? '0') - Date.parse(a.migratedAt ?? '0'));
      break;
    case 'watchlist':
      rows = [];
      break;
    case 'new':
    default:
      rows = rows.sort((a, b) => Date.parse(b.launchTime) - Date.parse(a.launchTime));
  }

  if (q.search) {
    const needle = q.search.toLowerCase();
    rows = rows.filter(
      (t) =>
        t.symbol.toLowerCase().includes(needle) ||
        t.name.toLowerCase().includes(needle) ||
        t.mint.toLowerCase().startsWith(needle)
    );
  }
  if (q.scoredOnly) rows = rows.filter((t) => t.rock !== null);
  if (q.minScore !== undefined) rows = rows.filter((t) => (t.rock?.score ?? -1) >= q.minScore!);

  return { data: rows.slice(0, q.limit ?? 60), nextCursor: null };
}

function findToken(mint: string): TokenSummary {
  const t = MOCK_TOKENS.find((x) => x.mint === mint);
  if (!t) throw new Error('No token with that mint is indexed.');
  return t;
}

/* -------------------------------------------------------------------- api -- */

export const api = {
  screener(q: ScreenerQuery = {}): Promise<CursorPage<TokenSummary>> {
    if (USING_MOCK) return later(mockScreener(q));
    return getPage<TokenSummary>('/screener', q as Record<string, unknown>);
  },

  token(mint: string): Promise<TokenDetail> {
    if (USING_MOCK) return later(mockDetail(findToken(mint)));
    return get<TokenDetail>(`/tokens/${mint}`);
  },

  score(mint: string): Promise<RockScore | null> {
    if (USING_MOCK) return later(mockScore(findToken(mint)));
    return get<RockScore | null>(`/tokens/${mint}/score`);
  },

  holders(mint: string): Promise<HolderRow[]> {
    if (USING_MOCK) return later(mockHolders(findToken(mint)));
    return get<HolderRow[]>(`/tokens/${mint}/holders`);
  },

  calls(): Promise<Call[]> {
    if (USING_MOCK) return later(MOCK_CALLS);
    return get<Call[]>('/calls');
  },

  record(windowHours = 168): Promise<CallRecord> {
    if (USING_MOCK) return later({ ...MOCK_RECORD, windowHours });
    return get<CallRecord>('/calls/record', { windowHours });
  },

  status(): Promise<SystemStatus> {
    if (USING_MOCK) return later(MOCK_STATUS, 60);
    return get<SystemStatus>('/status');
  },

  /**
   * The session. In mock mode NOBODY IS SIGNED IN by default — the signed-out
   * shell is what every first visitor sees and it has to be the state the
   * design is checked in. `?demo=in` signs a fixture in.
   */
  session(): Promise<Session | null> {
    if (USING_MOCK) {
      const demo = typeof window !== 'undefined' && window.location.search.includes('demo=in');
      return later(
        demo
          ? {
              userId: 'u_1',
              address: MOCK_WALLETS[0]!.address,
              via: 'wallet',
              telegramUsername: null,
              displayName: null,
              avatarUrl: null,
              isAdmin: false,
            }
          : null,
        60
      );
    }
    return get<Session | null>('/auth/session');
  },

  /**
   * The ROCK gate. LOCKED in mock mode unless `?gate=open` — see `mockGate`.
   */
  /**
   * The ROCK gate. `refresh` bypasses the server's cache, for the "Re-check"
   * button — somebody who has just bought ROCK should not wait out a TTL.
   */
  gate(refresh = false): Promise<RockGate> {
    if (USING_MOCK) {
      const open = typeof window !== 'undefined' && window.location.search.includes('gate=open');
      return later(mockGate(open));
    }
    return get<RockGate>('/auto/gate', refresh ? { refresh: true } : undefined);
  },

  /** Which sign-in buttons this deployment can actually complete. */
  authMethods(): Promise<{ wallet: boolean; telegram: boolean; wallets: boolean }> {
    if (USING_MOCK) return later({ wallet: false, telegram: false, wallets: false });
    return get('/auth/methods');
  },

  /** The exact text this server wants signed. Never text we invent here. */
  nonce(address: string): Promise<{ message: string; expiresAt: string }> {
    return get('/auth/nonce', { address });
  },

  verifyWallet(address: string, signature: string): Promise<Session> {
    return send<Session>('/auth/verify', 'POST', { address, signature });
  },

  verifyTelegram(payload: Record<string, unknown>): Promise<Session> {
    return send<Session>('/auth/telegram', 'POST', payload);
  },

  linkWallet(address: string, signature: string): Promise<{ address: string }> {
    return send('/wallets/link', 'POST', { address, signature });
  },

  createWallet(label?: string): Promise<TradingWallet> {
    return send<TradingWallet>('/wallets', 'POST', { label });
  },

  linkedWallets(): Promise<{ address: string; verifiedAt: string }[]> {
    if (USING_MOCK) return later([]);
    return get('/wallets/linked');
  },

  unlinkWallet(address: string): Promise<void> {
    return send<void>(`/wallets/linked/${address}`, 'DELETE');
  },

  /**
   * A price, before anybody commits to anything. Signs nothing and touches no
   * key, so it is safe to call as an amount field changes.
   */
  tradeQuote(
    mint: string,
    side: 'buy' | 'sell',
    amount: string
  ): Promise<{ inAmount: string; outAmount: string; priceImpactPct: number } | null> {
    if (USING_MOCK) return later(null);
    return get('/trade/quote', { mint, side, amount });
  },

  /** A ticket the user pressed. Fills from their own custodial wallet. */
  trade(input: {
    mint: string;
    side: 'buy' | 'sell';
    amountLamports?: string;
    percent?: number;
    slippageBps?: number;
  }): Promise<{ signature: string; lamports: string; tokens: string }> {
    return send('/trade', 'POST', input);
  },

  creators(): Promise<
    {
      address: string;
      launches: number;
      bestMarketCapUsd: number | null;
      lastLaunchAt: string | null;
      history: { rugged: number; survived: number; reputation: string | null } | null;
    }[]
  > {
    if (USING_MOCK) return later([]);
    return get('/creators');
  },

  autoSettings(): Promise<AutoTradeSettings> {
    if (USING_MOCK) return later(MOCK_SETTINGS);
    return get<AutoTradeSettings>('/auto/settings');
  },

  saveAutoSettings(settings: AutoTradeSettings): Promise<AutoTradeSettings> {
    if (USING_MOCK) return later(settings, 320);
    return send<AutoTradeSettings>('/auto/settings', 'PATCH', settings);
  },

  positions(): Promise<AutoPosition[]> {
    if (USING_MOCK) return later(MOCK_POSITIONS);
    return get<AutoPosition[]>('/auto/positions');
  },

  events(): Promise<AutoTradeEvent[]> {
    if (USING_MOCK) return later(MOCK_EVENTS);
    return get<AutoTradeEvent[]>('/auto/events');
  },

  wallets(): Promise<TradingWallet[]> {
    if (USING_MOCK) return later(MOCK_WALLETS);
    return get<TradingWallet[]>('/wallets');
  },

  signOut(): Promise<void> {
    if (USING_MOCK) return later(undefined);
    return send<void>('/auth/signout', 'POST');
  },
};
