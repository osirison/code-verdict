/**
 * A JSON Schema (draft 2020-12) for one model turn, built from the same constants the parser uses.
 *
 * Three model-facing texts describe how a reply must be shaped: the prompt's reply-format section,
 * the parser, and the repair note. They drifted. The prompt told the model that a change-request
 * detail section could be `"title"` or `"check summaries"`, neither of which exists — following
 * the prompt exactly guaranteed a rejection, and the rejection named no legal value, so the model
 * could not learn the real one and spent the phase's whole repair budget guessing. The repair note
 * separately advertised a plan-item shape the prompt never showed.
 *
 * This module exists so there is one place those facts live. Every enum below is the array the
 * parser itself tests against, not a copy of it: change `PLAN_ITEM_STATES` or `DETAIL_SECTIONS` or
 * the tool catalog and this schema changes with them, in the same commit, or the build fails. The
 * per-turn tool-request cap is read from the live policy rather than frozen.
 *
 * **What it is for.** Two things, neither of which is replacing the parser:
 *
 * 1. Rendering the reply contract into the prompt (`harnessModelSeam.ts`) as types, enums and
 *    bounds instead of field-name sketches with the values left out. That is the half a model
 *    reads reliably, and its omission is what left `cursor`, `number`, `confidence` and every
 *    length bound untyped.
 * 2. Validating candidate turns in tests, and — should a caller want it — before the parser runs.
 *
 * **The safety direction, which is asserted in `harnessTurnSchema.test.ts`, not assumed.** Every
 * divergence between this schema and the parser is schema-accepts / parser-rejects, never the
 * reverse. A schema-based pre-check therefore cannot reject a turn the parser would have taken; at
 * worst it lets one through that the parser then refuses, exactly as today. The checks it cannot
 * express are listed in `SCHEMA_CANNOT_EXPRESS` below, so the gap is documented rather than
 * discovered.
 */
import { MAX_PUBLIC_TEXT_LENGTH } from '../app/harnessActivitySanitizer';
import { SEVERITY_ORDER } from './criteria';
import { ALL_CATEGORIES } from './types';
import { PLAN_ITEM_STATES } from './harnessActivity';
import { DEFAULT_HARNESS_POLICY, type HarnessPolicy } from './harnessPolicy';
import {
  DETAIL_SECTION_MEMBERS,
  MAX_ID_LENGTH,
  MAX_PROTOCOL_MESSAGES_PER_TURN,
  MAX_PROTOCOL_STRING_LENGTH,
  PROTOCOL_MESSAGE_KINDS,
  PROTOCOL_VERSION,
  TOOL_REQUEST_SPECS,
  toolFieldIsOptional,
  toolRequestObjectIsRequired,
  type ToolFieldKind,
  type ToolRequestName,
} from './harnessProtocol';

/** A JSON Schema document. Deliberately loose — this module builds one, it does not consume one. */
export type JsonSchema = Record<string, unknown>;

/**
 * Parser checks no JSON Schema can carry. Each one is a case where the schema accepts and the
 * parser may still refuse, which is the safe direction; none is a case where the schema refuses
 * something the parser would take.
 */
export const SCHEMA_CANNOT_EXPRESS: readonly string[] = Object.freeze([
  'Phase legality: which message kinds are permitted depends on the host-supplied current phase, not on the reply.',
  'Plan state: planCreated requires no prior plan and planRevised requires one; both depend on the lineage, not the reply.',
  'planRevised must retain every prior plan item id, and planItemStateChanged must name an item in the effective plan.',
  'Sibling comparisons: endLine must not precede startLine, and a citation range must not end before it begins.',
  'Plan item ids must be unique within a plan; JSON Schema compares whole items, not one property.',
  'The 6-level nesting cap applies to unknown fields too, which a schema leaves unconstrained by design.',
  'The 65536-byte cap is measured on the raw reply text, before the JSON value this schema describes exists.',
  'String bounds are counted in UTF-16 code units by the parser and in code points by maxLength; they differ for astral characters.',
  'Identifier fields (memberId, issueRepoId, the two numbers, plan item ids) reject control characters and leading/trailing whitespace; type and maxLength express neither.',
]);

const s = (maxLength: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength });

/**
 * An optional string field. `null` and `""` are accepted and mean "not supplied" — the parser
 * treats them that way because JSON has no `undefined` and a model asked to omit a value writes
 * one or the other. Required fields do not get this.
 */
const optional = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }, { const: '' }] });

/** An identifier the parser accepts as a string or as a whole non-negative number. */
const identifier = (maxLength: number): JsonSchema => ({
  anyOf: [s(maxLength), { type: 'integer', minimum: 0 }],
});

