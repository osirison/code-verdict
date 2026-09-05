/**
 * The versioned host tool catalog (task 9.1 of `add-agentic-review-harness`,
 * design.md D6, spec `agentic-review-harness` "The model plans and
 * investigates through bounded host tools").
 *
 * Pure data + types, no I/O: this module only *describes* the ten tools the
 * harness authorizes. Validation, dispatch, and result envelopes are
 * `../app/harnessToolDispatcher.ts` (tasks 9.2-9.4). `harnessBootstrap.ts`
 * derives its bootstrap-envelope `HOST_TOOL_CATALOG` from
 * `HOST_TOOL_DEFINITIONS` here, never the other way around — this file must
 * not import `harnessBootstrap.ts`.
 *
 * `HARNESS_TOOL_CONTRACT_VERSION` moved here from
 * `reviewRunSnapshotBuilder.ts` (which carried a forward-reference
 * placeholder comment naming this very file) and is re-exported there
 * unchanged so every existing importer keeps working. The value stays `'1'`:
 * this is the first real catalog behind that version number, not a revision
 * to a prior one.
 */
import type { Connection, ReviewInvestigationCapabilities } from '../platform/provider';
import type { RunPhase } from './harnessActivity';

/** Versions the host tool catalog itself — snapshotted onto every run (design.md D3) and echoed on every tool result (task 9.3). */
export const HARNESS_TOOL_CONTRACT_VERSION = '1';

/** Design.md D6's fixed ten-tool catalog, in the design table's order. */
export const HOST_TOOL_NAMES = [
  'listChangedFiles',
  'readDiff',
  'readFile',
  'searchRepository',
  'searchDiff',
  'resolvePolicy',
  'getChangeRequestDetails',
  'getIssueDetails',
  'submitCandidateFinding',
  'requestCompletion',
] as const;

export type HostToolName = (typeof HOST_TOOL_NAMES)[number];

export function isHostToolName(value: unknown): value is HostToolName {
  return typeof value === 'string' && (HOST_TOOL_NAMES as readonly string[]).includes(value);
}

/** `providerRead` resolves against provider content (directly or, for `resolvePolicy`, through repeated reads); `hostAction` never touches `Connection` at all. */
export type HostToolKind = 'providerRead' | 'hostAction';

/** Which `HarnessPolicy` field bounds a provider-declared page size for a paginated tool (task 9.2 `outOfBounds`). */
export type ToolPageSizePolicyField = 'manifestPageSize' | 'diffOrFileReadPageLines' | 'searchResultPageMatches';

export interface HostToolDefinition {
  readonly name: HostToolName;
  readonly kind: HostToolKind;
  /**
   * The `ReviewInvestigationCapabilities` key the dispatcher checks before
   * dispatch. Undefined for `resolvePolicy` — it issues repeated
   * `Connection.readFile` calls itself (`../app/harnessAgentsPolicy.ts`) and
   * so rides on the `fileReads` capability rather than declaring its own
   * (design.md D7: "Root and nested AGENTS.md resolution uses repeated
   * provider readFile operations"). Undefined for the two host actions,
   * which have no provider capability at all.
   */
  readonly capability?: keyof ReviewInvestigationCapabilities;
  /**
   * The `Connection` method the dispatcher must find defined before
   * dispatch, independent of the declared capability — task 9.2's
   * `capabilityUnavailable` also fires when "the `Connection` method is
   * undefined". `resolvePolicy` names `readFile` here even though its own
   * `capability` is undefined above, so one generic check covers all eight
   * provider-touching tools with no special case. Undefined for the two
   * host actions, which never call `Connection`.
   */
  readonly connectionMethod?: keyof Connection;
  readonly allowedPhases: readonly RunPhase[];
  /**
   * D12: "`submitCandidateFinding` and read tools are idempotent by request
   * identifier." `requestCompletion` is deliberately not in that list — a
   * repeat call must re-evaluate current truth (coverage, unresolved work),
   * never replay a stale grant/refusal from an earlier call.
   */
  readonly idempotent: boolean;
  readonly requiredScope: string;
  readonly description: string;
  /** Present only for tools whose provider-declared page bound must stay within a `HarnessPolicy` field. */
  readonly pageSizePolicyField?: ToolPageSizePolicyField;
  /** `readFile` only: the request carries an explicit `startLine`/`endLine` bounded by `diffOrFileReadPageLines`. */
  readonly hasLineRange?: boolean;
  /** `searchRepository`/`searchDiff` only: the request carries a free-text `query` with a bounded length. */
  readonly hasQuery?: boolean;
}

const READ_PHASES: readonly RunPhase[] = Object.freeze(['planning', 'investigating', 'verifying']);
/** `listChangedFiles` and the two detail tools also run during `bootstrap` (D4/D6): inventory and reopened target/issue context both start before planning. */
const READ_PHASES_WITH_BOOTSTRAP: readonly RunPhase[] = Object.freeze(['bootstrap', 'planning', 'investigating', 'verifying']);
const CANDIDATE_SUBMISSION_PHASES: readonly RunPhase[] = Object.freeze(['investigating', 'verifying']);
const COMPLETION_REQUEST_PHASES: readonly RunPhase[] = Object.freeze(['verifying', 'completing']);

