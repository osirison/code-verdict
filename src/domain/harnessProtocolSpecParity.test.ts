/**
 * Proves the spec table did not change a single answer.
 *
 * Eight tool request shapes used to be hand-written three times over — once in the parser, once in
 * the schema, once in the prompt — and they drifted. The prompt ended up telling the model a detail
 * section could be `"title"`, a value the parser had never accepted, with a rejection that named no
 * legal alternative. One definition now drives all three.
 *
 * Replacing eight hand-written parsers with one table-driven parser is exactly the kind of change
 * that silently moves an edge nobody was looking at. So this does not spot-check: it generates,
 * for every tool and every field, the mutations a model actually produces — omitted, null, empty
 * string, wrong scalar type, over-length, a number where a string was expected, and an identifier
 * carrying a control character or stray whitespace — and asserts the two implementations agree on
 * **all three** things a caller can observe: whether it parsed, the parsed call itself, and the
 * exact failure text.
 *
 * The failure text matters as much as the verdict. It is what a model reads to correct itself, the
 * audit's findings are keyed to those strings, and the prompt now quotes several of them.
 */
import { describe, expect, it } from 'vitest';
import {
  parseToolCallLegacy,
  parseToolCallFromSpecForParity,
  TOOL_REQUEST_SPECS,
  type ToolRequestName,
} from './harnessProtocol';

const MEMBER = 'acme/core!42';
const SNAPSHOT = { repoId: 'acme/core', baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40) };

/** A well-formed value for each field, so a corpus entry can be valid apart from the one mutation. */
const VALID: Readonly<Record<string, unknown>> = {
  snapshot: SNAPSHOT,
  path: 'src/a.ts',
  cursor: '200',
  revision: 'head',
  startLine: 1,
  endLine: 40,
  query: 'token',
  pathScope: 'src',
  changedPath: 'src/a.ts',
  number: '42',
  issueRepoId: 'acme/core',
  issueNumber: '7',
  section: 'commits',
};

/**
 * Built with `String.fromCodePoint` rather than written as an escape, for the reason
 * `harnessProtocol.ts`'s `shortEcho` records: the escape sequence has round-tripped through tooling
 * as the raw byte, which makes git treat the file as binary.
 */
const BEL = String.fromCodePoint(0x07);
const NEWLINE = String.fromCodePoint(0x0a);

/**
 * Puts `before` and `after` around a field's value. A snapshot's value is an object, so they
 * land on one of its three identifier fields; every other field takes them directly, which makes
 * the three snapshot variants below the same case repeated for a scalar field — cheap, and it
 * keeps one mutation list rather than a per-kind one.
 */
function wrap(value: unknown, before: string, after: string, subfield: 'repoId' | 'baseSha' | 'headSha'): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return { ...record, [subfield]: `${before}${String(record[subfield])}${after}` };
  }
  return `${before}${String(value)}${after}`;
}

/** Every way a model gets a field wrong, plus the ways it legitimately omits one. */
const MUTATIONS: ReadonlyArray<{ readonly label: string; readonly apply: (source: Record<string, unknown>, field: string) => void }> = [
  { label: 'omitted', apply: (s, f) => { delete s[f]; } },
  { label: 'null', apply: (s, f) => { s[f] = null; } },
  { label: 'empty string', apply: (s, f) => { s[f] = ''; } },
  { label: 'number', apply: (s, f) => { s[f] = 388; } },
  { label: 'boolean', apply: (s, f) => { s[f] = true; } },
  { label: 'array', apply: (s, f) => { s[f] = ['x']; } },
  { label: 'object', apply: (s, f) => { s[f] = { nested: 1 }; } },
  { label: 'over-length', apply: (s, f) => { s[f] = 'x'.repeat(4001); } },
  { label: 'zero', apply: (s, f) => { s[f] = 0; } },
  { label: 'negative', apply: (s, f) => { s[f] = -5; } },
  { label: 'fractional', apply: (s, f) => { s[f] = 2.5; } },
  { label: 'wrong enum member', apply: (s, f) => { s[f] = 'title'; } },
  { label: 'uppercase', apply: (s, f) => { s[f] = 'HEAD'; } },
  { label: 'control character', apply: (s, f) => { s[f] = wrap(s[f], '', BEL, 'repoId'); } },
  { label: 'control character in baseSha', apply: (s, f) => { s[f] = wrap(s[f], '', BEL, 'baseSha'); } },
  { label: 'control character in headSha', apply: (s, f) => { s[f] = wrap(s[f], '', BEL, 'headSha'); } },
  { label: 'leading space', apply: (s, f) => { s[f] = wrap(s[f], ' ', '', 'repoId'); } },
  { label: 'trailing space', apply: (s, f) => { s[f] = wrap(s[f], '', ' ', 'repoId'); } },
  { label: 'trailing newline', apply: (s, f) => { s[f] = wrap(s[f], '', NEWLINE, 'headSha'); } },
];