/** One field kind's JSON Schema, so the schema says exactly what `readToolField` accepts. */
function fieldSchema(kind: ToolFieldKind): JsonSchema {
  switch (kind) {
    case 'requiredString':
    case 'optionalString':
    case 'cursor':
      return s(MAX_PROTOCOL_STRING_LENGTH);
    case 'requiredShortString':
      return s(MAX_ID_LENGTH);
    case 'requiredIdentifier':
      return identifier(MAX_ID_LENGTH);
    case 'pinnedRevision':
      return { $ref: '#/$defs/pinnedRevision' };
    case 'detailSection':
      return { enum: [...DETAIL_SECTION_MEMBERS] };
    case 'positiveInt':
      return { type: 'integer', minimum: 1 };
  }
}

function kindIs(kind: string): JsonSchema {
  return { type: 'object', required: ['kind'], properties: { kind: { const: kind } } };
}

/**
 * Builds the schema. `policy` supplies the only bound that is configurable rather than constant —
 * the per-turn tool-request cap — so a non-default policy produces a schema that matches it.
 */
export function buildHarnessTurnSchema(policy: HarnessPolicy = DEFAULT_HARNESS_POLICY): JsonSchema {
  const lineRange: JsonSchema = {
    type: 'object',
    required: ['startLine', 'endLine'],
    properties: { startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } },
  };

  const evidenceRef: JsonSchema = {
    type: 'object',
    required: ['sourceId', 'digest', 'path', 'range'],
    properties: {
      sourceId: s(MAX_ID_LENGTH),
      digest: s(MAX_ID_LENGTH),
      path: s(MAX_PROTOCOL_STRING_LENGTH),
      range: lineRange,
    },
  };

  const planItem: JsonSchema = {
    type: 'object',
    required: ['id', 'description'],
    properties: {
      id: identifier(MAX_ID_LENGTH),
      description: s(MAX_PROTOCOL_STRING_LENGTH),
      state: optional({ enum: [...PLAN_ITEM_STATES] }),
      memberId: optional(s(MAX_ID_LENGTH)),
    },
  };

  // Derived from `TOOL_REQUEST_SPECS`, the same table the parser is driven by, so a tool's shape
  // cannot be right in one and wrong in the other. This section used to be hand-written alongside
  // the parser's own hand-written version of the same eight shapes.
  const toolRequest: JsonSchema = {
    type: 'object',
    required: ['kind', 'tool', 'memberId'],
    properties: { kind: { const: 'toolRequest' }, memberId: s(MAX_ID_LENGTH) },
    oneOf: (Object.keys(TOOL_REQUEST_SPECS) as ToolRequestName[]).map((tool) => {
      const spec = TOOL_REQUEST_SPECS[tool];
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const field of spec.fields) {
        const base = fieldSchema(field.kind);
        properties[field.name] = toolFieldIsOptional(field.kind) ? optional(base) : base;
        if (!toolFieldIsOptional(field.kind)) required.push(field.name);
      }
      if (spec.location !== 'request') return { required, properties: { tool: { const: tool }, ...properties } };
      // `request` is required exactly when something inside it is (`toolRequestObjectIsRequired`),
      // and when it is not, `optional` is the same three-spelling "not supplied" the parser applies
      // to it — object, `null` or `""`, or the key absent altogether. Leaving `required: ['request']`
      // on an all-optional tool would make this schema reject a turn the parser now accepts, which
      // is the one direction the file header rules out.
      const requestObject: JsonSchema = { type: 'object', required, properties };
      return toolRequestObjectIsRequired(spec)
        ? { required: ['request'], properties: { tool: { const: tool }, request: requestObject } }
        : { properties: { tool: { const: tool }, request: optional(requestObject) } };
    }),
  };

  const candidate: JsonSchema = {
    type: 'object',
    required: ['candidateId', 'memberId', 'file', 'severity', 'category', 'confidence', 'title', 'body', 'citations'],
    properties: {
      candidateId: s(MAX_ID_LENGTH),
      memberId: s(MAX_ID_LENGTH),
      file: s(MAX_PROTOCOL_STRING_LENGTH),
      line: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
      severity: { enum: [...SEVERITY_ORDER] },
      category: { enum: [...ALL_CATEGORIES] },
      // A whole percentage. `0.85` validates as a number here and the parser accepts it too, then
      // the criteria floor silently drops the finding — see SCHEMA_CANNOT_EXPRESS's neighbours and
      // the report on unreconciled confidence scales.
      confidence: { type: 'number', minimum: 0, maximum: 100 },
      title: s(MAX_PROTOCOL_STRING_LENGTH),
      body: { type: 'string' },
      code: { type: 'string' },
      rule: { type: 'string' },
      reference: { type: 'string' },
      suggestion: optional({ type: 'object', required: ['old', 'new'], properties: { old: { type: 'string' }, new: { type: 'string' } } }),
      citations: {
        type: 'object',
        required: ['primary'],
        properties: { primary: evidenceRef, supporting: { type: 'array', items: evidenceRef } },
      },
    },
  };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://code-verdict.local/schemas/harness-protocol-turn-v${PROTOCOL_VERSION}.json`,
    title: `Harness protocol model turn (protocol version ${PROTOCOL_VERSION})`,
    description:
      'One model turn, as the harness parser accepts it. Describes the JSON value, not the raw reply text. Unknown properties are ignored, exactly as the parser ignores them.',
    oneOf: [
      { $ref: '#/$defs/messageBatch' },
      { type: 'object', required: ['messages'], properties: { messages: { $ref: '#/$defs/messageBatch' } } },
    ],
    $defs: {
      messageBatch: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PROTOCOL_MESSAGES_PER_TURN,
        items: { $ref: '#/$defs/message' },
        allOf: [
          { contains: kindIs('publicRationale'), minContains: 0, maxContains: 1 },
          { contains: kindIs('checkpointSuggestion'), minContains: 0, maxContains: 1 },
          { contains: kindIs('completionRequest'), minContains: 0, maxContains: 1 },
          { contains: kindIs('toolRequest'), minContains: 0, maxContains: policy.maxToolRequestsPerTurn },
          {
            contains: { type: 'object', required: ['kind'], properties: { kind: { enum: ['planCreated', 'planRevised'] } } },
            minContains: 0,
            maxContains: 1,
          },
          {
            if: { contains: kindIs('completionRequest') },
            then: {
              allOf: [
                { not: { contains: kindIs('toolRequest') } },
                { not: { contains: kindIs('candidateSubmission') } },
                { not: { contains: kindIs('checkpointSuggestion') } },
                { not: { contains: { type: 'object', required: ['kind'], properties: { kind: { enum: ['planCreated', 'planRevised'] } } } } },
              ],
            },
          },
          {
            if: { contains: kindIs('checkpointSuggestion') },
            then: {
              allOf: [
                { not: { contains: kindIs('toolRequest') } },
                { not: { contains: { type: 'object', required: ['kind'], properties: { kind: { enum: ['planCreated', 'planRevised'] } } } } },
              ],
            },
          },
        ],
      },
      message: {
        type: 'object',
        required: ['kind'],
        properties: { kind: { enum: [...PROTOCOL_MESSAGE_KINDS] } },
        allOf: [
          { if: { properties: { kind: { const: 'planCreated' } } }, then: { $ref: '#/$defs/planShaping' } },
          { if: { properties: { kind: { const: 'planRevised' } } }, then: { $ref: '#/$defs/planShaping' } },
          { if: { properties: { kind: { const: 'planItemStateChanged' } } }, then: { $ref: '#/$defs/planItemStateChanged' } },
          { if: { properties: { kind: { const: 'publicRationale' } } }, then: { $ref: '#/$defs/publicRationale' } },
          { if: { properties: { kind: { const: 'toolRequest' } } }, then: { $ref: '#/$defs/toolRequest' } },
          { if: { properties: { kind: { const: 'candidateSubmission' } } }, then: { $ref: '#/$defs/candidateSubmission' } },
        ],
      },
      pinnedRevision: {
        // `old`/`new` are this codebase's own names for the same two revisions, and case is folded,
        // so a model reusing the vocabulary of a diff position it just read is not rejected for it.
        enum: ['base', 'head', 'BASE', 'HEAD', 'old', 'new', 'OLD', 'NEW'],
      },
      planShaping: {
        type: 'object',
        required: ['items'],
        properties: { items: { type: 'array', minItems: 1, items: planItem } },
      },
      planItemStateChanged: {
        type: 'object',
        required: ['itemId', 'state'],
        properties: { itemId: identifier(MAX_ID_LENGTH), state: { enum: [...PLAN_ITEM_STATES] } },
      },
      publicRationale: {
        type: 'object',
        required: ['rationale'],
        properties: { rationale: s(MAX_PUBLIC_TEXT_LENGTH) },
      },
      toolRequest,
      candidateSubmission: {
        type: 'object',
        required: ['candidate'],
        properties: { candidate },
      },
    },
  };
}

/** The schema under the shipped default policy — the form the prompt renders and tests assert. */
export const HARNESS_TURN_SCHEMA: JsonSchema = buildHarnessTurnSchema();
