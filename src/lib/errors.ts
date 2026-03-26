/** Typed operational errors — apiHandler catches these and returns safe responses. */

export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code ?? `ERR_${status}`;
  }

  toResponse(): Response {
    return Response.json({ error: this.message, code: this.code }, { status: this.status });
  }
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

export class SandboxError extends AppError {
  readonly operation: string;
  readonly retryable: boolean;

  constructor(message: string, operation: string, retryable = false) {
    super(message, 502, "SANDBOX_ERROR");
    this.operation = operation;
    this.retryable = retryable;
  }
}