/** Whole-request mutations, applied once per tool rather than per field. */
const REQUEST_MUTATIONS: ReadonlyArray<{ readonly label: string; readonly build: (tool: ToolRequestName) => Record<string, unknown> }> = [
  { label: 'request absent', build: () => ({}) },
  { label: 'request is a string', build: () => ({ request: 'nope' }) },
  { label: 'request is an array', build: () => ({ request: [] }) },
  { label: 'request is null', build: () => ({ request: null }) },
  { label: 'request empty object', build: () => ({ request: {} }) },
  // `''` is the third spelling of "not supplied" (`isAbsent`), and the one a model reaches for when
  // told to omit something it has already written the key for.
  { label: 'request is an empty string', build: () => ({ request: '' }) },
];

function validMessage(tool: ToolRequestName): Record<string, unknown> {
  const spec = TOOL_REQUEST_SPECS[tool];
  const fields: Record<string, unknown> = {};
  for (const field of spec.fields) fields[field.name] = VALID[field.name];
  return spec.location === 'request' ? { tool, memberId: MEMBER, request: fields } : { tool, memberId: MEMBER, ...fields };
}

function compare(tool: ToolRequestName, message: Record<string, unknown>, label: string): void {
  const legacy = parseToolCallLegacy(tool, MEMBER, message);
  const spec = parseToolCallFromSpecForParity(tool, MEMBER, message);
  expect(spec.ok, `${tool} / ${label}: verdict differs (legacy ok=${legacy.ok})`).toBe(legacy.ok);
  if (legacy.ok && spec.ok) {
    expect(spec.call, `${tool} / ${label}: parsed call differs`).toEqual(legacy.call);
  } else if (!legacy.ok && !spec.ok) {
    expect(spec.reasons, `${tool} / ${label}: failure text differs`).toEqual(legacy.reasons);
  }
}

const TOOLS = Object.keys(TOOL_REQUEST_SPECS) as ToolRequestName[];

describe('the spec table parses exactly as the hand-written parsers did', () => {
  it('covers every tool the protocol can request', () => {
    expect(TOOLS).toHaveLength(8);
  });

  for (const tool of TOOLS) {
    it(`${tool}: a well-formed request`, () => {
      compare(tool, validMessage(tool), 'valid');
    });

    it(`${tool}: every field against every mutation`, () => {
      const spec = TOOL_REQUEST_SPECS[tool];
      let cases = 0;
      for (const field of spec.fields) {
        for (const mutation of MUTATIONS) {
          const message = JSON.parse(JSON.stringify(validMessage(tool))) as Record<string, unknown>;
          const source = spec.location === 'request' ? (message.request as Record<string, unknown>) : message;
          mutation.apply(source, field.name);
          compare(tool, message, `${field.name} = ${mutation.label}`);
          cases += 1;
        }
      }
      expect(cases, `${tool} generated no cases`).toBeGreaterThan(0);
    });

    it(`${tool}: malformed request envelopes`, () => {
      for (const mutation of REQUEST_MUTATIONS) {
        compare(tool, { tool, memberId: MEMBER, ...mutation.build(tool) }, mutation.label);
      }
    });
  }

  it('agrees on every pairwise combination of two broken fields', () => {
    for (const tool of TOOLS) {
      const spec = TOOL_REQUEST_SPECS[tool];
      for (const first of spec.fields) {
        for (const second of spec.fields) {
          if (first.name === second.name) continue;
          const message = JSON.parse(JSON.stringify(validMessage(tool))) as Record<string, unknown>;
          const source = spec.location === 'request' ? (message.request as Record<string, unknown>) : message;
          delete source[first.name];
          source[second.name] = 12.5;
          // Which of two complaints a model receives is part of the contract: it decides what the
          // model fixes first, and the repair budget is two attempts.
          compare(tool, message, `${first.name} omitted + ${second.name} fractional`);
        }
      }
    }
  });
});
