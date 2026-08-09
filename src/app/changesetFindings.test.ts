import { describe, expect, it } from 'vitest';
import type { ReviewItem } from '../domain/types';
import { collectCrossFindings } from './changesetFindings';
import type { SubmittedReview } from './reviewHistory';

const SPANS = [
  { repoId: '9103', location: 'src/routes/session.ts:88', role: 'renames the field' },
  { repoId: '9210', location: 'src/api/session.ts:41', role: 'still reads the old name' },
];

const crossItem: ReviewItem = {
  id: 'cross_1',
  file: 'src/api/session.ts',
  line: 41,
  severity: 'blocker',
  category: 'apiContract',
  confidence: 94,
  title: 'Renamed on one side, read on the other',
  body: '',
  code: '',
  repoId: '9210',
  crNumber: '1509',
  cross: true,
  spans: SPANS,
};

const localItem: ReviewItem = { ...crossItem, id: 'local_1', cross: false, spans: undefined };

const record = (over: Partial<SubmittedReview>): SubmittedReview => ({
  repoId: '9210',
  crNumber: '1509',
  podId: 'pod',
  agentId: 'demo',
  agentLabel: 'Demo',
  submittedAt: '2026-08-08T00:00:00.000Z',
  counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 0 },
  threads: {},
  requestedChanges: false,
  ...over,
});

const MEMBERS = [
  { repoId: '9210', number: '1509' },
  { repoId: '9103', number: '381' },
];

describe('collectCrossFindings', () => {
  it('prefers the live draft and keeps only real cross items', () => {
    const findings = collectCrossFindings([crossItem, localItem], [], MEMBERS);

    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.id).toBe('cross_1');
    expect(findings?.[0]?.spans).toEqual(SPANS);
  });

  it('makes a real empty claim for a draft run that produced no cross findings', () => {
    expect(collectCrossFindings([localItem], [], MEMBERS)).toEqual([]);
  });

  it('falls back to member history snapshots after submit clears the draft', () => {
    const findings = collectCrossFindings(undefined, [
      record({
        items: [{ id: 'cross_1', title: 'Renamed on one side', severity: 'blocker', file: 'f', line: 1, cross: true, spans: SPANS, confidence: 94 }],
      }),
      // A record from another merge request never leaks in.
      record({
        repoId: '9999', crNumber: '1',
        items: [{ id: 'other', title: 'Elsewhere', severity: 'major', file: 'g', line: 2, cross: true, spans: SPANS }],
      }),
    ], MEMBERS);

    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.id).toBe('cross_1');
  });

  it('stays silent — not falsely clean — when history holds no span data', () => {
    // Records written before issue #15 carry no cross/spans fields; an empty
    // collection must read as "unknown", never as "the run found nothing".
    const findings = collectCrossFindings(undefined, [
      record({ items: [{ id: 'legacy', title: 'Old accepted item', severity: 'major', file: 'f', line: 3 }] }),
    ], MEMBERS);

    expect(findings).toBeUndefined();
  });
});
