/**
 * Per-member changed-file inventory: manifest accumulation and file
 * inspection-state transitions (tasks 8.1/8.2 of `add-agentic-review-harness`,
 * design.md D10, spec `agentic-review-harness` "Coverage and risk govern
 * investigation", `review-run-activity` "Progress is based on real work
 * units").
 *
 * Two invariants are structural here rather than asserted by callers:
 *
 * - No changed file can disappear. A manifest page only ever adds records;
 *   a repeated path is ignored (replay-idempotent), a page bound to a
 *   different snapshot is refused, and a page arriving after enumeration
 *   was declared `complete` or `truncated` that would add files is refused.
 * - No total denominator exists until enumeration is explicitly `complete`.
 *   `counts().total`, `coverage().totalFiles`, and `coverageProgress().total`
 *   are `undefined` while any member is still `inProgress`, `truncated`, or
 *   `unavailable`, so a UI cannot derive a percentage from a known subset.
 *
 * File states follow D10's diagram exactly: `unvisited -> classified ->
 * inspected | excludedByPolicy | unavailable | binary | oversized`. A terminal
 * transition from `unvisited` is refused — classification (risk, logical
 * unit, policy identity) must be recorded first, even for a file whose
 * manifest facts already make the terminal state obvious; `harnessRiskFloors`
 * gives the host a deterministic classification for that case.
 */
import type { CoverageProgress } from '../domain/harnessActivity';
import type { ChangedFileRecord, FileInspectionState, MemberCoverage, RiskLevel } from '../domain/harnessCoverage';
import { isRiskLevel } from '../domain/harnessCoverage';
import type { ChangedFileEntry, ChangedFileKind, ChangedFileManifestResult, InvestigationSnapshotRef } from '../platform/types';
import type { ActivityFact } from './harnessActivityLog';
import { sanitizePublicText } from './harnessActivitySanitizer';
import { normalizeEvidencePath } from './harnessEvidenceLedger';

export const MANIFEST_ENUMERATION_STATES = ['inProgress', 'complete', 'truncated', 'unavailable'] as const;

/** Only `complete` yields a denominator; `truncated`/`unavailable` are provider limits, `inProgress` has a pending cursor. */
export type ManifestEnumerationState = (typeof MANIFEST_ENUMERATION_STATES)[number];

export interface InventoryMemberInput {
  readonly memberId: string;
  readonly snapshot: InvestigationSnapshotRef;
}

export interface InventoryFileRecord extends ChangedFileRecord {
  readonly kind: ChangedFileKind;
  readonly oldPath?: string;
  readonly binary: boolean;
  readonly addedLines?: number;
  readonly removedLines?: number;
  readonly byteSize?: number;
  /** Applicable policy identity recorded at classification (D10). */
  readonly policyId?: string;
  /** 1-based manifest page that first introduced this path. */
  readonly page: number;
}

export interface MemberInventory {
  readonly memberId: string;
  readonly snapshot: InvestigationSnapshotRef;
  readonly enumeration: ManifestEnumerationState;
  readonly pagesAccepted: number;
  /** Present only while `enumeration` is `inProgress` and a continuation was returned. */
  readonly pendingCursor?: string;
  readonly knownRemainingUnits?: number;
  /** Public reason for `truncated`/`unavailable`. */
  readonly reason?: string;
  readonly files: readonly InventoryFileRecord[];
}

export interface InventoryCounts {
  readonly unvisited: number;
  readonly classified: number;
  readonly inspected: number;
  readonly excludedByPolicy: number;
  readonly unavailable: number;
  readonly binary: number;
  readonly oversized: number;
  /** Files enumerated so far — always real. */
  readonly known: number;
  /** Only when every member in scope has `enumeration: 'complete'`. */
  readonly total?: number;
}

export type ManifestRefusal = 'unknownMember' | 'snapshotMismatch' | 'enumerationClosed' | 'invalidPath';

export type ManifestAcceptance =
  | { readonly ok: true; readonly added: number; readonly duplicates: number; readonly enumeration: ManifestEnumerationState }
  | { readonly ok: false; readonly code: ManifestRefusal; readonly message: string };

export type FileTransitionRefusal =
  | 'unknownMember'
  | 'unknownPath'
  | 'notClassified'
  | 'alreadyTerminal'
  | 'missingReason'
  | 'invalidRisk'
  | 'invalidState';

export type FileTransitionOutcome =
  | { readonly ok: true; readonly file: InventoryFileRecord; readonly changed: boolean }
  | { readonly ok: false; readonly code: FileTransitionRefusal; readonly message: string };

