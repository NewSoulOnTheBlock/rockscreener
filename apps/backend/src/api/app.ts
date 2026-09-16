import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { env } from '../config/load.js';
import { sessionLoader } from './auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { autoRouter } from './routes/auto.js';
import { authRouter } from './routes/auth.js';
import { callsRouter } from './routes/calls.js';
import { screenerRouter } from './routes/screener.js';
import { statusRouter } from './routes/status.js';
import { tradeRouter } from './routes/trade.js';
import { tokensRouter } from './routes/tokens.js';
import { walletsRouter } from './routes/wallets.js';

/**
 * The HTTP surface.
 *
 * BUILT AS A FUNCTION rather than as a module-level app, so the test suite can
 * stand one up per case without a listening socket and without module state
 * leaking between them.
 *
 * CORS IS AN ALLOWLIST WITH CREDENTIALS. `credentials: true` and a wildcard
 * origin are mutually exclusive by specification, and anything that "works"
 * with both is a browser being lenient — so the origins are named, and a
 * request from anywhere else simply does not get the session cookie.
 */
export function createApp(): Express {
  const app = express();

  // Behind a load balancer in production: without this, `req.protocol` is
  // always `http` and the session cookie ships without `Secure`, which a
  // browser then refuses to send back over the site's own HTTPS.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // This API serves JSON to a separate origin and embeds nothing; CSP here
      // would only describe a document that does not exist.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  app.use(
    cors({
      origin: (origin, callback) => {
        // No origin: a server-to-server call or a health check, not a browser.
        if (!origin) return callback(null, true);
        callback(null, env.corsOrigins.includes(origin));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: '128kb' }));

  /*
   * ONE GENEROUS GLOBAL LIMIT, and a tight one on sign-in.
   *
   * The screener is polled every five seconds by every open tab, so a limit
   * tuned for a human clicking would throttle the product's normal operation.
   * The limit that matters is on the endpoints that mint sessions, where the
   * thing being rationed is guesses rather than reads.
   */
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Slow down a moment.' } },
    })
  );

  app.use(
    ['/trade'],
    rateLimit({
      windowMs: 60_000,
      // A person pressing buy. Anything faster is a loop, and every one of
      // these signs a transaction and spends a priority fee.
      limit: 30,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many trades in a minute.' } },
    })
  );

  app.use(
    ['/auth/verify', '/auth/telegram', '/auth/nonce', '/wallets/link'],
    rateLimit({
      windowMs: 60_000,
      limit: 20,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many sign-in attempts.' } },
    })
  );

  app.use(sessionLoader());

  app.get('/health', (_req, res) => {
    res.json({ data: { ok: true } });
  });

  app.use(screenerRouter());
  app.use(tokensRouter());
  app.use(callsRouter());
  app.use(statusRouter());
  app.use(authRouter());
  app.use(autoRouter());
  app.use(walletsRouter());
  app.use(tradeRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } });
  });

  app.use(errorHandler());

  return app;
}
