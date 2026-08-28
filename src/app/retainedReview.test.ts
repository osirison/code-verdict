import { describe, expect, it } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Review } from '../domain/types';
import {
  clearChangesetSubmitLedger,
  clearSubmitLedger,
  readRetained,
  screenForRetained,
  type ChangesetDraft,
  type SessionDraft,
} from './retainedReview';

function review(overrides: Partial<Review> = {}): Review {
  return {
    repoId: 'repo-1',
    crNumber: '42',
    agentId: 'agent:workspace/security',
    modelId: 'lm:acme/turbo',
    criteria: DEFAULT_CRITERIA,
    headSha: 'abc123',
    items: [
      {
        id: 'i1',
        file: 'src/a.ts',
        line: 10,
        severity: 'major',
        category: 'security',
        confidence: 80,
        title: 'A finding',
        body: 'Body',
        code: 'code',
      },
    ],
    verdicts: {},
    summary: '',
    ...overrides,
  };
}

describe('readRetained', () => {
  it('reads a record written before the result fields existed', () => {
    // Exactly the shape `persistDraft` wrote on `main`: the review, the
    // threads, the two text fields and the ledger — and nothing else.
    const legacy = {
      review: review(),
      threads: {},
      summaryText: '',
      finalNote: '',
    } satisfies SessionDraft;

    const retained = readRetained(legacy);

    expect(retained).toBeDefined();
    // Such a record can only be findings: the writer that could have produced
    // one deleted the key on a clean run instead of writing to it.
    expect(retained?.outcome).toBe('findings');
    // Not missing, only differently placed — the review carries both.
    expect(retained?.agentId).toBe('agent:workspace/security');
    expect(retained?.modelId).toBe('lm:acme/turbo');
    // The one thing a pre-change record genuinely never held.
    expect(retained?.ranAt).toBeUndefined();
    expect(retained?.submittedAt).toBeUndefined();
  });

  it('prefers the record\'s own agent and model over the review\'s', () => {
    // They diverge when the agent file changed after the run: the record's
    // copy is what actually produced the findings.
    const retained = readRetained({
      review: review({ agentId: 'stale', modelId: 'lm:old/model' }),
      threads: {},
      summaryText: '',
      finalNote: '',
      outcome: 'findings',
      agentId: 'agent:workspace/security',
      agentLabel: 'Security Reviewer',
      modelId: 'lm:acme/turbo',
      ranAt: '2026-08-28T10:00:00.000Z',
    } satisfies SessionDraft);

    expect(retained?.agentId).toBe('agent:workspace/security');
    expect(retained?.agentLabel).toBe('Security Reviewer');
    expect(retained?.modelId).toBe('lm:acme/turbo');
    expect(retained?.ranAt).toBe('2026-08-28T10:00:00.000Z');
  });

  it('reads nothing from an absent record', () => {
    expect(readRetained(undefined)).toBeUndefined();
  });

  it('reads nothing from a record with no review, rather than a half-built one', () => {
    // Defensive: `globalState`/`workspaceState` hold whatever a previous
    // version wrote, and a record without a review cannot render any screen.
    expect(readRetained({ threads: {}, summaryText: '', finalNote: '' } as unknown as SessionDraft)).toBeUndefined();
  });
});

describe('screenForRetained', () => {
  it('opens findings on triage while there is still work in them', () => {
    expect(screenForRetained({ outcome: 'findings' })).toBe('triage');
  });

  it('opens a submitted review on done, never back on triage', () => {
    expect(screenForRetained({ outcome: 'findings', submittedAt: '2026-08-28T10:00:00.000Z' })).toBe('done');
  });

  it('opens a clean run on the clean screen — a result, not an absence of one', () => {
    expect(screenForRetained({ outcome: 'clean' })).toBe('clean');
    // Submitting a clean review posts nothing, so it stays the clean screen.
    expect(screenForRetained({ outcome: 'clean', submittedAt: '2026-08-28T10:00:00.000Z' })).toBe('clean');
  });
});

describe('clearing the submit ledger', () => {
  const submitted = '2026-08-28T11:00:00.000Z';

  it('clears every field a retry reads, and keeps the review', () => {
    const draft: SessionDraft = {
      review: review(),
      threads: { i1: [{ label: 'Agent', text: 'why' }] },
      summaryText: 'A summary',
      finalNote: 'A note',
      outcome: 'findings',
      failedKeys: ['repo-1!42!i1'],
      summaryPosted: true,
      verdictApplied: true,
      threadsAccum: { i1: 'thread-9' },
      postedIndividually: true,
      postedCount: 3,
    };

    const cleared = clearSubmitLedger(draft, submitted);

    // The whole of what the old `update(key, undefined)` was entitled to do.
    expect(cleared.failedKeys).toBeUndefined();
    expect(cleared.summaryPosted).toBeUndefined();
    expect(cleared.verdictApplied).toBeUndefined();
    expect(cleared.threadsAccum).toBeUndefined();
    expect(cleared.postedIndividually).toBeUndefined();
    expect(cleared.postedCount).toBeUndefined();
    // And everything it was not: deleting the record took the review with it.
    expect(cleared.review).toEqual(draft.review);
    expect(cleared.threads).toEqual(draft.threads);
    expect(cleared.summaryText).toBe('A summary');
    expect(cleared.finalNote).toBe('A note');
    expect(cleared.submittedAt).toBe(submitted);
    expect(screenForRetained({ outcome: cleared.outcome ?? 'findings', submittedAt: cleared.submittedAt })).toBe('done');
  });

  it('clears the changeset ledger the same way, with one field instead of six', () => {
    const draft: ChangesetDraft = {
      review: review(),
      threads: {},
      summaryText: 'A summary',
      finalNote: '',
      outcome: 'findings',
      submitState: { postedCommentKeys: [], summaryRefs: [], requestChangesRefs: [], threadIds: {} },
    };

    const cleared = clearChangesetSubmitLedger(draft, submitted);

    expect(cleared.submitState).toBeUndefined();
    expect(cleared.review).toEqual(draft.review);
    expect(cleared.summaryText).toBe('A summary');
    expect(cleared.submittedAt).toBe(submitted);
  });
});
