import { Router } from 'express';
import { z } from 'zod';
import { LAMPORTS_PER_SOL, SOL_MINT, looksLikeMint } from '@rockscreener/shared';
import { prisma } from '../../clients/prisma.js';
import { AppError } from '../../infra/errors.js';
import { logger } from '../../infra/logger.js';
import { quote } from '../../sources/jupiter.js';
import { balanceOf } from '../../sources/mint-account.js';
import { Executor, UnconfirmedTrade } from '../../trading/executor.js';
import { encryptionConfigured } from '../../trading/crypto.js';
import { resolveWallet } from '../../trading/wallets.js';
import { notifyFill } from '../../notify/telegram.js';
import { requireUser } from '../auth.js';
import { wrap } from '../middleware/error-handler.js';

/**
 * A TICKET THE USER PRESSED.
 *
 * Entirely separate from the engine, and it must stay that way. The engine's
 * entry rules are a filter somebody wrote down to be applied while they are not
 * watching; a manual trade is a person looking at a token and deciding. Running
 * a manual fill through `evaluateEntry` would mean the product refusing to let
 * somebody buy what they are looking at because of a rule they wrote for a
 * different purpose.
 *
 * WHAT IT DOES ENFORCE is the pair of facts that are not preferences: a
 * deployment with no master key cannot sign anything, and a wallet with no SOL
 * cannot pay for a transaction. Those are refusals, not opinions.
 *
 * THE WARNING IS THE UI'S JOB AND IT IS NOT DUPLICATED HERE. The trade panel
 * shows the live-freeze-authority and unconfirmed-sell warnings above the
 * amount field, because a caution read after somebody has typed a number is a
 * caution they have already decided to ignore. Refusing the request as well
 * would make the product un-usable for exactly the person who understands the
 * risk and wants the trade anyway.
 */
const TradeSchema = z.object({
  mint: z.string().refine(looksLikeMint, 'Not a Solana mint.'),
  side: z.enum(['buy', 'sell']),
  /** BUY: lamports of SOL to spend. Bounded so a units mistake cannot clear a wallet. */
  amountLamports: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
  /** SELL: share of the held balance, 1..100. */
  percent: z.number().min(1).max(100).optional(),
  slippageBps: z.number().int().min(10).max(5_000).default(500),
  maxPriorityFeeLamports: z
    .string()
    .regex(/^\d{1,20}$/)
    .default('2000000'),
});

