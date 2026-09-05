import { describe, expect, it } from 'vitest';
import {
  MAX_METADATA_ARRAY_ITEMS,
  MAX_METADATA_ENTRIES,
  MAX_PUBLIC_TEXT_LENGTH,
  sanitizeErrorReason,
  sanitizeMetadata,
  sanitizePublicText,
} from './harnessActivitySanitizer';

describe('sanitizePublicText (task 5.5)', () => {
  it('fails closed on a non-string value', () => {
    expect(sanitizePublicText(123)).toBeUndefined();
    expect(sanitizePublicText(undefined)).toBeUndefined();
    expect(sanitizePublicText({ message: 'hi' })).toBeUndefined();
  });

  it('fails closed on an empty or whitespace-only string', () => {
    expect(sanitizePublicText('')).toBeUndefined();
    expect(sanitizePublicText('   \n\t  ')).toBeUndefined();
  });

  it('redacts a Bearer token', () => {
    const result = sanitizePublicText('Auth failed: Bearer sk-abc123DEF456ghi789JKL for repo fetch');
    expect(result).not.toContain('sk-abc123DEF456ghi789JKL');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts a GitHub personal access token', () => {
    const result = sanitizePublicText('leaked ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa in output');
    expect(result).not.toMatch(/ghp_[a-zA-Z0-9]{20,}/);
  });

  it('redacts a GitLab personal access token', () => {
    const result = sanitizePublicText('token was glpat-aaaaaaaaaaaaaaaaaaaa here');
    expect(result).not.toMatch(/glpat-[a-zA-Z0-9_-]{20,}/);
  });

  it('redacts an AWS access key id', () => {
    const result = sanitizePublicText('found AKIAABCDEFGHIJKLMNOP in a config file');
    expect(result).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });

  it('redacts a keyed secret while keeping the key name for context', () => {
    const result = sanitizePublicText('request failed, api_key=abcdef1234567890 rejected');
    expect(result).not.toContain('abcdef1234567890');
    expect(result).toContain('api_key');
    expect(result).toContain('[REDACTED]');
  });

  it('does not redact ordinary prose that merely mentions a secret-related word', () => {
    expect(sanitizePublicText('Checked whether the access token had expired')).toBe(
      'Checked whether the access token had expired',
    );
  });

  it('strips control characters and collapses internal whitespace/newlines', () => {
    const result = sanitizePublicText('line one\nline\ttwo\u0007 bell');
    expect(result).toBe('line one line two bell');
  });

  it('truncates text longer than the concise-text bound', () => {
    const long = 'x'.repeat(MAX_PUBLIC_TEXT_LENGTH + 100);
    const result = sanitizePublicText(long)!;
    expect(result.length).toBe(MAX_PUBLIC_TEXT_LENGTH);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('sanitizeMetadata (task 5.5, recursive allowlist)', () => {
  it('keeps allowlisted primitive leaves and drops everything else', () => {
    const metadata = sanitizeMetadata({
      code: 'rateLimited',
      retryAfterSeconds: 30,
      retryable: true,
      handler: () => undefined,
    });
    expect(metadata).toEqual({ code: 'rateLimited', retryAfterSeconds: 30, retryable: true });
  });

  it('recurses into nested objects and arrays with dotted-path keys', () => {
    const metadata = sanitizeMetadata({
      cause: { provider: 'github', details: { status: 429 } },
      hints: ['slow down'],
    });
    expect(metadata['cause.provider']).toBe('github');
    expect(metadata['cause.details.status']).toBe(429);
    expect(metadata['hints.0']).toBe('slow down');
  });

  it('drops a denylisted key entirely at any depth instead of redacting its value', () => {
    const metadata = sanitizeMetadata({ code: 'failed', cause: { prompt: 'full system prompt text...' } });
    expect(metadata.prompt).toBeUndefined();
    expect(metadata['cause.prompt']).toBeUndefined();
    expect(Object.keys(metadata)).not.toContain('cause.prompt');
  });

  it('redacts a secret found inside a nested string leaf', () => {
    const metadata = sanitizeMetadata({ detail: 'failed with token=abcdef1234567890' });
    expect(metadata.detail).not.toContain('abcdef1234567890');
  });

  it('bounds recursion depth so content beyond the limit is dropped', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { marker: 'unique-deep-marker-xyz' } } } } } };
    const metadata = sanitizeMetadata(deep);
    expect(JSON.stringify(metadata)).not.toContain('unique-deep-marker-xyz');
  });

  it('does not loop forever or throw on a circular reference', () => {
    const circular: Record<string, unknown> = { code: 'x' };
    circular.self = circular;
    expect(() => sanitizeMetadata(circular)).not.toThrow();
  });

  it('bounds the number of entries produced from a very wide object', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100; i += 1) wide[`field${i}`] = i;
    const metadata = sanitizeMetadata(wide);
    expect(Object.keys(metadata).length).toBeLessThanOrEqual(MAX_METADATA_ENTRIES);
  });

  it('bounds how many array items it walks', () => {
    const many = Array.from({ length: 50 }, (_, i) => `item-${i}`);
    const metadata = sanitizeMetadata({ list: many });
    const keys = Object.keys(metadata).filter((key) => key.startsWith('list.'));
    expect(keys.length).toBeLessThanOrEqual(MAX_METADATA_ARRAY_ITEMS);
  });
});

describe('sanitizeErrorReason (task 5.5)', () => {
  it('sanitizes a plain string error', () => {
    expect(sanitizeErrorReason('token=abcdef1234567890 rejected')).not.toContain('abcdef1234567890');
  });

  it('extracts and sanitizes an Error instance message', () => {
    expect(sanitizeErrorReason(new Error('rate limited, Bearer sk-abc123DEF456ghi789JKL'))).not.toMatch(
      /sk-abc123DEF456ghi789JKL/,
    );
  });

  it('extracts a message field from an error-shaped object', () => {
    expect(sanitizeErrorReason({ message: 'unavailable: revision not found', code: 'notFound' })).toBe(
      'unavailable: revision not found',
    );
  });

  it('falls back to a generic message for an unrecognized shape', () => {
    expect(sanitizeErrorReason(42)).toBe('an unexpected error occurred');
    expect(sanitizeErrorReason({ weird: true })).toBe('an unexpected error occurred');
  });
});
