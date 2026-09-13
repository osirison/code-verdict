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
  /**
   * The platform refuses this verdict outright — e.g. neither GitHub nor
   * GitLab lets an author approve or request changes on their own change
   * request. Terminal, like `staleAnchor` is re-anchorable: retrying sends
   * the identical request and gets the identical refusal, so a caller that
   * treats it as a transient failure never completes.
   */
  | 'verdictRefused'
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

/**
 * Kinds a bounded retry policy may safely retry (design.md D12,
 * `add-agentic-review-harness` task 3.5). Fails closed: every other kind,
 * including `unknown`, is a terminal domain outcome the policy must not
 * retry blindly — e.g. a `staleAnchor` retry would resend the identical
 * request and get the identical refusal.
 */
const RETRYABLE_SCM_ERROR_KINDS: ReadonlySet<ScmErrorKind> = new Set(['rateLimited', 'network']);

/**
 * Whether a bounded retry policy may retry this failure, reusing `kind` and
 * `retryAfterSeconds` — the existing taxonomy already carries Retry-After or
 * reset guidance (`retryAfterSeconds`) through `rateLimited`; this adds the
 * one thing it lacked, an explicit retryable signal, so a caller never has
 * to special-case kinds itself.
 */
export function isRetryableScmError(error: ScmError): boolean {
  return RETRYABLE_SCM_ERROR_KINDS.has(error.kind);
}