export function tradeRouter(): Router {
  const router = Router();
  const executor = new Executor(logger);

  /**
   * A price, before anybody commits to anything.
   *
   * The panel calls this as the amount changes, so it is a QUOTE and never a
   * fill: it signs nothing, touches no key, and is safe to call on a keystroke.
   */
  router.get(
    '/trade/quote',
    wrap(async (req, res) => {
      const mint = String(req.query.mint ?? '');
      if (!looksLikeMint(mint)) throw AppError.badRequest('Not a Solana mint.');
      const side = req.query.side === 'sell' ? 'sell' : 'buy';
      const amount = String(req.query.amount ?? '0');
      if (!/^\d{1,20}$/.test(amount) || amount === '0') {
        throw AppError.badRequest('Give an amount in base units.');
      }

      const routed =
        side === 'buy'
          ? await quote(SOL_MINT, mint, amount, 500)
          : await quote(mint, SOL_MINT, amount, 500);

      if (!routed) {
        // Not an error: "no route" is the answer, and on a sell it is the
        // finding the whole sell check exists to surface.
        res.json({ data: null });
        return;
      }

      res.json({
        data: {
          inAmount: routed.inAmount,
          outAmount: routed.outAmount,
          priceImpactPct: routed.priceImpactPct,
        },
      });
    })
  );

  router.post(
    '/trade',
    wrap(async (req, res) => {
      const userId = requireUser(req);

      if (!encryptionConfigured()) {
        throw AppError.unavailable(
          'WALLET_NOT_CONFIGURED',
          'This deployment has no WALLET_MASTER_KEY, so it cannot sign a trade.'
        );
      }

      const parsed = TradeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw AppError.badRequest(parsed.error.issues[0]?.message ?? 'That trade is not valid.');
      }
      const input = parsed.data;

      const token = await prisma.token.findUnique({ where: { mint: input.mint } });
      if (!token) throw AppError.notFound('Nothing is indexed under that mint.');

      const settings = await prisma.autoSettings.findUnique({ where: { userId } });
      const wallet = await resolveWallet(userId, settings?.walletId ?? null);

      const priority = BigInt(input.maxPriorityFeeLamports);

      if (input.side === 'buy') {
        if (!input.amountLamports) throw AppError.badRequest('Give an amount to spend.');
        const lamports = BigInt(input.amountLamports);
        // Ten SOL a ticket. The number this guards against is not a large trade,
        // it is the one with three extra zeros typed into a field whose units
        // are lamports.
        if (lamports > 10n * BigInt(LAMPORTS_PER_SOL)) {
          throw AppError.badRequest('That is more than a single manual ticket may spend.');
        }

        const fill = await executor
          .buy(wallet, input.mint, lamports, input.slippageBps, priority)
          .catch(unconfirmed);
        if ('pending' in fill) {
          await record(userId, input.mint, token.symbol, 'bought', fill.signature, 0n, 'Broadcast by hand; confirmation not seen.');
          res.json({ data: fill });
          return;
        }
        await record(userId, input.mint, token.symbol, 'bought', fill.signature, fill.lamports, 'Bought by hand.');
        res.json({
          data: { signature: fill.signature, lamports: fill.lamports.toString(), tokens: fill.tokens.toString() },
        });
        return;
      }

      /*
       * A SELL IS SIZED FROM THE CHAIN, NOT FROM A NUMBER THE CLIENT SENT.
       *
       * The browser's idea of the balance is whatever it last rendered, and a
       * swap for more than the wallet holds fails outright. Reading it here also
       * makes "sell 100%" mean the whole position rather than the whole position
       * as it was when the page loaded.
       */
      const held = await balanceOf(wallet.address, input.mint);
      if (held <= 0n) throw AppError.badRequest('That wallet holds none of this token.');

      const percent = BigInt(Math.round(input.percent ?? 100));
      const selling = percent >= 100n ? held : (held * percent) / 100n;

      const fill = await executor
        .sell(wallet, input.mint, selling, input.slippageBps, priority)
        .catch(unconfirmed);
      if ('pending' in fill) {
        await record(userId, input.mint, token.symbol, 'sold', fill.signature, 0n, 'Broadcast by hand; confirmation not seen.');
        res.json({ data: fill });
        return;
      }
      await record(userId, input.mint, token.symbol, 'sold', fill.signature, fill.lamports, `Sold ${input.percent ?? 100}% by hand.`);
      res.json({
        data: { signature: fill.signature, lamports: fill.lamports.toString(), tokens: fill.tokens.toString() },
      });
    })
  );

  return router;
}

/**
 * A broadcast trade whose confirmation was not seen is answered as a RESULT,
 * not as an error.
 *
 * An error response says "that did not happen", and here it might well have —
 * the signature exists and the money may already be gone. Returning it with
 * `pending` lets the page send the user to the explorer for their own answer,
 * which is the only honest thing to show; a red toast saying the trade failed
 * would be a claim this server cannot support.
 */
function unconfirmed(err: unknown): { pending: true; signature: string; message: string } {
  if (err instanceof UnconfirmedTrade) {
    return {
      pending: true,
      signature: err.signature,
      message:
        'The transaction was broadcast but not confirmed in time. It may still land — check the signature on the explorer before trying again.',
    };
  }
  throw err;
}

/**
 * Manual fills land in the SAME event log as the engine's.
 *
 * One timeline, because the question a user asks of that page is "what happened
 * to my money", and an answer that omitted every trade they made themselves
 * would not be one. `rule: null` is what distinguishes them: an engine fill
 * names the rule that caused it, and a manual fill was caused by a person.
 */
async function record(
  userId: string,
  mint: string,
  symbol: string,
  kind: 'bought' | 'sold',
  signature: string,
  lamports: bigint,
  message: string
): Promise<void> {
  const sol = Number(lamports) / LAMPORTS_PER_SOL;

  // Same notification path as an engine fill, with `rule: null` — which is what
  // distinguishes "you did this" from "your rules did this" in the message.
  void notifyFill(userId, {
    kind,
    symbol,
    mint,
    sol,
    signature,
    rule: null,
    reason: message,
  });

  await prisma.autoEvent
    .create({
      data: {
        userId,
        kind,
        mint,
        symbol,
        rule: null,
        message: `${message} ${sol.toFixed(4)} SOL.`,
        signature,
      },
    })
    .catch(() => undefined);
}
