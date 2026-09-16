import { describe, expect, it } from 'vitest';
import { isRetryableScmError, ScmError, type ScmErrorKind } from './errors';

describe('isRetryableScmError (task 3.5)', () => {
  it('is retryable for rateLimited and network, carrying retryAfterSeconds through unchanged', () => {
    const rateLimited = new ScmError('rateLimited', '429', { retryAfterSeconds: 38 });
    const network = new ScmError('network', 'ECONNRESET');

    expect(isRetryableScmError(rateLimited)).toBe(true);
    expect(rateLimited.retryAfterSeconds).toBe(38);
    expect(isRetryableScmError(network)).toBe(true);
  });

  it('is never retryable for a terminal domain outcome, including unknown', () => {
    const terminalKinds: ScmErrorKind[] = ['auth', 'insufficientScope', 'staleAnchor', 'verdictRefused', 'notFound', 'unknown'];
    for (const kind of terminalKinds) {
      expect(isRetryableScmError(new ScmError(kind, 'x'))).toBe(false);
    }
  });
});
