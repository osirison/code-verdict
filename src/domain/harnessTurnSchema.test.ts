/**
 * Holds the schema to the parser, in the direction that matters.
 *
 * The schema exists so the prompt can state types, enums and bounds instead of bare field names,
 * and so a caller may pre-check a turn before parsing it. Both uses rest on one property: **the
 * schema must never reject a turn the parser would have accepted.** If it did, a pre-check would
 * invent a brand-new class of false rejection — the exact failure this whole exercise is about,
 * where a model following the instructions was refused anyway.
 *
 * The other direction is expected and safe: the schema accepts things the parser refuses, because
 * several parser checks depend on the lineage, the phase, or sibling fields. Those are enumerated
 * in `SCHEMA_CANNOT_EXPRESS` and asserted here to be the only kind of disagreement that occurs.
 *
 * `ajv` is a devDependency. Nothing at runtime consumes the schema as a schema: the parser is
 * still the runtime validator, and the bundle gains nothing.
 */
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HARNESS_POLICY, normalizeHarnessPolicy } from './harnessPolicy';
import { parseModelTurn } from './harnessProtocol';
import { buildHarnessTurnSchema, HARNESS_TURN_SCHEMA, SCHEMA_CANNOT_EXPRESS } from './harnessTurnSchema';

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(HARNESS_TURN_SCHEMA);

const SNAPSHOT = { repoId: 'acme/core', baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40) };
const MEMBER = 'acme/core!42';

function schemaAccepts(turn: unknown): boolean {
  return validate(turn) === true;
}

function parserAccepts(turn: unknown, phase: 'planning' | 'investigating' | 'verifying' = 'investigating'): boolean {
  return parseModelTurn(JSON.stringify(turn), { phase }).ok;
}

/**
 * Turns a competent model would plausibly send. Every one of these must be accepted by BOTH — a
 * schema that rejects any of them would be shipped into the prompt as a lie, and used as a
 * pre-check it would turn into a rejection the parser never asked for.
 */
const REALISTIC_TURNS: ReadonlyArray<{ readonly name: string; readonly turn: unknown; readonly phase?: 'planning' | 'investigating' | 'verifying' }> = [
  {
    name: 'a plan, as the first thing a review does',
    phase: 'planning',
    turn: { messages: [{ kind: 'planCreated', items: [{ id: 'inventory', description: 'Inventory the changed files.' }] }] },
  },
  {
    name: 'a bare array envelope rather than an object',
    turn: [{ kind: 'toolRequest', tool: 'listChangedFiles', memberId: MEMBER, request: { snapshot: SNAPSHOT } }],
  },
  {
    // Every field of `listChangedFiles.request` is optional, so the request object is too — and
    // both spellings of "not supplied" have to reach the schema as well as the parser, or a
    // pre-check would reject a turn the parser takes. See `harnessProtocol.test.ts`'s own block on
    // this for the refusal that made it necessary.
    name: 'an all-optional request left out entirely',
    turn: { messages: [{ kind: 'toolRequest', tool: 'listChangedFiles', memberId: MEMBER }] },
  },
  {
    name: 'an all-optional request sent as null, which is how JSON says "not supplied"',
    turn: { messages: [{ kind: 'toolRequest', tool: 'listChangedFiles', memberId: MEMBER, request: null }] },
  },
  {
    name: 'several reads batched into one turn',
    turn: {
      messages: [
        { kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER, request: { snapshot: SNAPSHOT, path: 'src/a.ts' } },
        { kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER, request: { snapshot: SNAPSHOT, path: 'src/b.ts' } },
      ],
    },
  },
  {
    name: 'a paginated read continuing with the cursor it was handed',
    turn: { messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER, request: { snapshot: SNAPSHOT, path: 'lock.json', cursor: '200' } }] },
  },
  {
    name: 'a change-request detail read, with the number as a number and a real section name',
    turn: { messages: [{ kind: 'toolRequest', tool: 'getChangeRequestDetails', memberId: MEMBER, request: { snapshot: SNAPSHOT, number: 42, section: 'checkSummaries' } }] },
  },
  {
    name: 'an optional field sent as null, which is how JSON says "not supplied"',
    turn: { messages: [{ kind: 'toolRequest', tool: 'searchDiff', memberId: MEMBER, request: { snapshot: SNAPSHOT, query: 'token', pathScope: null, cursor: null } }] },
  },
  {
    name: 'a file read using the old/new vocabulary this codebase uses for diff sides',
    turn: { messages: [{ kind: 'toolRequest', tool: 'readFile', memberId: MEMBER, request: { snapshot: SNAPSHOT, revision: 'new', path: 'src/a.ts', startLine: 1, endLine: 40 } }] },
  },
  {
    name: 'the policy tool, whose argument sits on the message rather than in a request',
    turn: { messages: [{ kind: 'toolRequest', tool: 'resolvePolicy', memberId: MEMBER, changedPath: 'src/a.ts' }] },
  },
  {
    name: 'a rationale on its own',
    turn: { messages: [{ kind: 'publicRationale', rationale: 'Investigation is complete.' }] },
  },
  {
    name: 'a request to finish',
    phase: 'verifying',
    turn: { messages: [{ kind: 'completionRequest', memberId: MEMBER, rationale: 'Coverage looks complete.' }] },
  },
  {
    name: 'a finding with a fully specified citation',
    turn: {
      messages: [
        {
          kind: 'candidateSubmission',
          candidate: {
            candidateId: 'cand-1',
            memberId: MEMBER,
            file: 'src/a.ts',
            line: 12,
            severity: 'major',
            category: 'security',
            confidence: 80,
            title: 'Unvalidated input reaches the query',
            body: 'The value flows straight through.',
            citations: { primary: { sourceId: 'ev_1', digest: 'd'.repeat(64), path: 'src/a.ts', range: { startLine: 12, endLine: 14 } } },
          },
        },
      ],
    },
  },
];

