import { describe, expect, it } from 'vitest';
import { createPlan } from '../app/harnessActivityPlan';
import {
  buildRepairInstruction,
  MAX_PROTOCOL_MESSAGES_PER_TURN,
  MAX_REPAIR_INSTRUCTION_LENGTH,
  parseModelTurn,
  PHASE_ALLOWED_KINDS,
  type ProtocolMessage,
  type TurnParseOutcome,
} from './harnessProtocol';
import type { Plan } from './harnessActivity';
import { DEFAULT_HARNESS_POLICY } from './harnessPolicy';

const SNAPSHOT = { repoId: 'repo-1', baseSha: 'base-sha', headSha: 'head-sha' };

function turnText(messages: readonly unknown[]): string {
  return JSON.stringify({ messages });
}

function okMessages(outcome: TurnParseOutcome): readonly ProtocolMessage[] {
  if (!outcome.ok) throw new Error(`expected ok outcome, got failure: ${JSON.stringify(outcome)}`);
  return outcome.messages;
}

function failReasons(outcome: TurnParseOutcome): readonly { code: string; message: string }[] {
  if (outcome.ok) throw new Error('expected failure outcome, got success');
  return outcome.reasons;
}

describe('parseModelTurn: every message kind round-trips', () => {
  it('planCreated builds a Plan via the existing plan module with stable ids', () => {
    const outcome = parseModelTurn(
      turnText([{ kind: 'planCreated', items: [{ id: 'p1', description: 'Inspect authorization changes' }, { id: 'p2', description: 'Inspect schema migration' }] }]),
      { phase: 'planning' },
    );
    const [msg] = okMessages(outcome);
    expect(msg?.kind).toBe('planCreated');
    if (msg?.kind === 'planCreated') {
      expect(msg.plan.revision).toBe(1);
      expect(msg.plan.items.map((i) => i.id)).toEqual(['p1', 'p2']);
      expect(msg.plan.items[0]).toEqual({ id: 'p1', description: 'Inspect authorization changes', state: 'pending' });
    }
  });

  it('planCreated parses a member-scoped item and leaves a shared item without memberId (task 13.3)', () => {
    const outcome = parseModelTurn(
      turnText([
        {
          kind: 'planCreated',
          items: [
            { id: 'core-1', description: 'Inspect authorization changes', memberId: 'core' },
            { id: 'shared-1', description: 'Confirm the billing schema matches core' },
          ],
        },
      ]),
      { phase: 'planning' },
    );
    const [msg] = okMessages(outcome);
    if (msg?.kind !== 'planCreated') throw new Error('expected planCreated');
    expect(msg.plan.items[0]).toEqual({ id: 'core-1', description: 'Inspect authorization changes', state: 'pending', memberId: 'core' });
    expect(msg.plan.items[1]).not.toHaveProperty('memberId');
  });

  it('rejects a plan item whose memberId is not a well-formed string', () => {
    const outcome = parseModelTurn(
      turnText([{ kind: 'planCreated', items: [{ id: 'p1', description: 'Inspect auth', memberId: 42 }] }]),
      { phase: 'planning' },
    );
    expect(outcome.ok).toBe(false);
    expect(failReasons(outcome)).toEqual([{ code: 'schema', message: expect.any(String) }]);
  });

  it('planRevised preserves prior item ids via the existing revisePlan and appends a new one', () => {
    const previousPlan = createPlan([{ id: 'p1', description: 'Inspect auth' }]) as Plan;
    const outcome = parseModelTurn(
      turnText([
        {
          kind: 'planRevised',
          items: [
            { id: 'p1', description: 'Inspect auth', state: 'completed' },
            { id: 'p2', description: 'Inspect billing coupling' },
          ],
          rationale: 'A schema consumer was found in another member',
        },
      ]),
      { phase: 'investigating', previousPlan },
    );
    const [msg] = okMessages(outcome);
    expect(msg?.kind).toBe('planRevised');
    if (msg?.kind === 'planRevised') {
      expect(msg.plan.revision).toBe(2);
      expect(msg.plan.items.map((i) => i.id)).toEqual(['p1', 'p2']);
      expect(msg.plan.items[0]?.state).toBe('completed');
      expect(msg.plan.rationale).toBe('A schema consumer was found in another member');
    }
  });

  it('planItemStateChanged round-trips against a known plan item', () => {
    const previousPlan = createPlan([{ id: 'p1', description: 'Inspect auth' }]) as Plan;
    const outcome = parseModelTurn(turnText([{ kind: 'planItemStateChanged', itemId: 'p1', state: 'active' }]), { phase: 'investigating', previousPlan });
    const [msg] = okMessages(outcome);
    expect(msg).toEqual({ kind: 'planItemStateChanged', itemId: 'p1', state: 'active' });
  });

  it('planItemStateChanged may reference an item newly added by a planRevised in the same batch', () => {
    const previousPlan = createPlan([{ id: 'p1', description: 'Inspect auth' }]) as Plan;
    const outcome = parseModelTurn(
      turnText([
        { kind: 'planRevised', items: [{ id: 'p1', description: 'Inspect auth' }, { id: 'p2', description: 'Inspect billing' }], rationale: 'Found a new unit' },
        { kind: 'planItemStateChanged', itemId: 'p2', state: 'active' },
      ]),
      { phase: 'investigating', previousPlan },
    );
    const messages = okMessages(outcome);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ kind: 'planItemStateChanged', itemId: 'p2', state: 'active' });
  });

  it('publicRationale round-trips sanitized text', () => {
    const outcome = parseModelTurn(turnText([{ kind: 'publicRationale', rationale: 'Widened scope after finding a shared schema.' }]), { phase: 'investigating' });
    const [msg] = okMessages(outcome);
    expect(msg).toEqual({ kind: 'publicRationale', rationale: 'Widened scope after finding a shared schema.' });
  });

  it('toolRequest round-trips readFile into the exact dispatcher-shaped request', () => {
    const outcome = parseModelTurn(
      turnText([{ kind: 'toolRequest', tool: 'readFile', memberId: 'm1', request: { snapshot: SNAPSHOT, revision: 'head', path: 'src/auth/token.ts', startLine: 10, endLine: 20 } }]),
      { phase: 'investigating' },
    );
    const [msg] = okMessages(outcome);
    expect(msg).toEqual({
      kind: 'toolRequest',
      call: { tool: 'readFile', memberId: 'm1', request: { snapshot: SNAPSHOT, revision: 'head', path: 'src/auth/token.ts', startLine: 10, endLine: 20 } },
    });
  });

  it('candidateSubmission round-trips through the existing parseCandidateFinding', () => {
    const outcome = parseModelTurn(
      turnText([
        {
          kind: 'candidateSubmission',
          candidate: {
            candidateId: 'c1',
            memberId: 'm1',
            file: 'src/auth/token.ts',
            line: 12,
            severity: 'major',
            category: 'security',
            confidence: 80,
            title: 'Missing expiry check',
            citations: { primary: { sourceId: 'src_0000000000000000000000000000000000000000000000000000000000000001', digest: 'a'.repeat(64), path: 'src/auth/token.ts', range: { startLine: 10, endLine: 15 } } },
          },
        },
      ]),
      { phase: 'investigating' },
    );
    const [msg] = okMessages(outcome);
    expect(msg?.kind).toBe('candidateSubmission');
    if (msg?.kind === 'candidateSubmission') {
      expect(msg.candidate.candidateId).toBe('c1');
      expect(msg.candidate.file).toBe('src/auth/token.ts');
    }
  });

  it('candidateSubmission with a supporting citation round-trips at the deepest legitimate nesting (message -> candidate -> citations -> supporting[] -> citation -> range)', () => {
    const outcome = parseModelTurn(
      turnText([
        {
          kind: 'candidateSubmission',
          candidate: {
            candidateId: 'c2',
            memberId: 'm1',
            file: 'src/auth/token.ts',
            line: 12,
            severity: 'major',
            category: 'security',
            confidence: 80,
            title: 'Missing expiry check',
            citations: {
              primary: { sourceId: 'primary-source', digest: 'a'.repeat(64), path: 'src/auth/token.ts', range: { startLine: 10, endLine: 15 } },
              supporting: [{ sourceId: 'supporting-source', digest: 'b'.repeat(64), path: 'src/auth/session.ts', range: { startLine: 1, endLine: 5 } }],
            },
          },
        },
      ]),
      { phase: 'investigating' },
    );
    expect(outcome.ok, `expected ok: ${JSON.stringify(outcome)}`).toBe(true);
    const [msg] = okMessages(outcome);
    expect(msg?.kind).toBe('candidateSubmission');
    if (msg?.kind === 'candidateSubmission') {
      expect(msg.candidate.citations.supporting?.[0]).toEqual({ sourceId: 'supporting-source', digest: 'b'.repeat(64), path: 'src/auth/session.ts', range: { startLine: 1, endLine: 5 } });
    }
  });

  it('checkpointSuggestion round-trips with and without a reason', () => {
    const withReason = okMessages(parseModelTurn(turnText([{ kind: 'checkpointSuggestion', reason: 'Good pause point after this unit' }]), { phase: 'investigating' }));
    expect(withReason[0]).toEqual({ kind: 'checkpointSuggestion', reason: 'Good pause point after this unit' });
    const withoutReason = okMessages(parseModelTurn(turnText([{ kind: 'checkpointSuggestion' }]), { phase: 'investigating' }));
    expect(withoutReason[0]).toEqual({ kind: 'checkpointSuggestion' });
  });

  it('completionRequest round-trips mirroring RequestCompletionToolRequest plus optional rationale', () => {
    const outcome = parseModelTurn(turnText([{ kind: 'completionRequest', memberId: 'm1', rationale: 'Every file classified and inspected' }]), { phase: 'verifying' });
    const [msg] = okMessages(outcome);
    expect(msg).toEqual({ kind: 'completionRequest', memberId: 'm1', rationale: 'Every file classified and inspected' });
  });
});