export type NonInspectedTerminalState = Extract<FileInspectionState, 'excludedByPolicy' | 'unavailable' | 'binary' | 'oversized'>;

const NON_INSPECTED_TERMINAL: ReadonlySet<FileInspectionState> = new Set<FileInspectionState>([
  'excludedByPolicy',
  'unavailable',
  'binary',
  'oversized',
]);

export interface FileClassification {
  readonly risk: RiskLevel;
  readonly logicalUnit?: string;
  readonly policyId?: string;
}

export interface ChangedFileInventory {
  members(): readonly MemberInventory[];
  member(memberId: string): MemberInventory | undefined;
  file(memberId: string, path: string): InventoryFileRecord | undefined;
  /** Accepts one neutral manifest result for a member; never removes or reorders files already known. */
  acceptManifestPage(memberId: string, result: ChangedFileManifestResult): ManifestAcceptance;
  /** `unvisited -> classified`; re-classifying a `classified` file replaces risk/unit/policy. */
  classify(memberId: string, path: string, classification: FileClassification): FileTransitionOutcome;
  /** `classified -> inspected`; requires model-visible diff evidence, which the caller attests by calling this. */
  markInspected(memberId: string, path: string): FileTransitionOutcome;
  /** `classified -> excludedByPolicy | unavailable | binary | oversized`, always with a public reason. */
  markTerminal(memberId: string, path: string, state: NonInspectedTerminalState, reason: string): FileTransitionOutcome;
  counts(memberId?: string): InventoryCounts;
  /** Domain-shaped per-member coverage (`harnessCoverage.ts`); `totalFiles` only when complete. */
  coverage(memberId: string): MemberCoverage | undefined;
  everyMemberComplete(): boolean;
  /** Display summary for `coverageChanged` facts; `total` only when every member is complete. */
  coverageProgress(requiredRisks?: readonly RiskLevel[]): CoverageProgress;
}

interface MutableMember {
  memberId: string;
  snapshot: InvestigationSnapshotRef;
  enumeration: ManifestEnumerationState;
  pagesAccepted: number;
  pendingCursor?: string;
  knownRemainingUnits?: number;
  reason?: string;
  order: string[];
  files: Map<string, InventoryFileRecord>;
}

function sameSnapshot(a: InvestigationSnapshotRef, b: InvestigationSnapshotRef): boolean {
  return a.repoId === b.repoId && a.baseSha === b.baseSha && a.headSha === b.headSha;
}

function refuse<C extends string>(code: C, message: string): { readonly ok: false; readonly code: C; readonly message: string } {
  return { ok: false, code, message };
}

function toRecord(memberId: string, entry: ChangedFileEntry, path: string, page: number): InventoryFileRecord {
  const oldPath = entry.oldPath === undefined ? undefined : normalizeEvidencePath(entry.oldPath);
  return Object.freeze({
    path,
    memberId,
    state: 'unvisited',
    kind: entry.kind,
    ...(oldPath !== undefined ? { oldPath } : {}),
    binary: entry.binary,
    ...(entry.addedLines !== undefined ? { addedLines: entry.addedLines } : {}),
    ...(entry.removedLines !== undefined ? { removedLines: entry.removedLines } : {}),
    ...(entry.byteSize !== undefined ? { byteSize: entry.byteSize } : {}),
    page,
  });
}

function emptyCounts(): { -readonly [K in keyof Omit<InventoryCounts, 'total'>]: number } {
  return { unvisited: 0, classified: 0, inspected: 0, excludedByPolicy: 0, unavailable: 0, binary: 0, oversized: 0, known: 0 };
}

