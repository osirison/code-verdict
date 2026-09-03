import { describe, expect, it } from 'vitest';
import { runHarnessTurn, type AskModel } from './harnessTurn';
import { createPlan } from './harnessActivityPlan';
import { DEFAULT_HARNESS_POLICY } from '../domain/harnessPolicy';

function validTurn(): string {
  return JSON.stringify({ messages: [{ kind: 'publicRationale', rationale: 'Starting with the auth module.' }] });
}

const MALFORMED_TURN = 'this is not JSON at all, just prose.';

describe('runHarnessTurn', () => {
  it('returns typed messages on the first well-formed turn without any repair', async () => {
    let calls = 0;
    const askModel: AskModel = async (repairInstruction) => {
      calls += 1;
      expect(repairInstruction).toBeUndefined();
      return validTurn();
    };
    const outcome = await runHarnessTurn(askModel, { phase: 'investigating' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.messages).toHaveLength(1);
      expect(outcome.meta.repairCount).toBe(0);
    }
    expect(calls).toBe(1);
  });

  it('issues N-1 repair instructions and terminally fails on the Nth malformed turn', async () => {
    const maxRepairs = 2; // allowance of 2 => 3 total asks; the 3rd exhausts.
    let calls = 0;
    const seenInstructions: (string | undefined)[] = [];
    const askModel: AskModel = async (repairInstruction) => {
      calls += 1;
      seenInstructions.push(repairInstruction);
      return MALFORMED_TURN;
    };
    const outcome = await runHarnessTurn(askModel, { phase: 'investigating', maxRepairs });
    expect(calls).toBe(3); // 1 initial + 2 repairs
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.repairCount).toBe(2);
      expect(outcome.repairsExhausted).toBe(true);
      expect(outcome.failureKind).toBe('parse');
    }
    // First ask has no instruction; the two repair asks each carry one.
    expect(seenInstructions[0]).toBeUndefined();
    expect(seenInstructions[1]).toBeTypeOf('string');
    expect(seenInstructions[2]).toBeTypeOf('string');
  });

  it('a turn that becomes well-formed within the repair allowance succeeds and reports how many repairs it took', async () => {
    let calls = 0;
    const askModel: AskModel = async () => {
      calls += 1;
      return calls < 2 ? MALFORMED_TURN : validTurn();
    };
    const outcome = await runHarnessTurn(askModel, { phase: 'investigating', maxRepairs: 2 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.meta.repairCount).toBe(1);
  });

  it('defaults the repair allowance to HarnessPolicy.protocolRepairsPerPhase', async () => {
    let calls = 0;
    const askModel: AskModel = async () => {
      calls += 1;
      return MALFORMED_TURN;
    };
    const outcome = await runHarnessTurn(askModel, { phase: 'investigating' });
    expect(calls).toBe(DEFAULT_HARNESS_POLICY.protocolRepairsPerPhase + 1);
    expect(outcome.ok).toBe(false);
  });

  it('never re-executes a tool side effect: the loop never calls anything but askModel and the pure parser', async () => {
    // Structural: runHarnessTurn's only side-effecting dependency is the injected askModel.
    // A repair attempt that "succeeds" the second time proves no tool dispatch happened on the
    // first (malformed) attempt — there is nothing here that could have dispatched one.
    let calls = 0;
    const askModel: AskModel = async () => {
      calls += 1;
      return calls === 1 ? JSON.stringify({ messages: [{ kind: 'toolRequest', tool: 'madeUpTool', memberId: 'm1', request: {} }] }) : validTurn();
    };
    const outcome = await runHarnessTurn(askModel, { phase: 'investigating', maxRepairs: 1 });
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('stops before asking the model when cancellation is already requested', async () => {
    let calls = 0;
    const askModel: AskModel = async () => {
      calls += 1;
      return validTurn();
    };
    const cancellation = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => {} }) };
    const outcome = await runHarnessTurn(askModel, { phase: 'investigating', cancellation });
    expect(calls).toBe(0);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureKind).toBe('cancelled');
  });

  it('stops after the model resolves if cancellation was requested during the call', async () => {
    const cancellation = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
    const askModel: AskModel = async () => {
      cancellation.isCancellationRequested = true;
      return validTurn();
    };
    const outcome = await runHarnessTurn(askModel, { phase: 'investigating', cancellation });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureKind).toBe('cancelled');
  });

  it('the repair instruction sent to the model never contains a distinctive marker from the malformed turn', async () => {
    const marker = `RAW_MODEL_TEXT_MARKER_${'Z'.repeat(300)}`;
    const seenInstructions: (string | undefined)[] = [];
    let calls = 0;
    const askModel: AskModel = async (repairInstruction) => {
      calls += 1;
      seenInstructions.push(repairInstruction);
      return calls === 1 ? `prose containing ${marker} and no JSON` : validTurn();
    };
    const outcome = await runHarnessTurn(askModel, { phase: 'investigating', maxRepairs: 1 });
    expect(outcome.ok).toBe(true);
    expect(seenInstructions[1]).not.toContain(marker);
  });

  it('a contract-violation failure exhausts identically to a parse failure', async () => {
    const askModel: AskModel = async () => JSON.stringify({ messages: [{ kind: 'planCreated', items: [{ id: 'p1', description: 'x' }] }] });
    // planCreated is only legal in 'planning'; asking during 'verifying' is a contract violation every time.
    const outcome = await runHarnessTurn(askModel, { phase: 'verifying', maxRepairs: 1 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('contract');
      expect(outcome.repairsExhausted).toBe(true);
      expect(outcome.repairCount).toBe(1);
    }
  });

  it('threads previousPlan through to the parser so a plan revision resolves normally', async () => {
    const previousPlan = createPlan([{ id: 'p1', description: 'Inspect auth' }])!;
    const askModel: AskModel = async () =>
      JSON.stringify({ messages: [{ kind: 'planRevised', items: [{ id: 'p1', description: 'Inspect auth' }, { id: 'p2', description: 'Inspect billing' }], rationale: 'Found coupling' }] });
    const outcome = await runHarnessTurn(askModel, { phase: 'investigating', previousPlan });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const [msg] = outcome.messages;
      expect(msg?.kind).toBe('planRevised');
    }
  });
});