export const HOST_TOOL_DEFINITIONS: readonly HostToolDefinition[] = Object.freeze([
  {
    name: 'listChangedFiles',
    kind: 'providerRead',
    capability: 'manifests',
    connectionMethod: 'listChangedFiles',
    allowedPhases: READ_PHASES_WITH_BOOTSTRAP,
    idempotent: true,
    requiredScope: 'Member, base/head, cursor',
    description: 'Complete changed-file inventory and metadata.',
    pageSizePolicyField: 'manifestPageSize',
  },
  {
    name: 'readDiff',
    kind: 'providerRead',
    capability: 'diffReads',
    connectionMethod: 'readDiff',
    allowedPhases: READ_PHASES,
    idempotent: true,
    requiredScope: 'Member, path, base/head, bounded range or cursor',
    description: 'Exact changed evidence and inline anchors.',
    pageSizePolicyField: 'diffOrFileReadPageLines',
  },
  {
    name: 'readFile',
    kind: 'providerRead',
    capability: 'fileReads',
    connectionMethod: 'readFile',
    allowedPhases: READ_PHASES,
    idempotent: true,
    requiredScope: 'Member, explicit base or head SHA, path, bounded line range',
    description: 'Revision-pinned supporting source.',
    pageSizePolicyField: 'diffOrFileReadPageLines',
    hasLineRange: true,
  },
  {
    name: 'searchRepository',
    kind: 'providerRead',
    capability: 'repositorySearch',
    connectionMethod: 'searchRepository',
    allowedPhases: READ_PHASES,
    idempotent: true,
    requiredScope: 'Member, explicit base or head SHA, query, path scope, cursor',
    description: 'Bounded unchanged or changed source discovery.',
    pageSizePolicyField: 'searchResultPageMatches',
    hasQuery: true,
  },
  {
    name: 'searchDiff',
    kind: 'providerRead',
    capability: 'diffSearch',
    connectionMethod: 'searchDiff',
    allowedPhases: READ_PHASES,
    idempotent: true,
    requiredScope: 'Member, base/head, query, path scope, cursor',
    description: 'Bounded discovery inside changed content.',
    pageSizePolicyField: 'searchResultPageMatches',
    hasQuery: true,
  },
  {
    name: 'resolvePolicy',
    kind: 'providerRead',
    // See `capability` doc above: rides on `fileReads`, declares no capability of its own.
    connectionMethod: 'readFile',
    allowedPhases: READ_PHASES,
    idempotent: true,
    requiredScope: 'Member, changed path',
    description: 'Applicable root-to-leaf base-revision AGENTS.md chain.',
  },
  {
    name: 'getChangeRequestDetails',
    kind: 'providerRead',
    capability: 'changeRequestDetails',
    connectionMethod: 'getChangeRequestDetails',
    allowedPhases: READ_PHASES_WITH_BOOTSTRAP,
    idempotent: true,
    requiredScope: 'Member, section, cursor',
    description: 'Reopen normalized target details.',
  },
  {
    name: 'getIssueDetails',
    kind: 'providerRead',
    capability: 'issueDetails',
    connectionMethod: 'getIssueDetails',
    allowedPhases: READ_PHASES_WITH_BOOTSTRAP,
    idempotent: true,
    requiredScope: 'Member, issue identity, section, cursor',
    description: 'Reopen normalized linked-issue details.',
  },
  {
    name: 'submitCandidateFinding',
    kind: 'hostAction',
    allowedPhases: CANDIDATE_SUBMISSION_PHASES,
    idempotent: true,
    requiredScope: 'Candidate plus source citations',
    description: 'Incremental schema and evidence validation.',
  },
  {
    name: 'requestCompletion',
    kind: 'hostAction',
    // `completing` is D6's home phase for this tool. `verifying` is also
    // allowed: D11's "repairable early completion request returns bounded
    // missing conditions when enough reserved budget remains" only makes
    // sense issued from a phase where the model is still active and can act
    // on those conditions — that is `verifying`, the last model-driven
    // phase before the host-only `completing` gate evaluation itself.
    allowedPhases: COMPLETION_REQUEST_PHASES,
    idempotent: false,
    requiredScope: 'Claimed coverage and unresolved-work summary',
    description: 'Advisory request evaluated by the host gate.',
  },
]);

const BY_NAME: ReadonlyMap<string, HostToolDefinition> = new Map(
  HOST_TOOL_DEFINITIONS.map((definition) => [definition.name, definition] as const),
);

/** Fails closed: an unknown or non-string name returns `undefined` rather than guessing. */
export function hostToolDefinition(name: unknown): HostToolDefinition | undefined {
  return typeof name === 'string' ? BY_NAME.get(name) : undefined;
}