export function createChangedFileInventory(members: readonly InventoryMemberInput[]): ChangedFileInventory {
  if (members.length === 0) throw new Error('A changed-file inventory needs at least one member.');
  const byMember = new Map<string, MutableMember>();
  for (const member of members) {
    if (byMember.has(member.memberId)) throw new Error(`Duplicate inventory member id: ${member.memberId}`);
    byMember.set(member.memberId, {
      memberId: member.memberId,
      snapshot: Object.freeze({ ...member.snapshot }),
      enumeration: 'inProgress',
      pagesAccepted: 0,
      order: [],
      files: new Map(),
    });
  }

  function view(member: MutableMember): MemberInventory {
    return Object.freeze({
      memberId: member.memberId,
      snapshot: member.snapshot,
      enumeration: member.enumeration,
      pagesAccepted: member.pagesAccepted,
      ...(member.pendingCursor !== undefined ? { pendingCursor: member.pendingCursor } : {}),
      ...(member.knownRemainingUnits !== undefined ? { knownRemainingUnits: member.knownRemainingUnits } : {}),
      ...(member.reason !== undefined ? { reason: member.reason } : {}),
      files: Object.freeze(member.order.map((path) => member.files.get(path) as InventoryFileRecord)),
    });
  }

  function transition(
    memberId: string,
    rawPath: string,
    apply: (file: InventoryFileRecord) => FileTransitionOutcome,
  ): FileTransitionOutcome {
    const member = byMember.get(memberId);
    if (!member) return refuse('unknownMember', `Member ${memberId} is not part of this inventory.`);
    const path = normalizeEvidencePath(rawPath);
    const file = path === undefined ? undefined : member.files.get(path);
    if (!file) return refuse('unknownPath', `${rawPath} is not in member ${memberId}'s changed-file inventory.`);
    const outcome = apply(file);
    if (outcome.ok && outcome.changed) member.files.set(file.path, Object.freeze(outcome.file));
    return outcome;
  }

  function scopedMembers(memberId?: string): MutableMember[] {
    if (memberId === undefined) return [...byMember.values()];
    const member = byMember.get(memberId);
    return member ? [member] : [];
  }

  function countsFor(scope: readonly MutableMember[]): InventoryCounts {
    const counts = emptyCounts();
    for (const member of scope) {
      for (const file of member.files.values()) {
        counts[file.state] += 1;
        counts.known += 1;
      }
    }
    const complete = scope.length > 0 && scope.every((member) => member.enumeration === 'complete');
    return Object.freeze(complete ? { ...counts, total: counts.known } : { ...counts });
  }

  return {
    members: () => [...byMember.values()].map(view),
    member(memberId) {
      const member = byMember.get(memberId);
      return member ? view(member) : undefined;
    },
    file(memberId, rawPath) {
      const path = normalizeEvidencePath(rawPath);
      return path === undefined ? undefined : byMember.get(memberId)?.files.get(path);
    },

    acceptManifestPage(memberId, result) {
      const member = byMember.get(memberId);
      if (!member) return refuse('unknownMember', `Member ${memberId} is not part of this inventory.`);
      if (!sameSnapshot(result.snapshot, member.snapshot)) {
        return refuse('snapshotMismatch', `Manifest page is bound to a different repository or revision than member ${memberId}.`);
      }
      switch (result.state) {
        case 'complete':
        case 'paginated':
        case 'truncated': {
          const closed = member.enumeration === 'complete' || member.enumeration === 'truncated';
          const incoming: Array<{ path: string; entry: ChangedFileEntry }> = [];
          for (const entry of result.value) {
            const path = normalizeEvidencePath(entry.path);
            if (path === undefined) return refuse('invalidPath', `Manifest entry path ${JSON.stringify(entry.path)} is not a valid repository path.`);
            incoming.push({ path, entry });
          }
          const fresh = incoming.filter(({ path }) => !member.files.has(path));
          if (closed && fresh.length > 0) {
            return refuse('enumerationClosed', `Member ${memberId}'s enumeration is already ${member.enumeration}; a page adding ${fresh.length} file(s) cannot be accepted.`);
          }
          if (closed) return { ok: true, added: 0, duplicates: incoming.length, enumeration: member.enumeration }; // exact replay
          member.pagesAccepted += 1;
          const seenInPage = new Set<string>();
          let added = 0;
          for (const { path, entry } of fresh) {
            if (seenInPage.has(path)) continue;
            seenInPage.add(path);
            member.files.set(path, toRecord(memberId, entry, path, member.pagesAccepted));
            member.order.push(path);
            added += 1;
          }
          if (result.state === 'paginated') {
            member.enumeration = 'inProgress';
            member.pendingCursor = result.cursor;
            member.knownRemainingUnits = undefined;
            member.reason = undefined;
          } else if (result.state === 'complete') {
            member.enumeration = 'complete';
            member.pendingCursor = undefined;
            member.knownRemainingUnits = undefined;
            member.reason = undefined;
          } else {
            member.enumeration = 'truncated';
            member.pendingCursor = undefined;
            member.knownRemainingUnits = result.knownRemainingUnits;
            member.reason = 'The provider could not enumerate every changed file.';
          }
          return { ok: true, added, duplicates: incoming.length - added, enumeration: member.enumeration };
        }
        default: {
          if (member.enumeration === 'complete' || member.enumeration === 'truncated') {
            return refuse('enumerationClosed', `Member ${memberId}'s enumeration is already ${member.enumeration}.`);
          }
          member.enumeration = 'unavailable';
          member.pendingCursor = undefined;
          member.reason = `The provider returned ${result.state} for the changed-file manifest.`;
          return { ok: true, added: 0, duplicates: 0, enumeration: member.enumeration };
        }
      }
    },

    classify(memberId, rawPath, classification) {
      return transition(memberId, rawPath, (file) => {
        if (!isRiskLevel(classification.risk)) return refuse('invalidRisk', `Risk ${String(classification.risk)} is not a known risk level.`);
        if (file.state !== 'unvisited' && file.state !== 'classified') {
          return refuse('alreadyTerminal', `${file.path} is already ${file.state}; classification is fixed.`);
        }
        const logicalUnit = classification.logicalUnit === undefined ? undefined : sanitizePublicText(classification.logicalUnit);
        const next: InventoryFileRecord = {
          ...file,
          state: 'classified',
          risk: classification.risk,
          ...(logicalUnit !== undefined ? { logicalUnit } : {}),
          ...(classification.policyId !== undefined ? { policyId: classification.policyId } : {}),
        };
        return { ok: true, file: next, changed: true };
      });
    },

    markInspected(memberId, rawPath) {
      return transition(memberId, rawPath, (file) => {
        if (file.state === 'inspected') return { ok: true, file, changed: false };
        if (file.state === 'unvisited') return refuse('notClassified', `${file.path} must be classified before it can be inspected.`);
        if (file.state !== 'classified') return refuse('alreadyTerminal', `${file.path} is already ${file.state}.`);
        return { ok: true, file: { ...file, state: 'inspected' }, changed: true };
      });
    },

    markTerminal(memberId, rawPath, state, rawReason) {
      return transition(memberId, rawPath, (file) => {
        if (!NON_INSPECTED_TERMINAL.has(state)) return refuse('invalidState', `${String(state)} is not a non-inspected terminal state.`);
        const reason = sanitizePublicText(rawReason);
        if (reason === undefined) return refuse('missingReason', `A public reason is required to mark ${file.path} ${state}.`);
        if (file.state === state) return { ok: true, file, changed: false };
        if (file.state === 'unvisited') return refuse('notClassified', `${file.path} must be classified before it can be marked ${state}.`);
        if (file.state !== 'classified') return refuse('alreadyTerminal', `${file.path} is already ${file.state}.`);
        return { ok: true, file: { ...file, state, reason }, changed: true };
      });
    },

    counts: (memberId) => countsFor(scopedMembers(memberId)),

    coverage(memberId) {
      const member = byMember.get(memberId);
      if (!member) return undefined;
      const files: ChangedFileRecord[] = member.order.map((path) => {
        const file = member.files.get(path) as InventoryFileRecord;
        return {
          path: file.path,
          memberId: file.memberId,
          state: file.state,
          ...(file.risk !== undefined ? { risk: file.risk } : {}),
          ...(file.logicalUnit !== undefined ? { logicalUnit: file.logicalUnit } : {}),
          ...(file.reason !== undefined ? { reason: file.reason } : {}),
        };
      });
      const manifestComplete = member.enumeration === 'complete';
      return Object.freeze({
        memberId,
        manifestComplete,
        ...(manifestComplete ? { totalFiles: files.length } : {}),
        files: Object.freeze(files),
      });
    },

    everyMemberComplete: () => [...byMember.values()].every((member) => member.enumeration === 'complete'),

    coverageProgress(requiredRisks) {
      const counts = countsFor([...byMember.values()]);
      const classified = counts.known - counts.unvisited;
      const progress: { -readonly [K in keyof CoverageProgress]: CoverageProgress[K] } = { classified, inspected: counts.inspected };
      if (counts.total !== undefined) {
        progress.total = counts.total;
        if (requiredRisks !== undefined) {
          const required = new Set(requiredRisks);
          let requiredInspected = 0;
          for (const member of byMember.values()) {
            for (const file of member.files.values()) {
              if (file.state === 'inspected' && file.risk !== undefined && required.has(file.risk)) requiredInspected += 1;
            }
          }
          progress.requiredInspected = requiredInspected;
        }
      }
      return Object.freeze(progress);
    },
  };
}

/** The section-5 activity integration point: one `coverageChanged` fact from the inventory's current real counts. */
export function coverageChangedFact(
  inventory: ChangedFileInventory,
  requiredRisks?: readonly RiskLevel[],
): Extract<ActivityFact, { kind: 'coverageChanged' }> {
  return { kind: 'coverageChanged', coverage: inventory.coverageProgress(requiredRisks) };
}
