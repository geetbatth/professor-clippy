/**
 * Errors thrown by core services. Each carries the HTTP status the local API
 * answers with, so `api.ts` can map them without knowing the service.
 */
export class CoreError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input is well-formed JSON but semantically invalid (bad date, bad RRULE, ...). */
export class ValidationError extends CoreError {
  constructor(message: string) {
    super(400, message);
  }
}

/** The caller may not do this (a setting is off, or only the user may). */
export class ForbiddenError extends CoreError {
  constructor(message: string) {
    super(403, message);
  }
}

/** Unknown message / reminder / ask id. */
export class NotFoundError extends CoreError {
  constructor(message: string) {
    super(404, message);
  }
}

/** The operation conflicts with the current state (e.g. answering an ask twice). */
export class ConflictError extends CoreError {
  constructor(message: string) {
    super(409, message);
  }
}
