/**
 * The one error type that reaches a client.
 *
 * Anything thrown that is NOT an AppError is treated as a bug by the handler
 * and answered with a generic 500 — deliberately, because the message of an
 * unexpected error routinely contains a connection string, a file path or a
 * fragment of somebody's query. An AppError is a message somebody WROTE for a
 * reader; everything else is a message somebody wrote for themselves.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'Sign in to continue.'): AppError {
    return new AppError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message: string): AppError {
    return new AppError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Not found'): AppError {
    return new AppError(404, 'NOT_FOUND', message);
  }
  static conflict(message: string): AppError {
    return new AppError(409, 'CONFLICT', message);
  }
  static unavailable(code: string, message: string): AppError {
    return new AppError(503, code, message);
  }
}
