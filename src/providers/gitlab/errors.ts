/**
 * GitLab HTTP reality → the normalized ScmError taxonomy
 * (`errorResponses` in the spec fixtures).
 */
import { ScmError } from '../../platform/errors';

export interface HeaderReader {
  get(name: string): string | null;
}

export function mapGitLabError(status: number, message: string, headers?: HeaderReader): ScmError {
  if (status === 401) {
    return new ScmError('auth', message || '401 Unauthorized', { status });
  }
  if (status === 403) {
    return new ScmError('insufficientScope', message || '403 Forbidden', { status });
  }
  if (status === 400 && /position is invalid/i.test(message)) {
    // Never retried blindly — the caller re-anchors first.
    return new ScmError('staleAnchor', message, { status });
  }
  if (status === 404) {
    return new ScmError('notFound', message || '404 Not Found', { status });
  }
  if (status === 429) {
    const retryAfter = Number(headers?.get('Retry-After'));
    return new ScmError('rateLimited', message || '429 Too Many Requests', {
      status,
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
    });
  }
  return new ScmError('unknown', message || `HTTP ${status}`, { status });
}
