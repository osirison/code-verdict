import { describe, expect, it } from 'vitest';
import { createPlan } from '../app/harnessActivityPlan';
import { sanitizePublicText } from '../app/harnessActivitySanitizer';
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
      turnText([{ kind: 'toolRequest', tool: 'readFile', memberId: 'm1', request: { revision: 'head', path: 'src/auth/token.ts', startLine: 10, endLine: 20 } }]),
      { phase: 'investigating' },
    );
    const [msg] = okMessages(outcome);
    // No `snapshot`: a request names the member and what to read, and the host pins it to that
    // member's own commits (`harnessToolDispatcher.ts`'s `snapshotOf`). `revision` stays, because
    // "base" or "head" is a choice between two named values, not a 40-character transcription.
    expect(msg).toEqual({
      kind: 'toolRequest',
      call: { tool: 'readFile', memberId: 'm1', request: { revision: 'head', path: 'src/auth/token.ts', startLine: 10, endLine: 20 } },
    });
  });

  /**
   * A model that keeps sending the old shape loses nothing.
   *
   * Removing `snapshot` from `TOOL_REQUEST_SPECS` was chosen over making it optional-and-ignored
   * precisely because it already *is* ignored: `parseToolCallFromSpec` reads only the fields its
   * spec names, and `harnessTurnSchema.ts` constrains no additional properties — so the shorter
   * shape and the forgiving behaviour come together rather than trading against each other.
   *
   * The two values below are the live corruptions that ended the transcription: the head sha
   * `1d801edd2f2e858c9bd8b03dbde5a09c48eccdae` with two characters dropped at position 24, and its
   * own prefix spliced onto the base sha's tail. In the run that produced them each cost a
   * `revisionMismatch` refusal; 87 of that run's 319 tool results were refused that way. Here they
   * parse, and nothing carries them onward.
   */
  it('ignores a snapshot a model still sends, including the two corruptions that ended the transcription', () => {
    const corruptions = ['1d801edd2f2e858c9bd8b03d' + 'e5a09c48eccdae', '1d801edd2f2e858c9bd8b03dbde2ebfb7a63e36'];
    for (const headSha of corruptions) {
      const outcome = parseModelTurn(
        turnText([
          {
            kind: 'toolRequest',
            tool: 'readDiff',
            memberId: 'osirison/code-verdict!68',
            request: { snapshot: { repoId: 'osirison/code-verdict', baseSha: '1d801edd2f2e858c9bd8b03dbde2ebfb7a63e36a', headSha }, path: 'package.json' },
          },
        ]),
        { phase: 'investigating' },
      );
      const [msg] = okMessages(outcome);
      expect(msg).toEqual({
        kind: 'toolRequest',
        call: { tool: 'readDiff', memberId: 'osirison/code-verdict!68', request: { path: 'package.json' } },
      });
    }
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
    const outcome = parseModelTurn(turnText([{ kind: 'toolRequest', tool: 'readDiff', memberId: 'x'.repeat(5000), request: { path: 'a.ts' } }]), { phase: 'investigating' });
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

  it('rejects a zero-byte reply with its own distinct reason, never the generic "no JSON found" one — the empty-response fix', () => {
    // A model that returns nothing is a different failure from a model that returns prose without
    // JSON: `lmAgent.ts`'s real evidence for this bug was exactly a 0-byte response, and a
    // reviewer debugging it needs to see "the model returned nothing", not a generic parse
    // complaint that could equally describe a garbled reply.
    const outcome = parseModelTurn('', { phase: 'planning' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('parse');
      expect(failReasons(outcome).some((r) => r.code === 'emptyResponse')).toBe(true);
      expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(false);
    }
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

  it('extracts a fenced turn of either envelope shape, and refuses one wrapped in prose', () => {
    // The prose-wrapped half of this used to pass. `extractJsonValue` no longer looks anywhere but
    // the first character, after trimming and after stripping the fence.
    const fencedObject = parseModelTurn('```json\n{"messages":[{"kind":"checkpointSuggestion"}]}\n```', { phase: 'planning' });
    expect(fencedObject.ok).toBe(true);
    const fencedArray = parseModelTurn('```json\n[{"kind":"checkpointSuggestion"}]\n```', { phase: 'planning' });
    expect(fencedArray.ok).toBe(true);
    const proseWrapped = parseModelTurn('Sure, here is my turn:\n[{"kind":"checkpointSuggestion"}]\nHope that helps!', { phase: 'planning' });
    expect(proseWrapped.ok).toBe(false);
    if (!proseWrapped.ok) expect(failReasons(proseWrapped).some((r) => r.code === 'noJson')).toBe(true);
  });

  it('rejects a turn larger than the raw byte cap', () => {
    const huge = 'x'.repeat(70 * 1024);
    const outcome = parseModelTurn(huge, { phase: 'planning' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(failReasons(outcome).some((r) => r.code === 'turnTooLarge')).toBe(true);
  });
});
describe('parseModelTurn: a complete turn followed by a trailing-garbage tail', () => {
  // A live review of a 207-file change lost five whole turns to two characters. The model emitted a
  // complete, valid `{"messages":[...]}` object and then appended a spurious `]}` — observed
  // verbatim three times in that one run, always the same shape, on objects of 2229, 2434 and 2296
  // bytes. `JSON.parse` reports "Extra data" at the first character past the valid value, and the
  // salvage path (written for prose *around* JSON) picked the junk brace as the closing one, so it
  // re-parsed the identical text and failed identically. Every message in those turns was
  // well-formed; the run threw all of them away.
  const threeToolRequests = [
    { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'src/a.ts' } },
    { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'src/b.ts' } },
    { kind: 'toolRequest', tool: 'readFile', memberId: 'm1', request: { revision: 'head', path: 'src/c.ts', startLine: 1, endLine: 40 } },
  ];

  it('parses the observed payload — a valid {messages:[...]} object with an extra "]}" glued to the end', () => {
    const outcome = parseModelTurn(`${turnText(threeToolRequests)}]}`, { phase: 'investigating' });
    expect(outcome.ok).toBe(true);
    expect(okMessages(outcome)).toHaveLength(3);
    expect(outcome.meta.messageCount).toBe(3);
  });

  it('parses a bare-array envelope carrying the same tail', () => {
    const outcome = parseModelTurn(`${JSON.stringify([{ kind: 'checkpointSuggestion' }])}]}`, { phase: 'planning' });
    expect(outcome.ok).toBe(true);
    expect(okMessages(outcome)).toHaveLength(1);
  });

  it('is not confused by braces, brackets and quotes inside a string value', () => {
    // The depth scan has to know it is inside a string literal. Our tool requests carry "path"
    // values and change-request bodies carry arbitrary prose, so an unbalanced "}" inside a string
    // is ordinary content — a scan that counted it would close the value early and slice a prefix.
    const rationale = 'Checking a stray } and { and ] and [ plus a "quoted" run and a \\" escape.';
    const outcome = parseModelTurn(`${turnText([{ kind: 'publicRationale', rationale }])}]}`, { phase: 'investigating' });
    expect(outcome.ok).toBe(true);
    const [message] = okMessages(outcome);
    expect(message?.kind).toBe('publicRationale');
    if (message?.kind === 'publicRationale') expect(message.rationale).toBe(rationale);
  });

  it('parses a trailing tail on a turn whose nested objects and arrays are deeply mixed', () => {
    const outcome = parseModelTurn(
      `${turnText([{ kind: 'planCreated', items: [{ id: 'p1', description: 'Inspect {auth}' }, { id: 'p2', description: 'Inspect [schema]' }] }])}]}`,
      { phase: 'planning' },
    );
    expect(outcome.ok).toBe(true);
    expect(okMessages(outcome)).toHaveLength(1);
  });

  it('refuses the same tail INSIDE a fence, which it used to parse — the deliberate half of the trade', () => {
    // This test asserted `ok: true` until the fenced content was required to parse whole. The
    // reason it flipped: a fence delimits the payload exactly and the model drew that boundary
    // itself, so a complete value plus anything else inside the block is two things in one block,
    // and there is no honest way to pick between them — the parser cannot tell this reply from the
    // one below where the second thing is a real turn being silently discarded.
    //
    // Both sides of the trade are speculative. The `]}` has only ever been observed UNFENCED
    // (three times in one live run), and that reply still parses with zero repairs, as the tests
    // above pin. So this is decided on severity, not likelihood: one loud repair on a fenced reply
    // nobody has seen, against handing over the wrong turn and reporting success.
    const outcome = parseModelTurn(`\`\`\`json\n${turnText([{ kind: 'checkpointSuggestion' }])}]}\n\`\`\``, { phase: 'planning' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('parse');
      expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
      expect(outcome.meta.messageCount).toBe(0);
    }
  });

  it('still fails a truncated turn rather than silently parsing the prefix, and says so distinctly', () => {
    // The one real risk of tolerating a tail: a turn cut off mid-value must never become a
    // half-turn that looks successful. Depth never returns to zero here, so there is no complete
    // value to salvage and the turn fails whole.
    const complete = turnText(threeToolRequests);
    const outcome = parseModelTurn(complete.slice(0, complete.length - 80), { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('parse');
      expect(failReasons(outcome).some((r) => r.code === 'unterminatedJson')).toBe(true);
      expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(false);
    }
  });

  it('reports a balanced-but-invalid value as noJson, not as an unterminated one', () => {
    // Depth closes, so nothing was cut off — the value is simply not JSON. The two failures are
    // different things to tell the model, so they must not collapse into one code.
    const outcome = parseModelTurn('{"messages":[{"kind":"checkpointSuggestion"},]}', { phase: 'planning' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
      expect(failReasons(outcome).some((r) => r.code === 'unterminatedJson')).toBe(false);
    }
  });

  it('refuses prose on both sides of the JSON, which the salvage path used to accept', () => {
    // Replaces "still discards prose on both sides of the JSON, as the salvage path always has".
    // Searching prose for a JSON value is the capability `extractJsonValue` gave up after three
    // rounds in which every search rule had a class of reply where it ran the wrong messages and
    // reported success. A turn wrapped in prose costs one repair now; that is the price paid.
    const outcome = parseModelTurn(
      'Let me think this through out loud first. Now here is my reply: {"messages":[{"kind":"checkpointSuggestion"}]} Hope that helps!',
      { phase: 'planning' },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('parse');
      expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
    }
    // Prose AFTER the turn still costs nothing: the value starts at character 0 and ends where it
    // ends. That is the same tolerance the trailing `]}` above needs, seen from the other side.
    const objectFirst = parseModelTurn('{"messages":[{"kind":"checkpointSuggestion"}]} Hope that helps!', { phase: 'planning' });
    expect(objectFirst.ok).toBe(true);
    expect(okMessages(objectFirst)).toHaveLength(1);
  });
});

describe('parseModelTurn: the turn must begin at the first character', () => {
  // Three rounds of rules for finding a turn inside arbitrary prose are gone. Round 1 took the
  // first complete value and ran a worked example instead of the turn quoted after it. Round 2
  // took the last object-form envelope and broke four more ways, all silent. Round 3 counted
  // turn-shaped values and broke on string parity — a stray opener in prose with an odd number of
  // quote characters flips the scan across the real turn, so a `}` inside one of the turn's own
  // string values closes the span, the slice fails to parse, and an earlier example is handed over
  // as the only turn. A fuzz over 5000 realistic review replies measured 68 silent wrong answers
  // there (1.4%).
  //
  // So the search is removed rather than refined: the turn must begin at character 0, after
  // trimming and after stripping a code fence. There is exactly one candidate position, so there
  // is never a choice to get wrong. The tests below are the five historical break cases, each one
  // re-derived under this rule rather than assumed, plus the replies that must still parse.
  const twoToolRequests = [
    { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'src/a.ts' } },
    { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'src/b.ts' } },
  ];
  const example = turnText([{ kind: 'publicRationale', rationale: 'example only, ignore this one' }]);
  const bareTurn = JSON.stringify([{ kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'src/c.ts' } }]);

  it('parses a reply that is exactly one valid turn and nothing else', () => {
    // The overwhelmingly common reply, and the one the retreat must not have touched.
    const outcome = parseModelTurn(turnText(twoToolRequests), { phase: 'investigating' });
    expect(outcome.ok).toBe(true);
    expect(okMessages(outcome)).toHaveLength(2);
    expect(outcome.meta.messageCount).toBe(2);
  });

  it('break case 1: a worked example, then the real turn — fails loudly and runs neither', () => {
    // Round 1 ran the example and dropped both real tool requests, reported `ok: true`. Nothing is
    // read past the first character now, and the first character is prose, so the reply is refused
    // whole and the model is told to put the object first.
    const outcome = parseModelTurn(
      `For reference the shape is ${example} — and here is my actual turn: ${turnText(twoToolRequests)}`,
      { phase: 'investigating' },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('parse');
      expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
      expect(outcome.meta.messageCount).toBe(0);
    }
  });

  it.each([10, 40, 70, 120])('break case 2: an example, then a real turn cut off — fails loudly (%i characters cut)', (cut) => {
    // Round 2's worst finding: last-wins skipped the truncated real turn because it never closed,
    // handed the example over as the only complete envelope, and never mentioned the truncation.
    // The diagnosis moves from `unterminatedJson` to `noJson`, which is the truthful one — this
    // reply did not begin with a JSON object at all, and what it did to its own turn afterwards is
    // not something the parser can honestly claim to know.
    const complete = turnText(twoToolRequests);
    const outcome = parseModelTurn(`Shape: ${example}\nTurn: ${complete.slice(0, complete.length - cut)}`, { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
      // The example parsed perfectly well; nothing from it reaches the caller or the meta.
      expect(outcome.meta.messageCount).toBe(0);
    }
  });

  it('break case 3: the real turn, then an envelope quoted after it — runs the real turn', () => {
    // The one of the five that stops being a break case instead of becoming a loud failure, and it
    // is worth being plain about why: the reply begins with the real turn, so the single candidate
    // position holds the right value and the quotation is a trailing tail — the same tail the live
    // `]}` bug needs ignored. Round 2 ran the quotation here and dropped both tool requests.
    const outcome = parseModelTurn(
      `${turnText(twoToolRequests)}\nFor the record, the turn you rejected earlier was ${example} — I have not resent it.`,
      { phase: 'investigating' },
    );
    expect(outcome.ok).toBe(true);
    expect(okMessages(outcome)).toHaveLength(2);
    // Move one word of prose in front of it and it is refused, because now nothing is at the start.
    const withPreamble = parseModelTurn(
      `Resending: ${turnText(twoToolRequests)}\nFor the record, the turn you rejected earlier was ${example}.`,
      { phase: 'investigating' },
    );
    expect(withPreamble.ok).toBe(false);
    if (!withPreamble.ok) expect(failReasons(withPreamble).some((r) => r.code === 'noJson')).toBe(true);
  });

  it('break case 4: an object-form example paired with a bare-array real turn', () => {
    // Round 2 preferred the object form regardless of position, so the example ran whichever side
    // of it the real turn was on. With the example first there is prose at the start and the reply
    // is refused; with the bare-array turn first, the turn is at character 0 and runs.
    const exampleFirst = parseModelTurn(`Format: ${example}\nMy turn: ${bareTurn}`, { phase: 'investigating' });
    expect(exampleFirst.ok).toBe(false);
    if (!exampleFirst.ok) expect(failReasons(exampleFirst).some((r) => r.code === 'noJson')).toBe(true);
    const turnFirst = parseModelTurn(`${bareTurn}\nThat is the shape you asked for; the object form is ${example}`, { phase: 'investigating' });
    expect(turnFirst.ok).toBe(true);
    expect(okMessages(turnFirst)).toHaveLength(1);
  });

  it('break case 5: the round-3 parity case, with prose in front of it', () => {
    // The reply that measured 68 wrong answers in 5000: an example, then a stray opener inside a
    // quoted fragment carrying an ODD number of quote characters, then the real turn — whose own
    // string value contains a `}`. Round 3's scan crossed the real turn with its string state
    // inverted, read the turn's braces as string contents, closed the span on that `}`, failed to
    // parse the slice, and handed over the example as the only turn it could see. There is no scan
    // to invert now: the reply starts with prose, so it is refused whole.
    const parityTurn = turnText([{ kind: 'publicRationale', rationale: 'The old guard `if (!user) { return; }` is gone from src/a.ts.' }]);
    const outcome = parseModelTurn(
      `Here is the shape I was given: ${example} The guard "if (!user) {" is gone. ${parityTurn}`,
      { phase: 'investigating' },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
      expect(outcome.meta.messageCount).toBe(0);
    }
  });

  it('the residual this rule does not remove: an example FIRST, with nothing before it, runs the example', () => {
    // Pinned deliberately, as an accepted cost rather than an oversight. Telling a junk tail
    // (`]}`) from a second envelope in the tail means reading the tail, and reading the tail is
    // the search that produced three rounds of silent wrong answers. The live bug — a valid turn
    // plus a stray `]}` — is what demands the tail be ignored, so a reply that opens with a
    // complete example gets that example run. Every arrangement of this mistake with any prose in
    // front of the example, which is how a model actually writes one, fails loudly above.
    const parityTurn = turnText([{ kind: 'publicRationale', rationale: 'The old guard `if (!user) { return; }` is gone from src/a.ts.' }]);
    const outcome = parseModelTurn(`${example} The guard "if (!user) {" is gone. ${parityTurn}`, { phase: 'investigating' });
    expect(outcome.ok).toBe(true);
    const [message] = okMessages(outcome);
    expect(message?.kind).toBe('publicRationale');
    if (message?.kind === 'publicRationale') expect(message.rationale).toBe('example only, ignore this one');
  });

  it('reports a reply that opens a value and never closes it as unterminated, not as noJson', () => {
    // A run of openers before the turn is not a preamble the parser reads past any more: the value
    // beginning at character 0 never closes, and that is what the model is told.
    const beyond = parseModelTurn(`${'{'.repeat(5)} ${turnText(twoToolRequests)}`, { phase: 'investigating' });
    expect(beyond.ok).toBe(false);
    if (!beyond.ok) {
      expect(failReasons(beyond).some((r) => r.code === 'unterminatedJson')).toBe(true);
      expect(failReasons(beyond).some((r) => r.code === 'noJson')).toBe(false);
    }
  });

  it.each([
    ['a bare array of numbers', 'Targets: [1,2,3]\n'],
    ['an empty object', 'Shape: {}\n'],
    ['an object that is not an envelope', 'Note: {"a":1}\n'],
    ['a markdown checkbox', 'Plan:\n- [ ] read src/a.ts\n'],
    ['a citation marker', 'Per the docs [1] I will read the diff.\n'],
    ['a long run of complete values', `Shapes I considered: ${'{}'.repeat(200)}\n`],
  ])('refuses %s in the preamble, where the walk used to read past it', (_label, preamble) => {
    // Each of these was a case the walk had to be taught to skip, and each way of teaching it cost
    // a class of silent wrong answer somewhere else. None of them is read now: a reply that does
    // not start with its turn is refused, and the repair note says to put the object first.
    const outcome = parseModelTurn(preamble + turnText(twoToolRequests), { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
  });

  it.each([
    ['a citation', ' I will check auth.ts [1] next.'],
    ['a checkbox list', '\n- [ ] remaining files\n- [ ] tests'],
    ['an empty array', ' Nothing else outstanding: []'],
    ['a second copy of the turn', `\n${turnText([{ kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'src/a.ts' } }])}`],
  ])('keeps the real turn when the prose after it contains %s', (_label, trailer) => {
    // Anything after the turn is a tail, whatever it looks like. A model signing off with a
    // checklist and a model stuttering its turn twice are the same case here, and neither one asks
    // anybody to choose: the value at character 0 is the turn.
    const outcome = parseModelTurn(turnText(twoToolRequests) + trailer, { phase: 'investigating' });
    expect(outcome.ok).toBe(true);
    expect(okMessages(outcome)).toHaveLength(2);
  });

  it('runs the turn a model sent twice, whether or not the second copy is byte-identical', () => {
    // Round 3 collapsed byte-identical duplicates and refused two spellings of the same batch,
    // because it had to count turn-shaped values and a re-serialization is a second write. Nothing
    // counts any more, so both are just a turn with a tail, and the messages are the same either
    // way — which is what made refusing the second one hard to justify.
    const turn = turnText(twoToolRequests);
    const identical = parseModelTurn(`${turn}\n${turn}`, { phase: 'investigating' });
    expect(identical.ok).toBe(true);
    expect(okMessages(identical)).toHaveLength(2);
    const reserialized = parseModelTurn(`${turn}\n${JSON.stringify({ messages: twoToolRequests }, null, 2)}`, { phase: 'investigating' });
    expect(reserialized.ok).toBe(true);
    expect(okMessages(reserialized)).toHaveLength(2);
  });

  it('still accepts a lone bare-array turn, as the parser always has', () => {
    // `rawMessageEntries` is unchanged: the leniency inherited from the legacy extraction stays,
    // and the schema shipped in the prompt still describes both shapes.
    const outcome = parseModelTurn(bareTurn, { phase: 'investigating' });
    expect(outcome.ok).toBe(true);
    expect(okMessages(outcome)).toHaveLength(1);
  });

  it('keeps the envelope complaint for a reply that is one JSON value of the wrong shape', () => {
    // The value is at character 0 and parses, so it is handed on and `parseModelTurn` names the
    // real problem — the shape — rather than the catch-all. Buried in prose it is a different
    // failure, and the model is told the different thing.
    const alone = parseModelTurn('{"a":1}', { phase: 'investigating' });
    expect(alone.ok).toBe(false);
    if (!alone.ok) expect(failReasons(alone).some((r) => r.code === 'invalidEnvelope')).toBe(true);
    const inProse = parseModelTurn('I read the diff. Note: {"a":1} — nothing else to add.', { phase: 'investigating' });
    expect(inProse.ok).toBe(false);
    if (!inProse.ok) expect(failReasons(inProse).some((r) => r.code === 'noJson')).toBe(true);
  });

  it('still reports prose carrying no JSON at all as noJson', () => {
    const outcome = parseModelTurn('I think the code looks fine, nothing to request.', { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
  });

  it('separates a turn that was cut off from a reply that never started one', () => {
    // Both diagnoses stay, and the difference is only where the value begins. A truncated turn
    // sent on its own is `unterminatedJson` — resend it. The same truncated turn behind a preamble
    // is `noJson` — the reply did not begin with a JSON object, which is all this parser saw and
    // all it will say.
    const complete = turnText(twoToolRequests);
    const truncated = parseModelTurn(complete.slice(0, complete.length - 60), { phase: 'investigating' });
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) {
      expect(failReasons(truncated).some((r) => r.code === 'unterminatedJson')).toBe(true);
      expect(failReasons(truncated).some((r) => r.code === 'noJson')).toBe(false);
    }
    const behindPreamble = parseModelTurn(`Note: {"a":1}\n${complete.slice(0, complete.length - 60)}`, { phase: 'investigating' });
    expect(behindPreamble.ok).toBe(false);
    if (!behindPreamble.ok) {
      expect(failReasons(behindPreamble).some((r) => r.code === 'noJson')).toBe(true);
      expect(failReasons(behindPreamble).some((r) => r.code === 'unterminatedJson')).toBe(false);
      expect(failReasons(behindPreamble).some((r) => r.code === 'invalidEnvelope')).toBe(false);
    }
  });

  it('keeps a turn that was read whole when a later value never closes', () => {
    // `Next I will read function f() {` is a tail like any other. Round 3 needed a content test to
    // tell this from a real truncation; the position rule needs nothing, because the turn was
    // already complete before that brace appeared.
    const outcome = parseModelTurn(`${turnText(twoToolRequests)}\nNext I will read function f() {`, { phase: 'investigating' });
    expect(outcome.ok).toBe(true);
    expect(okMessages(outcome)).toHaveLength(2);
  });
});

describe('parseModelTurn: a code fence is stripped only when the reply is ONE fenced block', () => {
  // The fence pass had quietly reopened the hole the position rule exists to close. Its pattern is
  // anchored at both ends with no `m` flag, so a reply that OPENS with a fence and CLOSES with a
  // fence matched from the first opening fence to the last closing one, and the capture — interior
  // fences, prose and all — became the text whose position 0 was treated as the model's payload.
  // A fenced worked example at the top of the reply therefore ran, and the real turn below it was
  // never read. Every row of the table below was measured on this parser before the guard.
  const twoToolRequests = [
    { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'src/a.ts' } },
    { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'src/b.ts' } },
  ];
  const realTurn = turnText(twoToolRequests);
  const example = turnText([{ kind: 'publicRationale', rationale: 'example only, ignore this one' }]);
  const fence = '```';
  const fenced = (body: string) => `${fence}json\n${body}\n${fence}`;

  it('a fenced example, prose, then the fenced real turn — used to run the EXAMPLE, now fails loudly', () => {
    // The widest of the five, and the one a review model actually writes: lead with the shape, then
    // send the turn. It reported `ok: true` with one `publicRationale` and both tool requests gone.
    const outcome = parseModelTurn(`${fenced(example)}\n\nAnd here is my actual turn:\n\n${fenced(realTurn)}`, { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('parse');
      expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
      expect(outcome.meta.messageCount).toBe(0);
    }
  });

  it('two fenced examples before the fenced real turn — used to run the FIRST example', () => {
    // The capture ran to the LAST closing fence however many blocks were inside it, so adding
    // blocks never changed which one won: position 0 was always the first block's content.
    const outcome = parseModelTurn(
      `${fenced(example)}\nor equivalently\n${fenced(example)}\nand my turn is\n${fenced(realTurn)}`,
      { phase: 'investigating' },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
  });

  it('a fenced example before a fenced TRUNCATED real turn — used to run the example and never report the truncation', () => {
    // Round 2's worst finding, reached through the fence pass instead of through a search: the
    // model was cut off mid-turn and was told its reply was fine. Now the reply is refused whole,
    // and `noJson` is the truthful diagnosis — this reply did not begin with a JSON value, and
    // what happened to the block further down is not something this parser can claim to know.
    const outcome = parseModelTurn(
      `${fenced(example)}\n\nTurn:\n\n${fenced(realTurn.slice(0, realTurn.length - 40))}`,
      { phase: 'investigating' },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
      expect(outcome.meta.messageCount).toBe(0);
    }
  });

  it('the same multi-fence reply written compactly, with the interior fences mid-line', () => {
    // Why the guard tests for a fence marker ANYWHERE in the capture rather than only at the start
    // of a line: a model that writes its blocks compactly puts no interior fence at a line start,
    // and a line-anchored test would strip this and run the example — the exact silent substitution
    // being removed. A raw newline cannot appear inside a JSON string literal, so the line-anchored
    // test looked safe; it is safe only against the interior fences that happen to be formatted.
    const outcome = parseModelTurn(`${fence}json\n${example} ${fence} then the real one: ${fence}json ${realTurn}\n${fence}`, { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
  });

  it.each([
    ['one word of prose before the first fence', (reply: string) => `Shape:\n${reply}`],
    ['no final closing fence', (reply: string) => reply.slice(0, reply.length - 3)],
  ])('already failed before the guard when the reply %s, and still does', (_label, mangle) => {
    // The two rows of the table that were never silent. They are pinned because they show how
    // narrow the accident was — the reply had to open with a fence AND close with one to be
    // mangled at all — and because their diagnosis must not drift now that the guard is in front.
    const reply = `${fenced(example)}\n\nAnd here is my actual turn:\n\n${fenced(realTurn)}`;
    const outcome = parseModelTurn(mangle(reply), { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
  });

  it('still parses a genuine single fenced turn, of either envelope shape, with no repair', () => {
    // The case the fence pass exists for, and the one the guard must not cost anything. One block,
    // no fence marker inside it, so the fence is stripped and position 0 is the whole payload.
    const objectForm = parseModelTurn(fenced(realTurn), { phase: 'investigating' });
    expect(objectForm.ok).toBe(true);
    expect(okMessages(objectForm)).toHaveLength(2);
    expect(objectForm.meta.messageCount).toBe(2);
    const bareArray = parseModelTurn(fenced(JSON.stringify(twoToolRequests)), { phase: 'investigating' });
    expect(bareArray.ok).toBe(true);
    expect(okMessages(bareArray)).toHaveLength(2);
  });

  it('still parses a single fenced turn whose string values carry single backticks and stray braces', () => {
    // Single backticks are how a model ordinarily quotes an identifier, and they are untouched:
    // the guard looks for a three-backtick run, not for a backtick.
    const rationale = 'The old guard `if (!user) { return; }` is gone from src/a.ts.';
    const outcome = parseModelTurn(fenced(turnText([{ kind: 'publicRationale', rationale }])), { phase: 'investigating' });
    expect(outcome.ok).toBe(true);
    const [message] = okMessages(outcome);
    if (message?.kind === 'publicRationale') expect(message.rationale).toBe(rationale);
  });

  it('the residual the guard accepts: a single fenced turn quoting a three-backtick run costs one repair', () => {
    // Pinned deliberately, as a cost rather than an oversight. This reply IS one fenced block and
    // its turn is perfectly good, but the only way to know that is to read the capture and decide
    // which of its fence markers are "really" fences — the search this module abandoned after three
    // rounds of silent wrong answers. So the fence is left in place, the text starts with a
    // backtick, and the model is told to send the object first. One loud repair on a rare reply,
    // against a silent substitution on a common one.
    const outcome = parseModelTurn(
      fenced(turnText([{ kind: 'publicRationale', rationale: 'The block ```js x``` was deleted.' }])),
      { phase: 'investigating' },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
  });
});

describe('parseModelTurn: a stripped fence must hold the WHOLE turn and nothing else', () => {
  // The guard above closed the case where a worked example and the real turn each sat in their own
  // code block. It does not reach the narrower one: BOTH values inside a SINGLE block. That reply
  // is one fenced block and carries no interior fence marker, so it strips — and position 0 of the
  // stripped content is the example, with the real turn sitting in what the trailing-tail rule
  // treated as junk. Measured on this parser, and it behaved the same before that guard existed,
  // so this is not the guard's regression:
  //
  //   | one fenced block, two values inside | before this rule                                |
  //   | the example, then the real turn     | ok — the EXAMPLE ran, the tool request dropped  |
  //   | the example, then the real turn CUT | ok — the example ran and the truncation was     |
  //   | OFF                                 | never reported                                  |
  //
  // The rule that closes it: where a fence was stripped, the content must parse WHOLE. A fence
  // delimits the payload exactly and the model drew that boundary itself, so a value followed by
  // anything else inside it means two things in one block, and there is no honest way to pick
  // between them. Outside a fence there is no boundary the model drew, which is why a tail is
  // still tolerated there — that is the live `]}` reply, pinned at the end of this block.
  const realTurn = turnText([{ kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'src/one.ts' } }]);
  const example = turnText([{ kind: 'publicRationale', rationale: 'illustration only' }]);
  const fence = '```';

  it('two values in one fence, the example first — used to run the example and drop the real tool request', () => {
    const outcome = parseModelTurn(`${fence}json\n${example}\n${realTurn}\n${fence}`, { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('parse');
      expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
      expect(outcome.meta.messageCount).toBe(0);
    }
  });

  it.each([20, 45, 70])('the same block with the real turn cut off — used to report success and never mention it (%i characters cut)', (cut) => {
    // The severe half. A model that was cut off has to resend its turn; being told the turn was
    // fine is the one answer that guarantees it never will.
    const outcome = parseModelTurn(`${fence}json\n${example}\n${realTurn.slice(0, realTurn.length - cut)}\n${fence}`, { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
      expect(outcome.meta.messageCount).toBe(0);
    }
  });

  it.each([
    ['no language tag', (body: string) => `${fence}\n${body}\n${fence}`],
    ['an uppercase JSON tag', (body: string) => `${fence}JSON\n${body}\n${fence}`],
    ['a language tag naming the wrong language', (body: string) => `${fence}javascript\n${body}\n${fence}`],
    ['CRLF line endings', (body: string) => `${fence}json\r\n${body.replace(/\n/g, '\r\n')}\r\n${fence}`],
    ['an indented closing fence', (body: string) => `${fence}json\n${body}\n  ${fence}`],
    ['blank lines before the opening fence', (body: string) => `\n\n${fence}json\n${body}\n${fence}`],
  ])('closes the same hole when the block is written with %s', (_label, wrap) => {
    // Every one of these spellings matches the fence pattern, so every one of them stripped and ran
    // the example. They are pinned individually because the rule has to hold for the way a model
    // actually writes a block — an absent or wrong tag, Windows line endings, a block indented
    // under a list item — and not only for the canonical form.
    const outcome = parseModelTurn(wrap(`${example}\n${realTurn}`), { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(true);
      expect(outcome.meta.messageCount).toBe(0);
    }
  });

  it('keeps unterminatedJson distinct for a fenced value that never closes', () => {
    // Refusing the tail must not cost the diagnosis. The end of the value is still located, for
    // this alone: a model whose turn stops mid-value has to resend it, and telling it the reply did
    // not begin with JSON would be false and would send it hunting for a preamble that is not there.
    const outcome = parseModelTurn(`${fence}json\n${realTurn.slice(0, realTurn.length - 30)}\n${fence}`, { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(failReasons(outcome).some((r) => r.code === 'unterminatedJson')).toBe(true);
      expect(failReasons(outcome).some((r) => r.code === 'noJson')).toBe(false);
    }
  });

  it('costs the three replies it was not aimed at nothing: the live tail, a single fenced turn, a plain turn', () => {
    // Kept beside the refusals so the whole trade reads in one place. The first is the live payload
    // this path exists for — a complete turn plus a stray `]}`, UNFENCED — and it is why the rule
    // is scoped to a stripped fence rather than applied everywhere.
    const liveTail = parseModelTurn(`${realTurn}]}`, { phase: 'investigating' });
    expect(okMessages(liveTail).map((m) => m.kind)).toEqual(['toolRequest']);
    const singleFenced = parseModelTurn(`${fence}json\n${realTurn}\n${fence}`, { phase: 'investigating' });
    expect(okMessages(singleFenced).map((m) => m.kind)).toEqual(['toolRequest']);
    const plain = parseModelTurn(realTurn, { phase: 'investigating' });
    expect(okMessages(plain).map((m) => m.kind)).toEqual(['toolRequest']);
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
            ? { kind: 'toolRequest', tool, memberId: 'm1', request: { path: 'a.ts' } }
            : tool === 'readFile'
            ? { kind: 'toolRequest', tool, memberId: 'm1', request: { revision: 'head', path: 'a.ts', startLine: 1, endLine: 2 } }
            : tool === 'searchRepository'
              ? { kind: 'toolRequest', tool, memberId: 'm1', request: { revision: 'head', query: 'token' } }
              : tool === 'getChangeRequestDetails'
                ? { kind: 'toolRequest', tool, memberId: 'm1', request: { number: '42' } }
                : tool === 'getIssueDetails'
                  ? { kind: 'toolRequest', tool, memberId: 'm1', request: { issueRepoId: 'repo-1', issueNumber: '7' } }
                  : tool === 'searchDiff'
                    ? { kind: 'toolRequest', tool, memberId: 'm1', request: { query: 'token' } }
                    : { kind: 'toolRequest', tool, memberId: 'm1', request: {} };
      const outcome = parseModelTurn(turnText([request]), { phase: 'investigating' });
      expect(outcome.ok, `${tool} should parse: ${JSON.stringify(outcome)}`).toBe(true);
    }
  });

  /**
   * A live review lost three of its eight turns — about 64 seconds of 175 — to
   * "getChangeRequestDetails.request.number is required" after replying `"number": 388`. Nothing
   * in the prompt says the identifier is a string: it is spelled #388 throughout. The same defect
   * as the pagination cursor, and the same cost, so a number is accepted here and normalized.
   */
  it('accepts a change-request or issue number written as a JSON number, normalized to the string the request carries', () => {
    for (const [tool, request, field] of [
      ['getChangeRequestDetails', { snapshot: SNAPSHOT, number: 388 }, 'number'],
      ['getIssueDetails', { snapshot: SNAPSHOT, issueRepoId: 'repo-1', issueNumber: 7 }, 'issueNumber'],
    ] as const) {
      const outcome = parseModelTurn(turnText([{ kind: 'toolRequest', tool, memberId: 'm1', request }]), { phase: 'investigating' });
      expect(outcome.ok, `${tool} should parse: ${JSON.stringify(outcome)}`).toBe(true);
      if (!outcome.ok) continue;
      const message = outcome.messages[0] as unknown as { call: { request: Record<string, unknown> } };
      expect(message.call.request[field]).toBe(String(request[field as keyof typeof request]));
    }
  });

  it('still rejects a number that is not a whole, non-negative value', () => {
    for (const bad of [-1, 3.5, Number.NaN, Number.MAX_VALUE]) {
      const outcome = parseModelTurn(
        turnText([{ kind: 'toolRequest', tool: 'getChangeRequestDetails', memberId: 'm1', request: { number: bad } }]),
        { phase: 'investigating' },
      );
      expect(outcome.ok, `number ${String(bad)} must not parse`).toBe(false);
    }
  });

  /** The cursor is opaque and provenance-checked, so it keeps its strict string parse — coercion
   * is safe only for an identifier whose whole content is its digits. */
  it('does not extend the same leniency to a pagination cursor', () => {
    const outcome = parseModelTurn(
      turnText([{ kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'a.ts', cursor: 200 } }]),
      { phase: 'investigating' },
    );
    expect(outcome.ok).toBe(false);
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
        { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'a.ts' } },
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
        { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'a.ts' } },
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
    const messages = Array.from({ length: 3 }, (_, i) => ({ kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: `f${i}.ts` } }));
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
        { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'a.ts' } },
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

  it('offers the one envelope shape the prompt states, never a second one', () => {
    // The prompt's "Reply format" section says "Reply with exactly one JSON object" and shows
    // { "messages": [ ... ] }. The repair note used to answer that with a choice of two shapes,
    // which is the worst thing to hand a model that has just got the format wrong.
    const instruction = buildRepairInstruction('parse', [{ code: 'invalidEnvelope', message: 'The turn must be one JSON object with a "messages" array: { "messages": [ ... ] }.' }]);
    expect(instruction).toContain('{ "messages": [ ... ] }');
    expect(instruction).not.toContain('either');
    expect(instruction.length).toBeLessThanOrEqual(MAX_REPAIR_INSTRUCTION_LENGTH);
  });

  it('tells a turn that stopped mid-JSON that it was cut off, not that it was malformed', () => {
    const complete = turnText([{ kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'src/a.ts' } }]);
    const outcome = parseModelTurn(complete.slice(0, complete.length - 40), { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const instruction = buildRepairInstruction(outcome.failureKind, outcome.reasons);
      expect(instruction).toContain('stopped before its JSON closed');
      expect(instruction).not.toContain('could not be parsed');
    }
  });

  it('tells a turn that put prose before its JSON to start with the object, not that it was malformed', () => {
    // Replaces the multiple-turns opener, which went with the rule that produced that code. Same
    // principle as the two openers above it: this reply usually has nothing wrong with its JSON,
    // and "could not be parsed" would send the model looking for a syntax error it never made.
    // What it has to do is move the object to the front, so that is what the opener says.
    const twoToolRequests = [
      { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'src/a.ts' } },
      { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'src/b.ts' } },
    ];
    const example = turnText([{ kind: 'publicRationale', rationale: 'example only' }]);
    const outcome = parseModelTurn(`Shape: ${example}\nTurn: ${turnText(twoToolRequests)}`, { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const instruction = buildRepairInstruction(outcome.failureKind, outcome.reasons);
      expect(instruction).toContain('Begin the reply with the JSON object itself');
      expect(instruction).not.toContain('could not be parsed');
      expect(instruction).toContain('{ "messages": [ ... ] }');
      expect(instruction.length).toBeLessThanOrEqual(MAX_REPAIR_INSTRUCTION_LENGTH);
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

/**
 * Identifiers must be values the host can quote back byte-for-byte.
 *
 * The live failure: a run lost 24 tool calls to a pin refusal whose corrective half was identical
 * to the half quoting what the model had sent, so the message named no difference the model could
 * act on. `harnessToolDispatcher.ts` fixed that by naming the mismatched field and printing both
 * values — and an adversarial check then re-created the identical-looking message through a
 * different door: a snapshot pinned correctly except for a BEL appended to `repoId`. The
 * comparison saw a difference and refused, but the refusal is rendered through
 * `sanitizePublicText`, which deletes control characters, so what the model read was
 * "Use repoId osirison/code-verdict, ... This request sent repoId osirison/code-verdict." — both
 * halves identical again. A trailing space does the same by way of the sanitizer's trim.
 *
 * That specific door is bricked up from the other side now: a request carries no repository id and
 * no commit ids at all, so there is no pin comparison left to defeat (`Unpinned`,
 * `src/platform/types.ts`). The rule below is unchanged and still load-bearing for the identifiers
 * that remain — `memberId` above all, which the dispatcher quotes back verbatim in
 * "Member <id> is not part of this run.".
 *
 * The rule these pin: a field this protocol parses as an identifier — something the host looks up,
 * compares, or quotes back — must survive that sanitizer unchanged, so it carries no control
 * character and no leading or trailing whitespace. Free text is untouched: descriptions,
 * rationales, reasons and candidate titles are sanitized for display, which is what sanitizing is
 * for.
 *
 * Control characters are built with `String.fromCodePoint` rather than written as escapes, for the
 * reason `harnessProtocol.ts`'s own `shortEcho` gives: an escape sequence for a control character
 * has round-tripped through tooling as the raw byte, which makes git treat the file as binary.
 */
describe('identifier fields reject what the host could not echo back truthfully', () => {
  const UNPRINTABLE = 'contains a control character or leading/trailing whitespace.';
  const NEWLINE = String.fromCodePoint(0x0a);
  const CONTROL_CHARACTERS: ReadonlyArray<readonly [string, string]> = [
    ['NUL', String.fromCodePoint(0x00)],
    ['BEL', String.fromCodePoint(0x07)],
    ['newline', NEWLINE],
    ['ESC', String.fromCodePoint(0x1b)],
  ];
  const EDGE_WHITESPACE: ReadonlyArray<readonly [string, (value: string) => string]> = [
    ['a leading space', (value) => ` ${value}`],
    ['a trailing space', (value) => `${value} `],
    ['a trailing newline', (value) => `${value}${NEWLINE}`],
  ];

  const PLAN = createPlan([{ id: 'p1', description: 'Inspect authorization changes' }]) as Plan;

  /** Every field this protocol parses as an identifier, and the turn that carries a value in it. */
  const GUARDED: ReadonlyArray<{
    readonly path: string;
    readonly valid: string;
    readonly context: { readonly phase: 'planning' | 'investigating' | 'verifying'; readonly previousPlan?: Plan };
    readonly build: (value: string) => unknown;
  }> = [
    {
      path: 'toolRequest.memberId',
      valid: 'osirison/code-verdict!66',
      context: { phase: 'investigating' },
      build: (value) => ({ kind: 'toolRequest', tool: 'readDiff', memberId: value, request: { path: 'src/a.ts' } }),
    },
    {
      path: 'getChangeRequestDetails.request.number',
      valid: '66',
      context: { phase: 'investigating' },
      build: (value) => ({ kind: 'toolRequest', tool: 'getChangeRequestDetails', memberId: 'm1', request: { number: value } }),
    },
    {
      path: 'getIssueDetails.request.issueRepoId',
      valid: 'osirison/code-verdict',
      context: { phase: 'investigating' },
      build: (value) => ({ kind: 'toolRequest', tool: 'getIssueDetails', memberId: 'm1', request: { issueRepoId: value, issueNumber: '7' } }),
    },
    {
      path: 'getIssueDetails.request.issueNumber',
      valid: '7',
      context: { phase: 'investigating' },
      build: (value) => ({ kind: 'toolRequest', tool: 'getIssueDetails', memberId: 'm1', request: { issueRepoId: 'acme/core', issueNumber: value } }),
    },
    {
      path: 'planCreated.items[0].id',
      valid: 'inspect auth flow',
      context: { phase: 'planning' },
      build: (value) => ({ kind: 'planCreated', items: [{ id: value, description: 'Inspect authorization changes' }] }),
    },
    {
      path: 'planCreated.items[1].memberId',
      valid: 'acme/core!42',
      context: { phase: 'planning' },
      build: (value) => ({
        kind: 'planCreated',
        items: [
          { id: 'p1', description: 'Inspect authorization changes' },
          { id: 'p2', description: 'Inspect the schema migration', memberId: value },
        ],
      }),
    },
    {
      path: 'planRevised.items[0].id',
      valid: 'p1',
      context: { phase: 'investigating', previousPlan: PLAN },
      build: (value) => ({ kind: 'planRevised', items: [{ id: value, description: 'Inspect authorization changes' }], rationale: 'Narrowed the scope.' }),
    },
    {
      path: 'planItemStateChanged.itemId',
      valid: 'p1',
      context: { phase: 'investigating', previousPlan: PLAN },
      build: (value) => ({ kind: 'planItemStateChanged', itemId: value, state: 'active' }),
    },
    {
      path: 'publicRationale.itemId',
      valid: 'p1',
      context: { phase: 'investigating', previousPlan: PLAN },
      build: (value) => ({ kind: 'publicRationale', rationale: 'Reading the changed hunks.', itemId: value }),
    },
    {
      path: 'completionRequest.memberId',
      valid: 'acme/core!42',
      context: { phase: 'verifying' },
      build: (value) => ({ kind: 'completionRequest', memberId: value, rationale: 'Every plan item is complete.' }),
    },
  ];

  function parseOne(entry: (typeof GUARDED)[number], value: string): TurnParseOutcome {
    return parseModelTurn(turnText([entry.build(value)]), entry.context);
  }

  function messagesFor(entry: (typeof GUARDED)[number], value: string): string {
    return failReasons(parseOne(entry, value)).map((r) => r.message).join(' ');
  }

  for (const entry of GUARDED) {
    it(`${entry.path}: rejects every control character, naming the field and never echoing the value`, () => {
      for (const [label, character] of CONTROL_CHARACTERS) {
        const messages = messagesFor(entry, `${entry.valid}${character}`);
        expect(messages, `${entry.path} accepted ${label}, or failed without naming the field`).toContain(entry.path);
        expect(messages).toContain(UNPRINTABLE);
        // The raw value never reaches the reason: quoting it is how a control character would
        // travel to a sink. The reason describes the defect instead.
        expect(messages).not.toContain(character);
        expect(messages).not.toContain(entry.valid);
      }
    });

    it(`${entry.path}: rejects leading and trailing whitespace rather than trimming it`, () => {
      for (const [label, wrap] of EDGE_WHITESPACE) {
        const messages = messagesFor(entry, wrap(entry.valid));
        expect(messages, `${entry.path} accepted ${label}`).toContain(entry.path);
        expect(messages).toContain(UNPRINTABLE);
      }
    });

    it(`${entry.path}: still accepts its ordinary value`, () => {
      expect(parseOne(entry, entry.valid).ok, `${entry.path} rejected ${entry.valid}`).toBe(true);
    });
  }

  it('a rejection reason survives the sanitizer that erased the old one, unchanged', () => {
    // The property this whole change exists to establish. `sanitizePublicText` is what rendered
    // the dispatcher's refusal identical on both halves; a reason that is byte-identical before
    // and after it is a reason the model reads exactly as it was written.
    for (const entry of GUARDED) {
      for (const failure of failReasons(parseOne(entry, `${entry.valid}${String.fromCodePoint(0x07)}`))) {
        expect(sanitizePublicText(failure.message), `${entry.path}: the reason changes when sanitized`).toBe(failure.message);
      }
    }
  });

  it('accepts the identifier spellings this codebase actually uses', () => {
    // A repository id still reaches this parser, through the one field that still carries one:
    // `getIssueDetails.request.issueRepoId`, for a linked issue that may live in another repo.
    const repoIds = ['osirison/code-verdict', 'acme/re!po', 'acme/core.api', 'acme/core-api_v2', '9101'];
    for (const repoId of repoIds) {
      const outcome = parseModelTurn(
        turnText([{ kind: 'toolRequest', tool: 'getIssueDetails', memberId: 'm1', request: { issueRepoId: repoId, issueNumber: '7' } }]),
        { phase: 'investigating' },
      );
      expect(outcome.ok, `rejected issueRepoId ${repoId}`).toBe(true);
    }
    // A member id is the identifier a request always carries, and the forge mints it — this
    // product's own `repoId!number`, and the fixture provider's plainer ids.
    const memberIds = ['osirison/code-verdict!66', 'acme/core!42', 'repo-small-review!1', 'm1'];
    for (const memberId of memberIds) {
      const outcome = parseModelTurn(
        turnText([{ kind: 'toolRequest', tool: 'readDiff', memberId, request: { path: 'src/a.ts' } }]),
        { phase: 'investigating' },
      );
      expect(outcome.ok, `rejected memberId ${memberId}`).toBe(true);
    }
    // Commit ids used to be checked here too, with the fixture provider's symbolic revisions
    // ('small-base-1', 'legacy-head-1') as the reason no hex-of-fixed-length rule was imposed.
    // No request carries one any more, so there is nothing left to spell right or wrong.
  });

  it('leaves free text alone: punctuation, non-ASCII, and the newline a rationale may carry', () => {
    const emDashTitle = 'Token expiry — never checked';
    const candidate = parseModelTurn(
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
            title: emDashTitle,
            body: `The value flows straight through.${NEWLINE}Nothing narrows it.`,
            citations: { primary: { sourceId: 'src_1', digest: 'a'.repeat(64), path: 'src/auth/token.ts', range: { startLine: 10, endLine: 15 } } },
          },
        },
      ]),
      { phase: 'investigating' },
    );
    const [submitted] = okMessages(candidate);
    if (submitted?.kind !== 'candidateSubmission') throw new Error('expected candidateSubmission');
    // Verified against today's behaviour rather than assumed: `parseCandidateFinding` keeps a
    // title and body verbatim up to its own 4000-character bound, newline and em dash included.
    expect(submitted.candidate.title).toBe(emDashTitle);
    expect(submitted.candidate.body).toContain(NEWLINE);

    // A rationale keeps its punctuation; its newline is collapsed to a space by the sanitizer that
    // has always owned public text, which is the behaviour this change deliberately does not move.
    const rationale = parseModelTurn(
      turnText([{ kind: 'publicRationale', rationale: `Reading the diff — hunk by hunk.${NEWLINE}Then the policy chain.` }]),
      { phase: 'investigating' },
    );
    const [note] = okMessages(rationale);
    if (note?.kind !== 'publicRationale') throw new Error('expected publicRationale');
    expect(note.rationale).toBe('Reading the diff — hunk by hunk. Then the policy chain.');

    // A plan item description takes the same route.
    const plan = parseModelTurn(
      turnText([{ kind: 'planCreated', items: [{ id: 'p1', description: 'Confirm the “new” expiry path — including its fallback' }] }]),
      { phase: 'planning' },
    );
    const [created] = okMessages(plan);
    if (created?.kind !== 'planCreated') throw new Error('expected planCreated');
    expect(created.plan.items[0]?.description).toBe('Confirm the “new” expiry path — including its fallback');
  });

  it("refuses the verifier's payload at parse, instead of letting it reach the dispatcher", () => {
    // The payload that re-created the bug was a correct pin with a BEL appended to `repoId`: it
    // parsed cleanly, reached the dispatcher, failed the equality check, and produced a refusal
    // whose two halves rendered identically. No request carries a `repoId` any more, so the same
    // payload is built on the identifier that is always present and is quoted back the same way —
    // `memberId`, echoed verbatim in "Member <id> is not part of this run."
    const outcome = parseModelTurn(
      turnText([
        {
          kind: 'toolRequest',
          tool: 'readDiff',
          memberId: `osirison/code-verdict!66${String.fromCodePoint(0x07)}`,
          request: { path: 'package.json' },
        },
      ]),
      { phase: 'investigating' },
    );
    const [only] = failReasons(outcome);
    expect(only?.code).toBe('schema');
    expect(only?.message).toBe(`toolRequest.memberId ${UNPRINTABLE}`);
    // What the old refusal could not do: say something the sanitizer leaves intact, about one
    // named field, without quoting a value that cannot be printed.
    expect(sanitizePublicText(only?.message)).toBe(only?.message);
    expect(only?.message).not.toContain('osirison/code-verdict');

    // And the sentence reaches the model whole. `buildRepairInstruction` runs every reason through
    // the same sanitizer on the way out, which is the sink that erased the difference before.
    if (outcome.ok) throw new Error('expected a failure outcome');
    const instruction = buildRepairInstruction(outcome.failureKind, outcome.reasons);
    expect(instruction).toContain('schema: toolRequest.memberId contains a control character or leading/trailing whitespace');
    expect(instruction.length).toBeLessThanOrEqual(MAX_REPAIR_INSTRUCTION_LENGTH);
  });
});

/**
 * A request object with nothing required inside it has to be omittable.
 *
 * **The live failure, and the one before it.** A review spent 129 of its 457 tool calls on the
 * snapshot pin — a 40-character head sha the model had to copy into every single request and could
 * not copy reliably. That was fixed at the root: the pin left the model-facing request shape
 * altogether (`Unpinned`, `../platform/types`) and the host now adds it back from the member the
 * request already names.
 *
 * Removing it took the last *required* field out of `listChangedFiles.request` and nothing else was
 * touched, so the parser still demanded the object itself. The rendered shape became `{ "cursor"? }`
 * — every field inside it optional, the wrapper around them not — while the prompt's own Value
 * rules say an optional thing "may be omitted or sent as null". A model following the stated rules
 * sent `{"kind":"toolRequest","tool":"listChangedFiles","memberId":"m1"}` and was answered with
 * `listChangedFiles.request must be an object.`, a sentence that names no legal alternative and
 * never says "send an empty object".
 *
 * A turn is rejected whole, so that one message took the rest of the turn with it: two good
 * readDiff requests batched beside one bare listChangedFiles cost three reads and a repair attempt,
 * not one. The same turn-wasting refusal class, relocated rather than removed — which is why the
 * mixed-turn case below is a test and not a remark.
 *
 * **Where the rule lives.** In the spec table, not in the parser: `toolRequestObjectIsRequired`
 * derives "must the request object be present" from whether any of the tool's fields are required,
 * and the parser, the JSON schema and the prompt's shape line all read that one predicate. Per-tool
 * permissiveness in the parser would have fixed listChangedFiles and drifted the moment another
 * tool's last required field went away.
 */
describe('parseModelTurn: a request whose fields are all optional is itself optional', () => {
  /** Every spelling of "I am not supplying this", as `isAbsent` already defines it for a field. */
  const ABSENT_REQUEST: ReadonlyArray<{ readonly label: string; readonly message: Record<string, unknown> }> = [
    { label: 'omitted', message: { kind: 'toolRequest', tool: 'listChangedFiles', memberId: 'm1' } },
    { label: 'null', message: { kind: 'toolRequest', tool: 'listChangedFiles', memberId: 'm1', request: null } },
    { label: 'empty string', message: { kind: 'toolRequest', tool: 'listChangedFiles', memberId: 'm1', request: '' } },
    { label: 'empty object', message: { kind: 'toolRequest', tool: 'listChangedFiles', memberId: 'm1', request: {} } },
  ];

  it('parses listChangedFiles however the model spells an absent request, and to one identical call', () => {
    const calls = ABSENT_REQUEST.map(({ label, message }) => {
      const outcome = parseModelTurn(turnText([message]), { phase: 'investigating' });
      expect(outcome.ok, `request ${label} should parse: ${JSON.stringify(outcome)}`).toBe(true);
      const [only] = okMessages(outcome);
      expect(only?.kind).toBe('toolRequest');
      if (only?.kind !== 'toolRequest') throw new Error('expected a toolRequest message');
      return only.call;
    });
    // Not merely "all four parsed": all four have to reach the dispatcher as the same call, or the
    // spelling the model happened to pick would still change what the host does.
    for (const call of calls) expect(call).toEqual({ tool: 'listChangedFiles', memberId: 'm1', request: {} });
  });

  it('keeps every message when a bare listChangedFiles shares a turn with two readDiff requests', () => {
    const outcome = parseModelTurn(
      turnText([
        { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'src/a.ts' } },
        { kind: 'toolRequest', tool: 'listChangedFiles', memberId: 'm1' },
        { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { path: 'src/b.ts' } },
      ]),
      { phase: 'investigating' },
    );
    expect(outcome.ok, `the whole turn should survive: ${JSON.stringify(outcome)}`).toBe(true);
    expect(okMessages(outcome)).toHaveLength(3);
  });

  /** The permissiveness must not spread: a tool that genuinely requires a field still refuses, with the sentence it always used. */
  it('still refuses an absent request for every tool that requires a field', () => {
    for (const tool of ['readDiff', 'readFile', 'searchRepository', 'searchDiff', 'getChangeRequestDetails', 'getIssueDetails'] as const) {
      for (const request of [undefined, null, '']) {
        const message = request === undefined
          ? { kind: 'toolRequest', tool, memberId: 'm1' }
          : { kind: 'toolRequest', tool, memberId: 'm1', request };
        const outcome = parseModelTurn(turnText([message]), { phase: 'investigating' });
        expect(outcome.ok, `${tool} with request ${JSON.stringify(request)} must not parse`).toBe(false);
        expect(failReasons(outcome)[0]?.message).toBe(`${tool}.request must be an object.`);
      }
    }
  });

  /** `resolvePolicy` carries its field on the message, so there is no request object to make optional either way. */
  it('leaves resolvePolicy alone, whose argument is not inside a request at all', () => {
    const outcome = parseModelTurn(turnText([{ kind: 'toolRequest', tool: 'resolvePolicy', memberId: 'm1' }]), { phase: 'investigating' });
    expect(outcome.ok).toBe(false);
    expect(failReasons(outcome)[0]?.message).toBe('resolvePolicy.changedPath is required.');
  });

  /** A request that is present but is not an object is still a real mistake, and still says so. */
  it('still refuses a listChangedFiles request that is present and malformed', () => {
    for (const request of ['nope', 42, true, ['x']]) {
      const outcome = parseModelTurn(turnText([{ kind: 'toolRequest', tool: 'listChangedFiles', memberId: 'm1', request }]), { phase: 'investigating' });
      expect(outcome.ok, `request ${JSON.stringify(request)} must not parse`).toBe(false);
      expect(failReasons(outcome)[0]?.message).toBe('listChangedFiles.request must be an object.');
    }
  });
});
