/**
 * Holds the three model-facing descriptions of a tool request to one definition.
 *
 * The prompt, the parser and the schema each used to describe the same eight request shapes in
 * their own hand-written words. They drifted, and the drift was invisible until a live review paid
 * for it: the prompt said a change-request detail section could be `"title"` or `"check
 * summaries"`, neither of which the parser has ever accepted, and the rejection named no legal
 * value — so a model following our own instructions exactly was refused and could not learn why.
 *
 * All three now derive from `TOOL_REQUEST_SPECS`. These tests exist so that stays true: they fail
 * if anyone reintroduces a hand-written shape, and they fail if the prompt ever names a value the
 * parser would reject. That second one is the whole point — it is the assertion the old code could
 * not have made, because there was nothing to compare the prompt against.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_HARNESS_POLICY, normalizeHarnessPolicy } from '../domain/harnessPolicy';
import { DETAIL_SECTION_MEMBERS, parseModelTurn, TOOL_REQUEST_SPECS, toolFieldIsOptional, toolRequestObjectIsRequired, type ToolRequestName } from '../domain/harnessProtocol';
import { HOST_TOOL_DEFINITIONS } from '../domain/harnessTools';
import { renderProtocolContract } from './harnessModelSeam';

const SNAPSHOT = { repoId: 'acme/core', baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40) };
const MEMBER = 'acme/core!42';
const TOOLS = Object.keys(TOOL_REQUEST_SPECS) as ToolRequestName[];

function contract(policy = DEFAULT_HARNESS_POLICY): string {
  return renderProtocolContract(HOST_TOOL_DEFINITIONS.map((tool) => ({ name: tool.name, requiredScope: tool.requiredScope, description: tool.description })), policy);
}

/** A turn carrying `count` well-formed readDiff requests and nothing else. */
function toolRequestTurn(count: number): string {
  return JSON.stringify({
    messages: Array.from({ length: count }, (_unused, index) => ({
      kind: 'toolRequest',
      tool: 'readDiff',
      memberId: MEMBER,
      request: { snapshot: SNAPSHOT, path: `src/file${index}.ts` },
    })),
  });
}