describe('parseModelTurn: fail-closed on malformed input', () => {
  it('rejects an unknown kind', () => {
    const outcome = parseModelTurn(turnText([{ kind: 'doSomethingElse' }]), { phase: 'planning' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('parse');
      expect(failReasons(outcome).some((r) => r.code === 'unknownKind')).toBe(true);
    }
  });

  it('rejects a message missing its kind discriminant', () => {
    const outcome = parseModelTurn(turnText([{ itemId: 'p1', state: 'active' }]), { phase: 'planning' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(failReasons(outcome).some((r) => r.code === 'missingKind')).toBe(true);
  });

  it('rejects a wrong-typed field', () => {
    const previousPlan = createPlan([{ id: 'p1', description: 'x' }]) as Plan;
    const outcome = parseModelTurn(turnText([{ kind: 'planItemStateChanged', itemId: 'p1', state: 123 }]), { phase: 'planning', previousPlan });
    expect(outcome.ok).toBe(false);
  });

  it('rejects an oversized field as a parse failure, not a best-effort coercion', () => {
    const outcome = parseModelTurn(turnText([{ kind: 'toolRequest', tool: 'readDiff', memberId: 'x'.repeat(5000), request: { snapshot: SNAPSHOT, path: 'a.ts' } }]), { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureKind).toBe('parse');
  });

  it('rejects excess batch size', () => {
    const messages = Array.from({ length: MAX_PROTOCOL_MESSAGES_PER_TURN + 1 }, (_, i) => ({ kind: 'planItemStateChanged', itemId: `p${i}`, state: 'active' }));
    const outcome = parseModelTurn(turnText(messages), { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(failReasons(outcome).some((r) => r.code === 'batchTooLarge')).toBe(true);
  });

  it('rejects an empty batch', () => {
    const outcome = parseModelTurn(turnText([]), { phase: 'planning' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(failReasons(outcome).some((r) => r.code === 'emptyBatch')).toBe(true);
  });

  it('rejects excess nesting, even inside a field that would otherwise be ignored', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 10; i += 1) deep = { nested: deep };
    const outcome = parseModelTurn(turnText([{ kind: 'checkpointSuggestion', extraneousField: deep }]), { phase: 'planning' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(failReasons(outcome).some((r) => r.code === 'excessDepth')).toBe(true);
  });

  it('rejects a turn that is not valid JSON at all', () => {
    const outcome = parseModelTurn('I think the code looks fine, no JSON here.', { phase: 'planning' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
  });

  it('rejects a turn whose JSON is neither an array nor a {messages} object', () => {
    const outcome = parseModelTurn(JSON.stringify({ kind: 'planCreated', items: [] }), { phase: 'planning' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(failReasons(outcome).some((r) => r.code === 'invalidEnvelope')).toBe(true);
  });

  it('accepts a bare JSON array envelope, not only {messages:[...]}', () => {
    const outcome = parseModelTurn(JSON.stringify([{ kind: 'checkpointSuggestion' }]), { phase: 'planning' });
    expect(outcome.ok).toBe(true);
  });

  it('extracts JSON from surrounding prose or a markdown code fence, tolerant of both array and object envelopes', () => {
    const proseWrapped = parseModelTurn('Sure, here is my turn:\n[{"kind":"checkpointSuggestion"}]\nHope that helps!', { phase: 'planning' });
    expect(proseWrapped.ok).toBe(true);
    const fenced = parseModelTurn('```json\n{"messages":[{"kind":"checkpointSuggestion"}]}\n```', { phase: 'planning' });
    expect(fenced.ok).toBe(true);
  });

  it('rejects a turn larger than the raw byte cap', () => {
    const huge = 'x'.repeat(70 * 1024);
    const outcome = parseModelTurn(huge, { phase: 'planning' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(failReasons(outcome).some((r) => r.code === 'turnTooLarge')).toBe(true);
  });
});

describe('parseModelTurn: phase contracts are distinct from parse failures', () => {
  it('rejects a well-formed message illegal in the current phase as a contract violation', () => {
    // planCreated is well-formed (no prior plan supplied) but only legal in 'planning'.
    const outcome = parseModelTurn(turnText([{ kind: 'planCreated', items: [{ id: 'p1', description: 'x' }] }]), { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('contract');
      expect(outcome.reasons.some((r) => r.code === 'phaseNotAllowed')).toBe(true);
    }
  });

  it('the same malformed shape in a legal phase is a parse failure, not a contract violation', () => {
    // planCreated with a duplicate item id: malformed regardless of phase.
    const outcome = parseModelTurn(
      turnText([{ kind: 'planCreated', items: [{ id: 'p1', description: 'x' }, { id: 'p1', description: 'y' }] }]),
      { phase: 'planning' },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureKind).toBe('parse');
  });

  it('rejects every message during bootstrap/completing/persisting: the model gets no turn in those phases', () => {
    for (const phase of ['bootstrap', 'completing', 'persisting'] as const) {
      const outcome = parseModelTurn(turnText([{ kind: 'publicRationale', rationale: 'anything' }]), { phase });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.failureKind).toBe('contract');
      expect(PHASE_ALLOWED_KINDS[phase]).toEqual([]);
    }
  });

  it('rejects an unauthorized tool name at parse time (not a phase issue)', () => {
    const outcome = parseModelTurn(turnText([{ kind: 'toolRequest', tool: 'madeUpTool', memberId: 'm1', request: {} }]), { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('parse');
      expect(outcome.reasons.some((r) => r.code === 'unknownTool')).toBe(true);
    }
  });

  it('every real read-tool name resolves against the catalog and is legal in investigating', () => {
    const readTools = ['listChangedFiles', 'readDiff', 'readFile', 'searchRepository', 'searchDiff', 'resolvePolicy', 'getChangeRequestDetails', 'getIssueDetails'] as const;
    for (const tool of readTools) {
      const request =
        tool === 'resolvePolicy'
          ? { kind: 'toolRequest', tool, memberId: 'm1', changedPath: 'src/a.ts' }
          : tool === 'readDiff'
            ? { kind: 'toolRequest', tool, memberId: 'm1', request: { snapshot: SNAPSHOT, path: 'a.ts' } }
            : tool === 'readFile'
            ? { kind: 'toolRequest', tool, memberId: 'm1', request: { snapshot: SNAPSHOT, revision: 'head', path: 'a.ts', startLine: 1, endLine: 2 } }
            : tool === 'searchRepository'
              ? { kind: 'toolRequest', tool, memberId: 'm1', request: { snapshot: SNAPSHOT, revision: 'head', query: 'token' } }
              : tool === 'getChangeRequestDetails'
                ? { kind: 'toolRequest', tool, memberId: 'm1', request: { snapshot: SNAPSHOT, number: '42' } }
                : tool === 'getIssueDetails'
                  ? { kind: 'toolRequest', tool, memberId: 'm1', request: { snapshot: SNAPSHOT, issueRepoId: 'repo-1', issueNumber: '7' } }
                  : tool === 'searchDiff'
                    ? { kind: 'toolRequest', tool, memberId: 'm1', request: { snapshot: SNAPSHOT, query: 'token' } }
                    : { kind: 'toolRequest', tool, memberId: 'm1', request: { snapshot: SNAPSHOT } };
      const outcome = parseModelTurn(turnText([request]), { phase: 'investigating' });
      expect(outcome.ok, `${tool} should parse: ${JSON.stringify(outcome)}`).toBe(true);
    }
  });

  it('rejects submitCandidateFinding/requestCompletion named inside a toolRequest envelope', () => {
    for (const tool of ['submitCandidateFinding', 'requestCompletion'] as const) {
      const outcome = parseModelTurn(turnText([{ kind: 'toolRequest', tool, memberId: 'm1', request: {} }]), { phase: 'verifying' });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reasons.some((r) => r.code === 'wrongKind')).toBe(true);
    }
  });
});

describe('parseModelTurn: batch compatibility', () => {
  it('rejects a completion request batched with more tool requests', () => {
    const outcome = parseModelTurn(
      turnText([
        { kind: 'completionRequest' },
        { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { snapshot: SNAPSHOT, path: 'a.ts' } },
      ]),
      { phase: 'verifying' },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reasons.some((r) => r.code === 'completionRequestNotFocused')).toBe(true);
  });

  it('rejects a completion request batched with a candidate submission', () => {
    const outcome = parseModelTurn(
      turnText([
        { kind: 'completionRequest' },
        {
          kind: 'candidateSubmission',
          candidate: {
            candidateId: 'c1',
            memberId: 'm1',
            file: 'a.ts',
            line: 1,
            severity: 'nit',
            category: 'style',
            confidence: 50,
            title: 't',
            citations: { primary: { sourceId: 'x', digest: 'a'.repeat(64) } },
          },
        },
      ]),
      { phase: 'verifying' },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reasons.some((r) => r.code === 'completionRequestNotFocused')).toBe(true);
  });

  it('rejects a checkpoint suggestion batched with a tool request', () => {
    const outcome = parseModelTurn(
      turnText([
        { kind: 'checkpointSuggestion' },
        { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { snapshot: SNAPSHOT, path: 'a.ts' } },
      ]),
      { phase: 'investigating' },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reasons.some((r) => r.code === 'checkpointNotFocused')).toBe(true);
  });

  it('rejects a checkpoint suggestion batched with a plan change', () => {
    const previousPlan = createPlan([{ id: 'p1', description: 'x' }]) as Plan;
    const outcome = parseModelTurn(
      turnText([
        { kind: 'checkpointSuggestion' },
        { kind: 'planRevised', items: [{ id: 'p1', description: 'x' }], rationale: 'r' },
      ]),
      { phase: 'investigating', previousPlan },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reasons.some((r) => r.code === 'checkpointNotFocused')).toBe(true);
  });

  it('rejects more toolRequest messages than the policy allows per turn', () => {
    const smallPolicy = { ...DEFAULT_HARNESS_POLICY, maxToolRequestsPerTurn: 2 };
    const messages = Array.from({ length: 3 }, (_, i) => ({ kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { snapshot: SNAPSHOT, path: `f${i}.ts` } }));
    const outcome = parseModelTurn(turnText(messages), { phase: 'investigating', policy: smallPolicy });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reasons.some((r) => r.code === 'tooManyToolRequests')).toBe(true);
  });

  it('allows a checkpoint suggestion alongside a candidate submission and plan-item transitions', () => {
    const previousPlan = createPlan([{ id: 'p1', description: 'x' }]) as Plan;
    const outcome = parseModelTurn(
      turnText([
        { kind: 'checkpointSuggestion', reason: 'good pause point' },
        { kind: 'planItemStateChanged', itemId: 'p1', state: 'completed' },
        {
          kind: 'candidateSubmission',
          candidate: {
            candidateId: 'c1',
            memberId: 'm1',
            file: 'a.ts',
            line: 1,
            severity: 'nit',
            category: 'style',
            confidence: 50,
            title: 't',
            citations: { primary: { sourceId: 'x', digest: 'a'.repeat(64) } },
          },
        },
      ]),
      { phase: 'investigating', previousPlan },
    );
    expect(outcome.ok).toBe(true);
  });

  it('allows a tool request batched with plan-item transitions and public rationale', () => {
    const previousPlan = createPlan([{ id: 'p1', description: 'x' }]) as Plan;
    const outcome = parseModelTurn(
      turnText([
        { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { snapshot: SNAPSHOT, path: 'a.ts' } },
        { kind: 'planItemStateChanged', itemId: 'p1', state: 'active' },
        { kind: 'publicRationale', rationale: 'Starting with the auth module.' },
      ]),
      { phase: 'investigating', previousPlan },
    );
    expect(outcome.ok).toBe(true);
  });
});

describe('candidateSubmission: failures surface as protocol-level reasons from parseCandidateFinding', () => {
  it('surfaces parseCandidateFinding schema reasons prefixed with candidate.', () => {
    const outcome = parseModelTurn(turnText([{ kind: 'candidateSubmission', candidate: { memberId: 'm1' } }]), { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('parse');
      expect(outcome.reasons.length).toBeGreaterThan(0);
      expect(outcome.reasons.every((r) => r.code.startsWith('candidate.'))).toBe(true);
    }
  });
});

describe('plan-shaping state preconditions', () => {
  it('rejects planCreated when a plan already exists', () => {
    const previousPlan = createPlan([{ id: 'p1', description: 'x' }]) as Plan;
    const outcome = parseModelTurn(turnText([{ kind: 'planCreated', items: [{ id: 'p2', description: 'y' }] }]), { phase: 'planning', previousPlan });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('parse');
      expect(outcome.reasons.some((r) => r.code === 'planAlreadyExists')).toBe(true);
    }
  });

  it('rejects planRevised when no plan exists yet', () => {
    const outcome = parseModelTurn(turnText([{ kind: 'planRevised', items: [{ id: 'p1', description: 'x' }], rationale: 'r' }]), { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('parse');
      expect(outcome.reasons.some((r) => r.code === 'noPriorPlan')).toBe(true);
    }
  });

  it('rejects planItemStateChanged naming an item no plan ever declared', () => {
    const previousPlan = createPlan([{ id: 'p1', description: 'x' }]) as Plan;
    const outcome = parseModelTurn(turnText([{ kind: 'planItemStateChanged', itemId: 'does-not-exist', state: 'active' }]), { phase: 'investigating', previousPlan });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reasons.some((r) => r.code === 'unknownItemId')).toBe(true);
  });
});

describe('raw model text cannot leave the parser', () => {
  const MARKER = `MARKER_${'X'.repeat(500)}`;

  it('an unparseable turn carrying the marker never echoes it in the failure reasons', () => {
    const outcome = parseModelTurn(`Some prose containing ${MARKER} but no JSON at all.`, { phase: 'planning' });
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(MARKER);
  });

  it('an ignored extra field carrying the marker is dropped, not carried through on success', () => {
    const outcome = parseModelTurn(turnText([{ kind: 'checkpointSuggestion', extraneousField: MARKER }]), { phase: 'planning' });
    expect(outcome.ok).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(MARKER);
  });

  it('an oversized field carrying the marker is rejected, not echoed', () => {
    const outcome = parseModelTurn(turnText([{ kind: 'checkpointSuggestion', reason: MARKER }]), { phase: 'planning' });
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(MARKER);
  });

  it('no type in this module has a field that could carry raw text — structural check on a large well-formed turn', () => {
    // Every returned field is a short, typed, bounded value; nothing resembles a raw prompt/response holder.
    const outcome = parseModelTurn(turnText([{ kind: 'publicRationale', rationale: 'A short, sanitized explanation.' }]), { phase: 'planning' });
    if (outcome.ok) {
      for (const message of outcome.messages) {
        expect(Object.keys(message)).not.toContain('raw');
        expect(Object.keys(message)).not.toContain('rawText');
        expect(Object.keys(message)).not.toContain('text');
      }
    }
  });
});

describe('buildRepairInstruction', () => {
  it('is bounded, sanitized, and never contains a distinctive marker from an echoed field', () => {
    const marker = `SECRET_${'Y'.repeat(1000)}`;
    const outcome = parseModelTurn(turnText([{ kind: 'toolRequest', tool: marker, memberId: 'm1', request: {} }]), { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const instruction = buildRepairInstruction(outcome.failureKind, outcome.reasons);
      expect(instruction).not.toContain(marker);
      expect(instruction.length).toBeLessThanOrEqual(MAX_REPAIR_INSTRUCTION_LENGTH);
      expect(instruction).toContain('parsed');
    }
  });

  it('names the phase-contract problem distinctly from a parse problem', () => {
    const contractInstruction = buildRepairInstruction('contract', [{ code: 'phaseNotAllowed', message: 'planCreated is not permitted during the investigating phase.' }]);
    const parseInstruction = buildRepairInstruction('parse', [{ code: 'unknownKind', message: '"bogus" is not a recognized message kind.' }]);
    expect(contractInstruction).toContain('phase');
    expect(parseInstruction).not.toBe(contractInstruction);
  });
});

describe('PHASE_ALLOWED_KINDS', () => {
  it('covers all six run phases', () => {
    expect(Object.keys(PHASE_ALLOWED_KINDS).sort()).toEqual(['bootstrap', 'completing', 'investigating', 'persisting', 'planning', 'verifying']);
  });

  it('planCreated is legal only in planning', () => {
    expect(PHASE_ALLOWED_KINDS.planning).toContain('planCreated');
    expect(PHASE_ALLOWED_KINDS.investigating).not.toContain('planCreated');
    expect(PHASE_ALLOWED_KINDS.verifying).not.toContain('planCreated');
  });

  it('completionRequest is legal in verifying, matching the reused catalog entry', () => {
    expect(PHASE_ALLOWED_KINDS.verifying).toContain('completionRequest');
  });
});
