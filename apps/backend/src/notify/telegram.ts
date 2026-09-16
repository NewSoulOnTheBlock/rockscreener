import { explorerTx } from '@rockscreener/shared';
import { prisma } from '../clients/prisma.js';
import { env } from '../config/load.js';
import { Spacer } from '../infra/interval.js';
import { errField, logger } from '../infra/logger.js';

/**
 * Telling somebody their engine just spent their money.
 *
 * THE ENGINE RUNS WHILE NOBODY IS WATCHING — that is the entire point of it —
 * so a fill that only ever appears in a log nobody has open is a fill the owner
 * finds out about from their balance. This is the one outbound message this
 * product sends.
 *
 * IT IS BEST EFFORT AND NEVER BLOCKS A TRADE. A message that fails to send must
 * not fail the fill it was about, and must not be retried into a rate limit
 * while the exit loop waits behind it: every call here is fire-and-forget and
 * swallows its own errors.
 *
 * ONLY FILLS AND DISARMS. Not refusals — the engine skips dozens of tokens a
 * minute, and a notification per refusal is how somebody mutes the bot on their
 * first day and then misses the message that mattered.
 */

const log = logger.child({ module: 'telegram' });
// Telegram's documented ceiling is 30 messages a second; this is nowhere near
// it, and the spacer exists so a burst of exits cannot become a burst of posts.
const spacer = new Spacer(120);

export function notifyConfigured(): boolean {
  return env.telegramBotToken !== null;
}

async function send(chatId: string, text: string): Promise<void> {
  const token = env.telegramBotToken;
  if (!token) return;

  try {
    await spacer.wait();
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        // The link preview would be a Solscan card under every message, which
        // triples the height of a feed somebody is reading on a phone.
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.debug({ err: errField(err) }, 'telegram send failed');
  }
}

/**
 * The account's Telegram chat, if it has one.
 *
 * A wallet-only account has no chat id and gets nothing — silently, because
 * that is not a failure. The engine works identically either way.
 */
async function chatFor(userId: string): Promise<string | null> {
  const user = await prisma.user
    .findUnique({ where: { id: userId }, select: { telegramId: true } })
    .catch(() => null);
  return user?.telegramId ?? null;
}

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function notifyFill(
  userId: string,
  fill: {
    kind: 'bought' | 'sold';
    symbol: string;
    mint: string;
    sol: number;
    signature: string;
    /** The rule that caused it. Null when a person pressed the button. */
    rule: string | null;
    reason: string;
  }
): Promise<void> {
  const chat = await chatFor(userId);
  if (!chat) return;

  const verb = fill.kind === 'bought' ? 'Bought' : 'Sold';
  await send(
    chat,
    [
      `<b>${verb} ${escape(fill.symbol)}</b>  ${fill.sol.toFixed(4)} SOL`,
      escape(fill.reason),
      // The rule is included because it is the whole reason the engine is
      // trustworthy: every action names what caused it.
      fill.rule ? `<code>${escape(fill.rule)}</code>` : '<i>manual ticket</i>',
      `<a href="${explorerTx(fill.signature)}">transaction</a>`,
    ].join('\n')
  );
}

/**
 * The daily cap disarming the engine.
 *
 * The one message that is genuinely urgent: the engine has STOPPED, it will not
 * restart on its own, and open positions are still being managed. Somebody who
 * does not know that finds out tomorrow.
 */
export async function notifyDisarmed(userId: string, reason: string): Promise<void> {
  const chat = await chatFor(userId);
  if (!chat) return;

  await send(
    chat,
    [
      '<b>Auto-trade disarmed</b>',
      escape(reason),
      'Open positions are still managed — exits keep running. It will not arm again until you turn it back on.',
    ].join('\n')
  );
}
