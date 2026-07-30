/**
 * Normalized error taxonomy. Providers map their HTTP reality onto these
 * kinds; the app layer keys the five spec failure branches off them and
 * never inspects provider-specific payloads.
 */
export type ScmErrorKind =
  /** 401 — token invalid or expired. UI: reconnect, draft preserved. */
  | 'auth'
  /** 403 insufficient scope. UI: onboarding step 1. */
  | 'insufficientScope'
  /** The diff anchor no longer matches (e.g. GitLab 400 "Note position is invalid"). Re-anchor, never retry blindly. */
  | 'staleAnchor'
  /** 429 — carries retryAfterSeconds when the platform provides it. */
  | 'rateLimited'
  | 'notFound'
  | 'network'
  | 'unknown';

export class ScmError extends Error {
  readonly kind: ScmErrorKind;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    kind: ScmErrorKind,
    message: string,
    opts: { status?: number; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ScmError';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export function isScmError(e: unknown): e is ScmError {
  return e instanceof ScmError;
}

/** Wrap anything non-ScmError so callers always see the taxonomy. */
export function toScmError(e: unknown): ScmError {
  if (isScmError(e)) return e;
  if (e instanceof Error) return new ScmError('unknown', e.message, { cause: e });
  return new ScmError('unknown', String(e));
}
