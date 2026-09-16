import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../../infra/errors.js';
import { errField, logger } from '../../infra/logger.js';

/**
 * One error shape out of the whole API: `{ error: { code, message } }`.
 *
 * ANYTHING THAT IS NOT AN AppError IS A BUG AND IS ANSWERED GENERICALLY. The
 * message of an unexpected error routinely contains a connection string, a file
 * path, or a fragment of a query — an AppError is a message somebody WROTE for
 * a reader, and everything else is a message somebody wrote for themselves.
 */
export function errorHandler() {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof AppError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
      return;
    }

    logger.error({ path: req.path, method: req.method, err: errField(err) }, 'unhandled error');
    res.status(500).json({
      error: { code: 'INTERNAL', message: 'Something went wrong on our side.' },
    });
  };
}

/**
 * Wraps an async handler so a rejected promise reaches the error handler.
 *
 * Express 5 forwards rejections itself, but only for handlers it recognises as
 * returning promises — this is explicit and costs nothing, and without it a
 * single unwrapped `await` that throws hangs the request until the client gives
 * up.
 */
export function wrap(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}
