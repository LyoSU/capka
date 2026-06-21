/** Typed operational errors — apiHandler catches these and returns safe responses. */

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly _isAppError = true; // Fallback tag — instanceof can break across module boundaries

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code ?? `ERR_${status}`;
    Object.setPrototypeOf(this, new.target.prototype); // Fix instanceof after transpilation
  }

  toResponse(): Response {
    return Response.json({ error: this.message, code: this.code }, { status: this.status });
  }
}

/** Check if an error is an AppError (handles cross-boundary instanceof failures) */
export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError || (e != null && typeof e === "object" && "_isAppError" in e);
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource") {
    super(`${resource} not found`, 404, "NOT_FOUND");
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, 403, "FORBIDDEN");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class BudgetExceededError extends AppError {
  readonly window: string;
  // 429: the request is well-formed but the user's shared-key spend cap is hit.
  // Carries the window so the UI can say which limit (5h / week / month) tripped.
  constructor(window: string, message = "Spending limit reached") {
    super(message, 429, "BUDGET_EXCEEDED");
    this.window = window;
  }
}

export class SandboxError extends AppError {
  readonly operation: string;
  readonly retryable: boolean;

  // `status` defaults to 502 (a genuine gateway failure — controller unreachable),
  // but callers pass the controller's real status through so an expected client
  // condition (e.g. a missing file → 404) isn't disguised as a "Bad gateway".
  constructor(message: string, operation: string, retryable = false, status = 502) {
    super(message, status, "SANDBOX_ERROR");
    this.operation = operation;
    this.retryable = retryable;
  }
}
