/**
 * GitHub HTTP reality → the normalized ScmError taxonomy.
 *
 * Two GitHub specifics the mapping has to get right:
 *  - A rejected comment position comes back as 422 with a message naming the
 *    position/line, not as a distinct status. That is `staleAnchor`, and the
 *    caller re-anchors rather than retrying.
 *  - Rate limiting arrives two ways: the primary limit as 403/429 with
 *    `x-ratelimit-remaining: 0`, and the secondary limit as 403/429 with a
 *    `retry-after` header. Both are `rateLimited`; a 403 that is neither is a
 *    genuine permission problem.
 */
import { ScmError } from '../../platform/errors';

export interface HeaderReader {
  get(name: string): string | null;
}

/** Seconds to wait, from `retry-after`, or from `x-ratelimit-reset` (epoch). */
export function retryAfterSeconds(headers: HeaderReader | undefined, now: number): number | undefined {
  const retryAfter = headers?.get('retry-after');
  if (retryAfter != null && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds);
  }
  const reset = headers?.get('x-ratelimit-reset');
  if (reset != null && reset.trim() !== '') {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds)) {
      return Math.max(0, Math.round(epochSeconds - now / 1000));
    }
  }
  return undefined;
}

function isRateLimited(status: number, message: string, headers?: HeaderReader): boolean {
  if (status !== 403 && status !== 429) return false;
  if (status === 429) return true;
  if (headers?.get('x-ratelimit-remaining') === '0') return true;
  const retryAfter = headers?.get('retry-after');
  if (retryAfter != null && retryAfter.trim() !== '') return true;
  return /rate limit|abuse detection|secondary rate/i.test(message);
}

/** The 422 messages GitHub returns when a comment's diff position no longer applies. */
function isStalePosition(message: string): boolean {
  return /position|line must be part of the diff|diff_hunk|commit_id|outdated/i.test(message);
}

export function mapGitHubError(
  status: number,
  message: string,
  headers?: HeaderReader,
  now: number = Date.now(),
): ScmError {
  if (status === 401) {
    return new ScmError('auth', message || '401 Unauthorized', { status });
  }
  if (isRateLimited(status, message, headers)) {
    return new ScmError('rateLimited', message || `${status} rate limited`, {
      status,
      retryAfterSeconds: retryAfterSeconds(headers, now),
    });
  }
  if (status === 403) {
    return new ScmError('insufficientScope', message || '403 Forbidden', { status });
  }
  if (status === 422 && isStalePosition(message)) {
    return new ScmError('staleAnchor', message, { status });
  }
  if (status === 404) {
    // GitHub returns 404 for "does not exist" and "you cannot see it" alike.
    // resolveSource turns that ambiguity into `notVisible`; here it stays 404.
    return new ScmError('notFound', message || '404 Not Found', { status });
  }
  return new ScmError('unknown', message || `HTTP ${status}`, { status });
}