describe('the prompt describes exactly what the parser accepts', () => {
  const text = contract();

  it('names every request tool', () => {
    for (const tool of TOOLS) expect(text, `${tool} missing from the contract`).toContain(`- ${tool}: `);
  });

  it('names every field of every tool, and marks optional ones optional', () => {
    for (const tool of TOOLS) {
      const line = text.split('\n').find((l) => l.startsWith(`- ${tool}: `));
      expect(line, `${tool} has no shape line`).toBeDefined();
      for (const field of TOOL_REQUEST_SPECS[tool].fields) {
        expect(line, `${tool}.${field.name} missing`).toContain(`"${field.name}"`);
        if (toolFieldIsOptional(field.kind)) {
          expect(line, `${tool}.${field.name} not marked optional`).toContain(`"${field.name}"?`);
        }
      }
    }
  });

  /**
   * The regression that started all this. Every enum value the prompt prints must be one the
   * parser takes — asserted by feeding each printed value through the real parser, not by
   * comparing two lists that could both be wrong.
   */
  it('prints only section names the parser accepts', () => {
    // Scoped to the two shape lines that actually take a section — `"title"` is also a candidate
    // field name elsewhere in the contract, and that one is legitimate.
    const sectionLines = text.split('\n').filter((line) => line.startsWith('- getChangeRequestDetails: ') || line.startsWith('- getIssueDetails: '));
    expect(sectionLines, 'the section-taking shape lines are missing').toHaveLength(2);
    const printed = sectionLines.flatMap((line) => [...line.matchAll(/"([a-zA-Z ]+)"/g)].map((m) => m[1]!));
    expect(printed.length, 'no section names found in the contract').toBeGreaterThan(0);
    const fieldNames = new Set(['snapshot', 'number', 'section', 'cursor', 'issueRepoId', 'issueNumber']);
    for (const section of new Set(printed.filter((value) => !fieldNames.has(value)))) {
      const turn = JSON.stringify({
        messages: [{ kind: 'toolRequest', tool: 'getChangeRequestDetails', memberId: MEMBER, request: { snapshot: SNAPSHOT, number: '42', section } }],
      });
      expect(parseModelTurn(turn, { phase: 'investigating' }).ok, `the prompt prints section "${section}" but the parser rejects it`).toBe(true);
    }
    // And specifically the two that were wrong for months.
    for (const line of sectionLines) {
      expect(line).not.toContain('"title"');
      expect(line).not.toContain('check summaries');
    }
  });

  it('prints every section the parser accepts, so none is undiscoverable', () => {
    for (const section of DETAIL_SECTION_MEMBERS) expect(text, `section "${section}" is never named`).toContain(`"${section}"`);
  });

  /** A shape the prompt prints must round-trip: build the request from it and the parser takes it. */
  it('describes shapes that actually parse', () => {
    const sample: Record<string, unknown> = {
      snapshot: SNAPSHOT,
      path: 'src/a.ts',
      query: 'token',
      changedPath: 'src/a.ts',
      revision: 'head',
      startLine: 1,
      endLine: 10,
      number: '42',
      issueRepoId: 'acme/core',
      issueNumber: '7',
    };
    for (const tool of TOOLS) {
      const spec = TOOL_REQUEST_SPECS[tool];
      const fields: Record<string, unknown> = {};
      for (const field of spec.fields) {
        if (toolFieldIsOptional(field.kind)) continue; // omitted on purpose: the prompt says they may be
        fields[field.name] = sample[field.name];
      }
      const message = spec.location === 'request'
        ? { kind: 'toolRequest', tool, memberId: MEMBER, request: fields }
        : { kind: 'toolRequest', tool, memberId: MEMBER, ...fields };
      const outcome = parseModelTurn(JSON.stringify({ messages: [message] }), { phase: 'investigating' });
      expect(outcome.ok, `${tool}: the prompt's own required fields do not parse — ${JSON.stringify(outcome)}`).toBe(true);
    }
  });

  /**
   * `listChangedFiles` is the only tool today whose request has no required field, and it became
   * one by accident: the snapshot pin was the only thing making the object reliably present, so
   * removing it (`Unpinned`, `../platform/types`) left a shape line reading `{ "cursor"? }` — every
   * field inside optional — above a parser that still demanded the object itself. A model reading
   * the Value rules ("may be omitted or sent as null") sent no request and lost the whole turn.
   *
   * So the prompt has to say which of the two a tool is, and say it from the same table the parser
   * is driven by. Asserted against the parser rather than against a second list, which is the
   * pattern the section-name test above already sets and for the same reason: two hand-written
   * lists can both be wrong.
   */
  it('says whether the whole "request" may be left out, and the parser agrees either way', () => {
    for (const tool of TOOLS) {
      const spec = TOOL_REQUEST_SPECS[tool];
      if (spec.location !== 'request') continue; // resolvePolicy has no request object to make optional
      const line = text.split('\n').find((l) => l.startsWith(`- ${tool}: `));
      expect(line, `${tool} has no shape line`).toBeDefined();
      const bare = JSON.stringify({ messages: [{ kind: 'toolRequest', tool, memberId: MEMBER }] });
      const parses = parseModelTurn(bare, { phase: 'investigating' }).ok;
      expect(parses, `${tool}: the parser and the spec table disagree about whether "request" is required`).toBe(!toolRequestObjectIsRequired(spec));
      if (parses) {
        expect(line, `${tool} requires nothing, but its shape line never says "request" may be left out`).toContain('"request" may be omitted or sent as null');
      } else {
        expect(line, `${tool} requires a field, but its shape line invites omitting "request"`).not.toContain('"request" may be omitted');
      }
    }
  });

  /**
   * The rule that cost the most before it was written down. A live review of a 26-file change
   * spent 7 of its 36 model calls on `tooManyToolRequests` — the model batched 10, 13, 13, 14,
   * 15, 16 and finally all 26 reads into single turns, and every one of those turns was thrown
   * away whole. The cap was enforced by the parser and stated nowhere the model could read it
   * before offending: it appeared only in the rejection, and the next turn's prompt is rebuilt
   * without that repair text.
   */
  it('states the per-turn tool cap, and states the one the parser actually enforces', () => {
    const cap = DEFAULT_HARNESS_POLICY.maxToolRequestsPerTurn;
    expect(text, 'the contract never names the per-turn tool cap').toContain(`Up to ${cap} toolRequest messages may share a turn`);
    // Prose and behaviour, checked against each other rather than separately.
    expect(parseModelTurn(toolRequestTurn(cap), { phase: 'investigating' }).ok, `the contract permits ${cap} but the parser refuses it`).toBe(true);
    expect(parseModelTurn(toolRequestTurn(cap + 1), { phase: 'investigating' }).ok, `the contract caps at ${cap} but the parser allows more`).toBe(false);
  });

  it('takes the cap from the policy rather than printing a literal', () => {
    const loosened = contract(normalizeHarnessPolicy({ maxToolRequestsPerTurn: 3 }));
    expect(loosened).toContain('Up to 3 toolRequest messages may share a turn');
    expect(loosened, 'the default cap is still printed under a policy that does not use it').not.toContain(`Up to ${DEFAULT_HARNESS_POLICY.maxToolRequestsPerTurn} toolRequest messages`);
  });

  it('tells the model what to do when more files remain than one turn allows', () => {
    // Without this the model has a cap and no strategy, which is how a refusal becomes a loop.
    expect(text).toContain('continue in the next turn');
    expect(text).toContain('rejected whole');
  });

  it('states the value rules that the shapes alone cannot carry', () => {
    for (const rule of ['may be omitted or sent as null', 'string or a whole number', 'opaque', 'whole percentage']) {
      expect(text, `the value rules no longer mention: ${rule}`).toContain(rule);
    }
  });

  /**
   * Findings used to arrive without the offending code or a proposed fix, and the ones that did
   * carry a suggestion showed why the fix matters as a self-test: one suggestion was
   * byte-identical to the code it replaced, another named an identifier that does not exist —
   * neither could have been written by a reviewer looking at the actual evidence. The contract
   * now asks for the quote and the local fix, while the shape keeps both fields optional: a
   * missing-error-handling finding has no offending line to quote, and `codeNotInEvidence`
   * (`harnessCandidateValidation.ts`) already rejects a non-verbatim quote, so this is a nudge,
   * never a second hard requirement.
   */
  it('asks for the offending code and a local fix, while keeping both fields optional', () => {
    const flat = text.replace(/\n/g, ' '); // the ask wraps across prompt lines; assert it whole
    expect(flat).toContain('Quote the offending lines in "code" when they exist');
    expect(flat).toContain('give "suggestion"');
    expect(flat).toContain('a suggestion identical to the old code');
    // Optional in the candidate shape, exactly as before — the ask must not read as mandatory.
    expect(text).toContain('"code"?');
    expect(text).toContain('"suggestion"?');
  });
});
