import { describe, expect, it } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Review } from '../domain/types';
import {
  clearChangesetSubmitLedger,
  clearSubmitLedger,
  pruneClosedRetained,
  readRetained,
  retainedFromRun,
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

/**
 * The two paths that used to delete the record, and the regression each one
 * caused. Both are asserted against `readRetained`, because "re-openable" means
 * exactly that the reader finds something and routes it to a screen.
 */
describe('a completed review is re-openable', () => {
  it('a clean run leaves a record that opens on the clean screen', () => {
    // `finishRun` deleted the key here, so a change request the agent had run
    // on and cleared re-opened on the agent picker with the verdict gone.
    const clean = retainedFromRun({
      review: review({ items: [] }),
      ranAt: '2026-08-28T09:00:00.000Z',
      agentId: 'agent:workspace/security',
      agentLabel: 'Security Reviewer',
      modelId: 'lm:acme/turbo',
      candidates: [{ reason: 'belowSeverityFloor', count: 4, severity: 'nit', category: 'style', confidence: 40 }],
      filesRead: 9,
    });

    const retained = readRetained(clean);
    expect(retained?.outcome).toBe('clean');
    expect(screenForRetained({ outcome: retained!.outcome, submittedAt: retained?.submittedAt })).toBe('clean');
    // The clean screen's whole content lives on the response, which is not
    // stored — so it rides on the record or it is lost.
    expect(retained?.candidates).toEqual([
      { reason: 'belowSeverityFloor', count: 4, severity: 'nit', category: 'style', confidence: 40 },
    ]);
    expect(retained?.filesRead).toBe(9);
    // Staleness still has something to compare against.
    expect(retained?.draft.review.headSha).toBe('abc123');
  });

  it('a run with findings opens on triage, carrying its verdicts', () => {
    const record = retainedFromRun({
      review: review({ verdicts: { i1: { verdict: 'accepted', applyFix: true } } }),
      ranAt: '2026-08-28T09:00:00.000Z',
      agentId: 'agent:workspace/security',
      agentLabel: 'Security Reviewer',
    });

    const retained = readRetained(record);
    expect(retained?.outcome).toBe('findings');
    expect(screenForRetained({ outcome: retained!.outcome, submittedAt: retained?.submittedAt })).toBe('triage');
    expect(retained?.draft.review.verdicts.i1?.verdict).toBe('accepted');
  });

  it('a submitted review opens on done, with an empty ledger and its comments intact', () => {
    const submitted = clearSubmitLedger(
      {
        ...retainedFromRun({
          review: review(),
          ranAt: '2026-08-28T09:00:00.000Z',
          agentId: 'a',
          agentLabel: 'Security Reviewer',
        }),
        threads: { i1: [{ label: 'Agent', text: 'why' }] },
        summaryText: 'A summary',
        failedKeys: ['repo-1!42!i1'],
        postedCount: 2,
      },
      '2026-08-28T11:00:00.000Z',
    );

    const retained = readRetained(submitted);
    expect(screenForRetained({ outcome: retained!.outcome, submittedAt: retained?.submittedAt })).toBe('done');
    // Nothing that landed can be posted twice…
    expect(retained?.draft.failedKeys).toBeUndefined();
    expect(retained?.draft.postedCount).toBeUndefined();
    // …and the review that was posted is still readable.
    expect(retained?.draft.summaryText).toBe('A summary');
    expect(retained?.draft.threads.i1).toHaveLength(1);
  });

  it('a clean re-run replaces a previous run\'s findings rather than leaving them', () => {
    // The changeset panel's clean branch persisted nothing at all, so a reload
    // after a clean re-run walked straight back into the PREVIOUS run's
    // findings — a triage screen for a review that no longer said anything.
    const withFindings = retainedFromRun({
      review: review(),
      ranAt: '2026-08-28T09:00:00.000Z',
      agentId: 'a',
      agentLabel: 'Security Reviewer',
    });
    expect(readRetained(withFindings)?.outcome).toBe('findings');

    const afterCleanRerun = retainedFromRun({
      review: review({ items: [] }),
      ranAt: '2026-08-28T10:00:00.000Z',
      agentId: 'a',
      agentLabel: 'Security Reviewer',
    });

    const retained = readRetained(afterCleanRerun);
    expect(retained?.outcome).toBe('clean');
    expect(retained?.draft.review.items).toEqual([]);
    // And nothing from the superseded run rides along: those were decisions
    // about findings that no longer exist.
    expect(retained?.draft.summaryText).toBe('');
    expect(retained?.draft.threads).toEqual({});
  });
});

describe('pruning reviews for change requests that closed', () => {
  function store(initial: Record<string, unknown>) {
    const map = new Map(Object.entries(initial));
    return {
      map,
      get: <T>(key: string) => map.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        if (value === undefined) map.delete(key);
        else map.set(key, value);
      },
      keys: () => [...map.keys()],
    };
  }

  it('drops a record whose change request is no longer open', async () => {
    const s = store({
      'codeVerdict.draft.repo-1!1': { review: {} },
      'codeVerdict.draft.repo-1!2': { review: {} },
    });

    const dropped = await pruneClosedRetained(s, ['repo-1'], [{ repoId: 'repo-1', number: '2' }]);

    expect(dropped).toBe(1);
    expect(s.keys()).toEqual(['codeVerdict.draft.repo-1!2']);
  });

  it('leaves records for repositories this poll did not cover', async () => {
    // Absence from *these* results says nothing about whether it is open, and
    // deleting on that would let one pod's refresh destroy another's reviews.
    const s = store({
      'codeVerdict.draft.repo-1!1': { review: {} },
      'codeVerdict.draft.repo-9!1': { review: {} },
    });

    const dropped = await pruneClosedRetained(s, ['repo-1'], []);

    expect(dropped).toBe(1);
    expect(s.keys()).toEqual(['codeVerdict.draft.repo-9!1']);
  });

  it('never touches a changeset record', async () => {
    // A changeset is derived locally, not fetched, so "no longer open" has no
    // answer this function could read.
    const s = store({ 'codeVerdict.changesetDraft.cs-7': { review: {} } });
    expect(await pruneClosedRetained(s, ['repo-1'], [])).toBe(0);
    expect(s.keys()).toEqual(['codeVerdict.changesetDraft.cs-7']);
  });

  it('does nothing at all on a store that cannot enumerate its keys', async () => {
    const map = new Map([['codeVerdict.draft.repo-1!1', { review: {} }]]);
    const dropped = await pruneClosedRetained(
      { get: <T>(k: string) => map.get(k) as T | undefined, update: async () => {} },
      ['repo-1'],
      [],
    );
    expect(dropped).toBe(0);
  });

  it('handles a repository id that itself contains the separator', async () => {
    // GitHub repo ids are `owner/name`; nothing forbids a `!` reaching one.
    const s = store({ 'codeVerdict.draft.acme/re!po!42': { review: {} } });
    expect(await pruneClosedRetained(s, ['acme/re!po'], [{ repoId: 'acme/re!po', number: '42' }])).toBe(0);
    expect(await pruneClosedRetained(s, ['acme/re!po'], [])).toBe(1);
  });
});
