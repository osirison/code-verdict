import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '../domain/harnessActivity';
import { createPlan, planCreatedFact, planHistory, planItemStateChangedFact, planRevisedFact, revisePlan } from './harnessActivityPlan';

describe('createPlan / revisePlan (task 5.3)', () => {
  it('creates a revision-1 plan with no rationale', () => {
    const plan = createPlan([{ id: 'p1', description: 'Inspect authorization changes' }]);
    expect(plan).toEqual({
      revision: 1,
      items: [{ id: 'p1', description: 'Inspect authorization changes', state: 'pending' }],
    });
  });

  it('fails closed on an empty item list', () => {
    expect(createPlan([])).toBeUndefined();
  });

  it('fails closed on a duplicate item id', () => {
    expect(
      createPlan([
        { id: 'p1', description: 'a' },
        { id: 'p1', description: 'b' },
      ]),
    ).toBeUndefined();
  });

  it('revises with an incremented revision number and a required rationale (plan revision history)', () => {
    const first = createPlan([{ id: 'p1', description: 'Inspect auth' }])!;
    const revised = revisePlan(
      first,
      [
        { id: 'p1', description: 'Inspect auth', state: 'completed' },
        { id: 'p2', description: 'Inspect billing', state: 'pending' },
      ],
      'A schema consumer was found in another member',
    );
    expect(revised?.revision).toBe(2);
    expect(revised?.rationale).toBe('A schema consumer was found in another member');
    expect(revised?.items.map((i) => i.id)).toEqual(['p1', 'p2']);
  });

  it('keeps stable identifiers: fails closed if a prior item id silently disappears', () => {
    const first = createPlan([
      { id: 'p1', description: 'Inspect auth' },
      { id: 'p2', description: 'Inspect billing' },
    ])!;
    const revised = revisePlan(
      first,
      [{ id: 'p1', description: 'Inspect auth', state: 'active' }],
      'Billing turned out unaffected',
    );
    expect(revised).toBeUndefined(); // p2 vanished instead of transitioning to a terminal state
  });

  it('fails closed on an empty rationale', () => {
    const first = createPlan([{ id: 'p1', description: 'Inspect auth' }])!;
    expect(revisePlan(first, [{ id: 'p1', description: 'Inspect auth' }], '   ')).toBeUndefined();
  });

  it('does not mutate the previous revision: history is retained by keeping both objects', () => {
    const first = createPlan([{ id: 'p1', description: 'Inspect auth' }])!;
    const revised = revisePlan(first, [{ id: 'p1', description: 'Inspect auth', state: 'completed' }], 'Done early')!;
    expect(first.revision).toBe(1);
    expect(first.items[0]?.state).toBe('pending');
    expect(revised.revision).toBe(2);
    expect(revised.items[0]?.state).toBe('completed');
  });

  it('builds planCreated/planRevised/planItemStateChanged facts with the right kind', () => {
    const plan = createPlan([{ id: 'p1', description: 'Inspect auth' }])!;
    expect(planCreatedFact(plan)).toEqual({ kind: 'planCreated', plan });
    expect(planRevisedFact(plan)).toEqual({ kind: 'planRevised', plan });
    expect(planItemStateChangedFact('p1', 'active')).toEqual({
      kind: 'planItemStateChanged',
      itemId: 'p1',
      state: 'active',
    });
  });
});

