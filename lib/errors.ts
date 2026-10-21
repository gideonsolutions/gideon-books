/**
 * Errors a person or an API client can act on. Each has a stable `code`, an
 * HTTP status, and a message written for the person reading it. Anything
 * else that escapes is a bug and is reported as an internal error without
 * its details.
 */

export type FieldErrors = Record<string, string>;

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly fields?: FieldErrors;

  constructor(
    status: number,
    code: string,
    message: string,
    opts: { details?: Record<string, unknown>; fields?: FieldErrors; cause?: unknown } = {},
  ) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    if (opts.details) this.details = opts.details;
    if (opts.fields) this.fields = opts.fields;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.fields ? { fields: this.fields } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, fields?: FieldErrors, details?: Record<string, unknown>) {
    super(422, "validation_failed", message, { ...(fields ? { fields } : {}), ...(details ? { details } : {}) });
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(404, "not_found", `${what} was not found.`);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to do that.", details?: Record<string, unknown>) {
    super(403, "forbidden", message, details ? { details } : {});
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Sign in to continue.") {
    super(401, "unauthorized", message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = "conflict", details?: Record<string, unknown>) {
    super(409, code, message, details ? { details } : {});
  }
}

/** The ledger refused: unbalanced, closed period, archived account, … */
export class PostingError extends AppError {
  constructor(message: string, code = "posting_refused", details?: Record<string, unknown>) {
    super(422, code, message, details ? { details } : {});
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many attempts. Wait a few minutes and try again.") {
    super(429, "rate_limited", message);
  }
}

/** A provider is not configured or did not answer. */
export class IntegrationError extends AppError {
  constructor(message: string, code = "integration_error", details?: Record<string, unknown>) {
    super(502, code, message, details ? { details } : {});
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