describe('the turn schema agrees with the parser', () => {
  for (const { name, turn, phase } of REALISTIC_TURNS) {
    it(`accepts ${name}, and so does the parser`, () => {
      expect(parserAccepts(turn, phase), `parser rejected: ${JSON.stringify(parseModelTurn(JSON.stringify(turn), { phase: phase ?? 'investigating' }))}`).toBe(true);
      expect(schemaAccepts(turn), `schema rejected: ${JSON.stringify(validate.errors)}`).toBe(true);
    });
  }

  /**
   * The property everything else rests on. Anything the parser takes, the schema must take — so a
   * pre-check can only ever be a cheap early "no" for turns already doomed, never a new "no" of
   * its own.
   */
  it('never rejects a turn the parser accepts', () => {
    const disagreements = REALISTIC_TURNS
      .filter(({ turn, phase }) => parserAccepts(turn, phase) && !schemaAccepts(turn))
      .map(({ name }) => name);
    expect(disagreements).toEqual([]);
  });

  it('rejects the shapes the parser rejects, so a pre-check is worth running at all', () => {
    const rejected = [
      { kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER, request: { snapshot: SNAPSHOT } }, // no path
      { kind: 'toolRequest', tool: 'getChangeRequestDetails', memberId: MEMBER, request: { snapshot: SNAPSHOT, number: 42, section: 'title' } }, // the section name the prompt used to teach
      { kind: 'planItemStateChanged', itemId: 'p1', state: 'done' }, // not a plan-item state
      { kind: 'notAKind', rationale: 'x' },
    ];
    for (const message of rejected) {
      expect(schemaAccepts({ messages: [message] }), `schema should reject ${JSON.stringify(message)}`).toBe(false);
      expect(parserAccepts({ messages: [message] })).toBe(false);
    }
  });

  it('enforces the batch caps the parser enforces', () => {
    const read = { kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER, request: { snapshot: SNAPSHOT, path: 'a.ts' } };
    const overCap = { messages: Array.from({ length: DEFAULT_HARNESS_POLICY.maxToolRequestsPerTurn + 1 }, () => read) };
    expect(schemaAccepts(overCap)).toBe(false);
    expect(parserAccepts(overCap)).toBe(false);
    const atCap = { messages: Array.from({ length: DEFAULT_HARNESS_POLICY.maxToolRequestsPerTurn }, () => read) };
    expect(schemaAccepts(atCap)).toBe(true);
    expect(parserAccepts(atCap)).toBe(true);
  });

  it('takes its per-turn tool cap from the policy rather than freezing it', () => {
    const loosened = normalizeHarnessPolicy({ maxToolRequestsPerTurn: 2 });
    // A fresh instance: the schema carries a stable `$id`, and ajv refuses to register two
    // documents under one id in the same instance.
    const validateLoose = new Ajv2020({ allErrors: true, strict: false }).compile(buildHarnessTurnSchema(loosened));
    const read = { kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER, request: { snapshot: SNAPSHOT, path: 'a.ts' } };
    expect(validateLoose({ messages: [read, read] })).toBe(true);
    expect(validateLoose({ messages: [read, read, read] })).toBe(false);
  });

  it('is a valid draft 2020-12 document that compiles without warnings', () => {
    expect(() => new Ajv2020({ strict: true, allErrors: true }).compile(HARNESS_TURN_SCHEMA)).not.toThrow();
  });

  it('documents the checks it cannot express, so the gap is recorded rather than discovered', () => {
    expect(SCHEMA_CANNOT_EXPRESS.length).toBeGreaterThan(0);
    for (const note of SCHEMA_CANNOT_EXPRESS) expect(note.length).toBeGreaterThan(20);
  });
});