describe('member-scoped and shared plan items (task 13.3)', () => {
  it('creates a plan mixing member-scoped items and a shared cross-member item', () => {
    const plan = createPlan([
      { id: 'core-1', description: 'Inspect authorization changes', memberId: 'core' },
      { id: 'billing-1', description: 'Inspect billing webhook changes', memberId: 'billing' },
      { id: 'shared-1', description: 'Confirm the billing schema matches core' },
    ]);
    expect(plan?.items).toEqual([
      { id: 'core-1', description: 'Inspect authorization changes', state: 'pending', memberId: 'core' },
      { id: 'billing-1', description: 'Inspect billing webhook changes', state: 'pending', memberId: 'billing' },
      { id: 'shared-1', description: 'Confirm the billing schema matches core', state: 'pending' },
    ]);
    expect(plan?.items[2]).not.toHaveProperty('memberId');
  });

  it('fails closed on a present-but-blank member id', () => {
    expect(createPlan([{ id: 'p1', description: 'Inspect auth', memberId: '  ' }])).toBeUndefined();
  });

  it('keeps a member-scoped item\'s stable id when a revision adds new shared work', () => {
    const first = createPlan([{ id: 'core-1', description: 'Inspect authorization changes', memberId: 'core' }])!;
    const revised = revisePlan(
      first,
      [
        { id: 'core-1', description: 'Inspect authorization changes', state: 'active', memberId: 'core' },
        { id: 'shared-1', description: 'Confirm the billing schema matches core' },
      ],
      'A schema consumer was found in another member',
    );
    expect(revised?.items.map((item) => item.id)).toEqual(['core-1', 'shared-1']);
    expect(revised?.items[0]).toMatchObject({ id: 'core-1', memberId: 'core' });
    expect(revised?.items[1]).not.toHaveProperty('memberId');
  });

  it('keeps a shared item\'s stable id when a revision narrows its description', () => {
    const first = createPlan([{ id: 'shared-1', description: 'Check the API contract' }])!;
    const revised = revisePlan(
      first,
      [{ id: 'shared-1', description: 'Check the API contract: response shape only', state: 'active' }],
      'Narrowed after the first pass found no request-shape drift',
    );
    expect(revised?.items).toEqual([
      { id: 'shared-1', description: 'Check the API contract: response shape only', state: 'active' },
    ]);
  });
});

/** Common base fields for a hand-built `ActivityEvent`, matching `ActivityEventBase` (`../domain/harnessActivity`, not exported there). */
function base(sequence: number): Omit<ActivityEvent, 'kind' | 'plan' | 'itemId' | 'state' | 'action' | 'target' | 'tool' | 'summary' | 'reason' | 'coverage' | 'checkpointId' | 'limitations' | 'completeness' | 'lifecycle'> {
  return { runId: 'run-1', lineageId: 'lineage-1', attempt: 1, sequence, occurredAt: '2026-08-28T09:00:00.000Z', phase: 'planning', elapsedMs: sequence * 1_000 };
}

describe('planHistory (tasks 14.1/14.2)', () => {
  it('returns every plan revision, oldest first — retained activity keeps the previous revision, never overwriting it', () => {
    const first = createPlan([{ id: 'p1', description: 'Inspect authorization changes' }])!;
    const second = revisePlan(first, [{ id: 'p1', description: 'Inspect authorization changes', state: 'active' }, { id: 'p2', description: 'Check the schema consumer' }], 'A schema consumer was found in another member')!;
    const events: ActivityEvent[] = [
      { ...base(1), kind: 'planCreated', plan: first },
      { ...base(2), kind: 'actionStarted', action: 'Reading changed files' },
      { ...base(3), kind: 'planRevised', plan: second },
    ];

    const history = planHistory(events);
    expect(history).toEqual([first, second]);
    // The prior revision's identifier survives into the new one — the same
    // row, not a new one (D5: "Plan items SHALL have stable identifiers
    // across plan revisions").
    expect(history[1]?.items.map((item) => item.id)).toContain('p1');
  });

  it('returns nothing for activity with no plan event at all', () => {
    const events: ActivityEvent[] = [{ ...base(1), kind: 'actionStarted', action: 'Reading changed files' }];
    expect(planHistory(events)).toEqual([]);
  });

  it('returns nothing for an empty activity log — never a fabricated plan for a legacy result', () => {
    expect(planHistory([])).toEqual([]);
  });

  it('orders by protocol sequence rather than array order, and drops a redelivered duplicate', () => {
    // Spec `review-run-activity`: "Consumers SHALL order events by protocol
    // sequence rather than arrival time... a duplicate event does not
    // create duplicate activity." Retained activity is a deserialized
    // array read back from storage — nothing guarantees it arrives sorted.
    const first = createPlan([{ id: 'p1', description: 'Inspect authorization changes' }])!;
    const second = revisePlan(first, [{ id: 'p1', description: 'Inspect authorization changes', state: 'active' }], 'Narrowed scope')!;
    const events: ActivityEvent[] = [
      { ...base(3), kind: 'planRevised', plan: second },
      { ...base(1), kind: 'planCreated', plan: first },
      { ...base(3), kind: 'planRevised', plan: second }, // redelivered
    ];

    expect(planHistory(events)).toEqual([first, second]);
  });
});
