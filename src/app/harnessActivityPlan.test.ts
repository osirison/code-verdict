import { describe, expect, it } from 'vitest';
import { createPlan, planCreatedFact, planItemStateChangedFact, planRevisedFact, revisePlan } from './harnessActivityPlan';

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
