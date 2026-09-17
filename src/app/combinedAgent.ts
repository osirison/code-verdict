/**
 * Changeset member identity and composite-head helpers.
 *
 * Task 15.8 removed `crossRepositoryFinding`, `validateChangesetResponse`,
 * and `runDemoChangesetAgent` — the one-shot changeset demo runner and its
 * response validator. Nothing shipped reached them any more (the harness
 * demo participant, task 10.7, is what runs demo changeset reviews now).
 * What remains is member identity/attachment-ownership and the composite
 * `headSha` format, still used by `ui/changesetReview.ts` (triage,
 * pre-run context-usage estimates, submit) and `reviewRunManager.ts`
 * (`headShaFor`'s own changeset branch mirrors this same format).
 */
import type { ChangeRequestDiff, ChangeRequestRef } from '../platform/types';
import type { Attachment, EvidenceManifest, ReviewContext } from './reviewContext';

export interface ChangesetAgentMember {
  ref: ChangeRequestRef;
  projectPath: string;
  diff: ChangeRequestDiff;
  /** What this member is for. Optional: the demo agent reads diffs only. */
  context?: ReviewContext;
  /** Reviewable evidence explicitly attached to this member repository. */
  attachments?: readonly Attachment[];
  /** Exact post-budget evidence for this member; absent callers derive it from their attachments. */
  evidenceManifest?: EvidenceManifest;
  /** Host-assigned qualification for this member's changed-file paths. */
  workspaceRootLabel?: string;
  /** Canonical host root used only to associate resolved attachment source URIs. */
  workspaceRootSourceUri?: string;
}

function sourceUriWithinRoot(sourceUri: string, rootSourceUri: string): boolean {
  return sourceUri === rootSourceUri
    || (rootSourceUri.endsWith('/')
      ? sourceUri.startsWith(rootSourceUri)
      : sourceUri.startsWith(`${rootSourceUri}/`));
}

/** Return an owner only when host root identity proves exactly one member owns the attachment. */
export function changesetMemberForAttachment<T extends Pick<ChangesetAgentMember, 'workspaceRootSourceUri'>>(
  members: readonly T[],
  attachment: Pick<Attachment, 'sourceUri'>,
): T | undefined {
  if (!attachment.sourceUri) return undefined;
  const matches = members.filter((member) => (
    member.workspaceRootSourceUri !== undefined
    && sourceUriWithinRoot(attachment.sourceUri as string, member.workspaceRootSourceUri)
  ));
  return matches.length === 1 ? matches[0] : undefined;
}

function compositeHead(members: readonly ChangesetAgentMember[]): string {
  return members.map((member) => `${member.ref.repoId}!${member.ref.number}:${member.diff.headSha}`).join('|');
}

export function changesetHeadSha(members: readonly ChangesetAgentMember[]): string {
  return compositeHead(members);
}

/**
 * The inverse of {@link changesetHeadSha}, kept beside it so the two formats
 * cannot drift. A segment is `<repoId>!<number>:<sha>`; anything without the
 * separator is not a composite head and is dropped rather than parsed into a
 * bogus key, which would read as "every member moved".
 */
export function parseChangesetHeadSha(headSha: string): Map<string, string> {
  return new Map(
    headSha.split('|').flatMap((part) => {
      const separator = part.lastIndexOf(':');
      if (separator < 0) return [];
      const [key, sha] = [part.slice(0, separator), part.slice(separator + 1)];
      return key && sha ? [[key, sha] as const] : [];
    }),
  );
}
