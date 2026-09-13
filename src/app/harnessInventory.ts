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
 *
 * One edge runs backwards: `revokeInspection` returns `inspected -> classified`
 * for a read whose evidence never reached the model, because `markInspected`
 * records a caller's *attestation* rather than a fact this module can check,
 * and a false attestation left standing is a review reported complete over
 * unread code. See that method for the measured failure it answers. No
 * terminal state is reversible, and that has not changed.
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
  /**
   * The platform enumerated this file and would not serve its content
   * (`ChangedFileEntry.contentDeclined`, task 3.2). Deliberately NOT a
   * `FileInspectionState`: the file is still `classified` and still worth
   * reading, and every state in that enum past `classified` is irreversible.
   * What it is instead is a fact the completion gate reads, so a run cannot be
   * called complete over a file whose content nobody was given.
   *
   * Set from the manifest entry, and by `markContentDeclined` when a read
   * comes back declined mid-run for a file whose manifest entry was clean.
   * Never cleared: a file that goes on to be read leaves `classified` for
   * `inspected`, and the gate only looks at this on a `classified` file.
   */
  readonly contentDeclined?: boolean;
  /**
   * A read of this file came back `unknown` — the source was asked and
   * established nothing (`add-local-git-investigation` task 3.5, design D8's
   * "bounded non-terminal result" row). Not a `FileInspectionState`, for the
   * same reason `contentDeclined` is not: the file stays `classified` and
   * still readable, and every state past `classified` is irreversible.
   *
   * Set only by `markReadFailed`, never from a manifest entry: a manifest has
   * no way to say "a read of this would fail", and a source whose manifest
   * did not arrive at all has no entries here to mark.
   */
  readonly readFailed?: boolean;
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
  /** `inspected -> classified`, for the one condition that falsifies the attestation `markInspected` takes on trust: the evidence never reached the model. See the implementation for why this is the single exception to irreversibility. */
  revokeInspection(memberId: string, path: string): FileTransitionOutcome;
  /** `classified -> excludedByPolicy | unavailable | binary | oversized`, always with a public reason. */
  markTerminal(memberId: string, path: string, state: NonInspectedTerminalState, reason: string): FileTransitionOutcome;
  /** Records that the source would not serve this file's content. Changes no state and closes nothing — the file stays classified and still readable (task 3.5). */
  markContentDeclined(memberId: string, path: string): FileTransitionOutcome;
  /** Records that a read of this file resolved to nothing the source established. Changes no state and closes nothing, for the same reason `markContentDeclined` does not. */
  markReadFailed(memberId: string, path: string): FileTransitionOutcome;
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
    ...(entry.contentDeclined === true ? { contentDeclined: true } : {}),
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

    /**
     * The one reversal this state machine allows, and it exists because `markInspected` above
     * takes a *claim* on trust: "requires model-visible diff evidence, which the caller attests by
     * calling this". When that claim turns out to have been false, nothing else here can correct
     * it, and an uncorrected false claim is a review reporting itself complete over code nobody
     * read — the exact outcome this whole inventory was built to make impossible.
     *
     * **The live failure.** `harnessAttempt.ts` marks a file inspected the moment a `readDiff`
     * result comes back from the dispatcher. The prompt carrying that result is assembled
     * afterwards, and `harnessModelSeam.ts`'s renderer drops whole results from it when the
     * assembled bytes go past `maxPromptBytesPerTurn`. Measured on a two-file review at a
     * 120,000-byte cap, a second read anywhere in a 455-byte window was fetched, marked inspected,
     * and then removed from the prompt: coverage claimed a file was read that the model never saw
     * a byte of, and the completion gate counted it as satisfied. `harnessAttempt.ts` now calls
     * this for every dropped read, so the file returns to `classified` — unread, still worth
     * asking for, and still blocking completion.
     *
     * It is deliberately *not* a general un-inspect. `inspected` is the only state it reverses,
     * and it reverses it only to `classified`: the terminal states below are claims about the file
     * itself (binary, oversized, unavailable) that no prompt-size accident can falsify, and
     * reopening one would reintroduce exactly the loop `markTerminal`'s irreversibility exists to
     * close. Classification is kept — risk, logical unit and policy identity were established by
     * the host from the manifest and are untouched by whether a diff reached a model.
     */
    revokeInspection(memberId, rawPath) {
      return transition(memberId, rawPath, (file) => {
        if (file.state !== 'inspected') return { ok: true, file, changed: false };
        return { ok: true, file: { ...file, state: 'classified' }, changed: true };
      });
    },

    /**
     * The one marker on this inventory that closes nothing. A read the source
     * declined leaves the file exactly where it was — `classified`, unread,
     * still worth asking another source for — and records only that this
     * source would not serve it. Terminal states are irreversible by
     * construction (see `markTerminal` below), which is precisely why a
     * condition the source did not prove must not use one.
     */
    markContentDeclined(memberId, rawPath) {
      return transition(memberId, rawPath, (file) => {
        if (file.state !== 'unvisited' && file.state !== 'classified') return refuse('alreadyTerminal', `${file.path} is already ${file.state}.`);
        if (file.contentDeclined === true) return { ok: true, file, changed: false };
        return { ok: true, file: { ...file, contentDeclined: true }, changed: true };
      });
    },

    /**
     * The second marker that closes nothing, and it exists because the first
     * one did not cover the condition D8's closing sentence names. A read that
     * came back `unknown` — an invocation stopped at a bound, a pinned revision
     * the object store could not resolve, a diff that failed for a path the
     * manifest had just enumerated — established nothing about the file, so it
     * stays exactly where it was, `classified` and unread.
     *
     * Recording it is what makes that true of the *completion gate* as well.
     * Before this, such a read left no trace at all on the inventory: the file
     * was still classified, and a classified file only blocks completion when
     * its risk demands inspection. A low-risk file whose diff the source never
     * served therefore left the gate eligible with zero blockers, and the run
     * ended complete and clean over content nobody had read — the same outcome
     * `contentDeclined` exists to prevent, reached through the other door.
     */
    markReadFailed(memberId, rawPath) {
      return transition(memberId, rawPath, (file) => {
        if (file.state !== 'unvisited' && file.state !== 'classified') return refuse('alreadyTerminal', `${file.path} is already ${file.state}.`);
        if (file.readFailed === true) return { ok: true, file, changed: false };
        return { ok: true, file: { ...file, readFailed: true }, changed: true };
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
          // Both carried into the checkpoint so a resumed attempt replays them
          // (`applyCoverageSeed`): they are the only things that keep a
          // low-risk file the source never served from letting a resumed run
          // report itself complete and clean.
          ...(file.contentDeclined === true ? { contentDeclined: true } : {}),
          ...(file.readFailed === true ? { readFailed: true } : {}),
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

/**
 * Task 14.6: re-apply a resumed attempt's prior classification decisions onto a *freshly
 * enumerated* inventory — never a persisted `enumeration`/`pendingCursor`/`knownRemainingUnits`,
 * which this function deliberately does not accept. `decideResume`'s compatibility check already
 * guarantees identical member heads between the checkpoint and the new attempt, and identical
 * heads mean the provider's changed-file manifest is deterministic: the same files, in the same
 * order. Re-enumerating instead of persisting pagination state is simpler, cannot drift from
 * whatever the provider actually reports today, and needs no new persisted shape — the new
 * attempt just runs its own manifest turn first, exactly as attempt 1 did, and this function
 * replays classification decisions on top of what came back.
 *
 * `coverage` is `ResumePayload.coverage`, straight off the checkpoint. For each file whose
 * checkpoint state moved past `unvisited`, `classify()` is called first (every terminal or
 * inspected state requires it, per this module's own state machine) and then `markInspected`/
 * `markTerminal` as the checkpoint state calls for. `policyId` is not carried — `MemberCoverage`'s
 * own `ChangedFileRecord` never carried it (only the richer in-memory `InventoryFileRecord` does),
 * so a re-applied classification omits it; this is a documented, deliberate precision loss, not an
 * oversight. A checkpoint record for a path the fresh enumeration does not know (a stale record,
 * or — impossible given identical heads, but handled defensively — a provider inconsistency) is
 * skipped rather than thrown: the file simply starts `unvisited`, and the attempt re-investigates
 * it rather than silently losing ground.
 *
 * **A replayed `binary` is corroborated against the current source, never taken on trust.** This
 * is the one state a checkpoint can carry that the completion gate counts as *satisfied* while the
 * file was never read, so it is the one state a wrong record turns into a clean review of code
 * nobody saw — and records written by the build before this change can be wrong about it. That
 * build mapped GitHub's patchless, zero-count compare entry to `binary`; on the measured change
 * 137 of 207 plain-TypeScript files came back in exactly that shape, were closed irreversibly, and
 * the run reported itself complete and clean. Task 3.3 stopped the mapping, but a checkpoint
 * already on disk still holds the guess, and replaying it reproduces the whole outcome on the
 * resumed attempt.
 *
 * So the state is replayed only when the file the fresh enumeration just delivered also says
 * `binary` — the current source's own answer, already in hand because this function runs from
 * `onManifestPage` with the page that produced the record. Nothing else is trusted to settle it:
 * a terminal `binary` is a claim about the file's *content*, and only a source that read the
 * content can make one.
 *
 * Asking the source rather than asking which build wrote the record is deliberate, and it is the
 * stronger of the two. A marker on the record ("this build could tell declined from binary,
 * absent reads as could not") would reopen every `binary` an older GitLab or local-git checkpoint
 * recorded — and those were proven from the content, so it would discard correct resumable work
 * to catch a fault only GitHub's records have. Corroboration keeps them: every source that
 * answers a `readDiff` with `binary` also flags `binary` on its manifest entry, so a record that
 * was right is still replayed. One that the current source will not stand behind is not — the
 * file simply stays `classified`, carrying whatever this enumeration said about it
 * (`contentDeclined` included), and the gate decides on today's facts.
 *
 * The other terminal states need no such check. `excludedByPolicy` is the host's own decision and
 * no source ever claimed it; `unavailable` and `oversized` block completion whether they are
 * accurate or not, so replaying one can never produce the clean-but-unread verdict this guards.
 */
export function applyCoverageSeed(inventory: ChangedFileInventory, coverage: readonly MemberCoverage[]): void {
  for (const memberCoverage of coverage) {
    for (const record of memberCoverage.files) {
      if (record.state === 'unvisited') continue;
      const fresh = inventory.file(record.memberId, record.path);
      if (!fresh) continue; // not (yet) known to the fresh enumeration
      if (record.risk === undefined) continue; // defensive: production always classifies before any further transition
      const classified = inventory.classify(record.memberId, record.path, { risk: record.risk, logicalUnit: record.logicalUnit });
      if (!classified.ok) continue;
      // Replayed before the state transitions below, because they are the two
      // facts that belong to a file that is still `classified`: neither a
      // declined read nor a read that resolved to nothing proved anything about
      // the content, so nothing here may close the file, and the flags are what
      // keep the completion gate refusing to call the run complete over it
      // (task 10.6).
      if (record.contentDeclined === true) inventory.markContentDeclined(record.memberId, record.path);
      if (record.readFailed === true) inventory.markReadFailed(record.memberId, record.path);
      if (record.state === 'inspected') {
        inventory.markInspected(record.memberId, record.path);
      } else if (record.state !== 'classified') {
        if (record.state === 'binary' && !fresh.binary) continue;
        inventory.markTerminal(record.memberId, record.path, record.state, record.reason ?? 'Carried forward from the interrupted attempt.');
      }
    }
  }
}
