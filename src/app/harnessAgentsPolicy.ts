/**
 * Base-revision `AGENTS.md`/`CLAUDE.md` chain resolution (task 6.3 of
 * `add-agentic-review-harness`, design.md D7): walks repository root to a
 * changed file's own directory, reading both policy files at each level at
 * the base SHA.
 *
 * **It reads from the investigation source, not from the connection.** It used
 * to call `Connection.readFile`, which meant a repository's own conventions
 * were fetched from the forge one API call per directory per changed path.
 * `AGENTS.md` and `CLAUDE.md` are files in the repository at a pinned commit,
 * so they are exactly what the rule assigns to git: everything answerable
 * from two commits is answered locally, and the provider is asked only for
 * what is not in the repository. Same neutral operation, same three-valued
 * outcome; what changed is who answers it.
 *
 * **`CLAUDE.md` is a fallback and companion, never a silent alias.** The
 * repo owner's own words: "we pick up the root AGENTS.md as part of the
 * initial submission... if there are no AGENTS.md file it should pick up
 * CLAUDE.md — so if any or both exists it needs to understand the principles
 * that guide the repo." Every level therefore checks both files, in that
 * order (`AGENTS.md` first, then `CLAUDE.md`) — never skips the second check
 * because the first succeeded, since the only way to tell "both exist and
 * differ" from "one exists" is to have looked at both. One file present ->
 * its content alone; both present and byte-identical (the common symlink or
 * copy case) -> one copy, `identical: true`; both present and different ->
 * both, `identical: false`. This doubles the read cost of a level whose
 * repository has neither file (both checks report `notFound`, not one), a
 * cost the small-review cost-assurance suite measures explicitly.
 *
 * Every level's outcome is explicit and three-valued: `present` (with the
 * composed content and a digest), `absent` (the host actually read both
 * files and neither directory entry exists), or `unavailable` (the host
 * could not fully determine presence — capability withheld, connection has
 * no `readFile`, a read itself failed for at least one file with the other
 * never confirmed present, or a file exists but the read came back
 * `paginated`/`truncated` against the per-file line cap: a partial file is
 * exactly the case `unavailable` exists for, since policy text is
 * authoritative instruction and a silently truncated read would hand the
 * model a policy framed as complete that might be missing the clause that
 * mattered). `ReviewRunAgentsPolicySource` (task 2.2)
 * only has two top-level states, so `rootAgentsPolicySourceFor` folds
 * `unavailable` into `present: false` for the snapshot — but, unlike before,
 * it now also carries `unavailableReason` on that fold so an honest
 * "could not check" line survives into the rendered prompt (see that
 * function's own doc comment). The richer three-state chain above remains
 * available to whatever calls this resolver directly (the task 9
 * `resolvePolicy` tool).
 *
 * Composed policy text is authoritative instruction, not evidence: D7 says
 * so explicitly ("Policy is authoritative instruction but remains
 * non-citable"), and `harnessAttempt.ts`'s bootstrap builder is what places
 * it on the authoritative side of the trust boundary and hands it to the
 * model — `rootAgentsPolicySourceFor`'s own `text` field is what makes that
 * possible; before this change the field existed on `BootstrapPolicySource`
 * but nothing ever populated it, so no root policy content ever reached a
 * prompt automatically, in any phase. Non-citability itself is enforced by
 * the evidence ledger (task 7.4), not by this module.
 */
import type { FileRangeResult, InvestigationSource, InvestigationSourceCapabilities } from '../platform/types';
import { DEFAULT_HARNESS_POLICY } from '../domain/harnessPolicy';
import type { PolicyFileKind, ReviewRunAgentsPolicySource } from '../domain/reviewRunSnapshot';
import { sha256Hex } from './contentDigest';

export interface AgentsPolicyMemberRef {
  memberId: string;
  repoId: string;
  baseSha: string;
  headSha: string;
}

/** The two file names a level checks, in the fixed order every render and composition rule assumes. */
const POLICY_FILES: ReadonlyArray<{ readonly kind: PolicyFileKind; readonly name: string }> = [
  { kind: 'agentsMd', name: 'AGENTS.md' },
  { kind: 'claudeMd', name: 'CLAUDE.md' },
];

/** One file's own three-valued outcome at one directory, before combination with its companion file. */
type PolicyFileOutcome =
  | { readonly kind: PolicyFileKind; readonly name: string; readonly state: 'present'; readonly content: string }
  | { readonly kind: PolicyFileKind; readonly name: string; readonly state: 'absent' }
  | { readonly kind: PolicyFileKind; readonly name: string; readonly state: 'unavailable'; readonly reason: string };

export type AgentsPolicyLevel =
  | {
      readonly directory: string;
      readonly state: 'present';
      readonly sourceId: string;
      readonly digest: string;
      readonly content: string;
      /** Always `false`: D7/review-evidence-ledger classify policy as authoritative instruction but never citable evidence. */
      readonly citable: false;
      /** Which file(s) actually contributed, in `AGENTS.md`-then-`CLAUDE.md` order; length 1 or 2. */
      readonly files: readonly PolicyFileKind[];
      /** Present only when `files` names both — whether their content was byte-identical (deduplicated) or differed (both included). */
      readonly identical?: boolean;
    }
  | { readonly directory: string; readonly state: 'absent' }
  | { readonly directory: string; readonly state: 'unavailable'; readonly reason: string };

/** Root-to-leaf chain for one changed path; `levels[0]` is always the repository root. */
export interface AgentsPolicyChain {
  memberId: string;
  baseSha: string;
  path: string;
  levels: readonly AgentsPolicyLevel[];
}

export interface AgentsPolicyResolver {
  resolveChain(member: AgentsPolicyMemberRef, changedPath: string): Promise<AgentsPolicyChain>;
}

/** Directory prefixes from the repository root (`''`) to the changed path's own parent directory, inclusive. */
export function ancestorDirectories(changedPath: string): string[] {
  const segments = changedPath.split('/').filter((segment) => segment !== '');
  const directories = segments.slice(0, -1);
  const prefixes: string[] = [''];
  for (let depth = 1; depth <= directories.length; depth += 1) {
    prefixes.push(directories.slice(0, depth).join('/'));
  }
  return prefixes;
}

function policyPathFor(directory: string, fileName: string): string {
  return directory === '' ? fileName : `${directory}/${fileName}`;
}

async function fetchFile(
  source: InvestigationSource | undefined,
  capabilities: InvestigationSourceCapabilities | undefined,
  member: AgentsPolicyMemberRef,
  directory: string,
  file: { readonly kind: PolicyFileKind; readonly name: string },
  maxLines: number,
): Promise<PolicyFileOutcome> {
  if (!source) {
    return { ...file, state: 'unavailable', reason: 'This review has no source that can read repository files.' };
  }
  if (capabilities && !capabilities.fileReads.supported) {
    return { ...file, state: 'unavailable', reason: 'This source does not support pinned file reads.' };
  }

  let result: FileRangeResult;
  try {
    result = await source.readFile({
      snapshot: { repoId: member.repoId, baseSha: member.baseSha, headSha: member.headSha },
      revision: 'base',
      path: policyPathFor(directory, file.name),
      startLine: 1,
      endLine: maxLines,
    });
  } catch (error) {
    return { ...file, state: 'unavailable', reason: error instanceof Error ? error.message : `${file.name} read failed.` };
  }

  if (result.state === 'notFound') return { ...file, state: 'absent' };
  // `complete` is the only state whose `value.text` is the whole file. `paginated`/`truncated` also
  // carry a `value.text`, but it is a prefix — `investigationResultValue` would return it just as
  // readily as a `complete` read's, and folding it into `present` here is exactly the bug this branch
  // exists to prevent: policy content is authoritative instruction (D7, file header above), so a
  // partial file silently digested as "present" would hand the model a policy framed as complete that
  // might omit the clause that mattered. Treated as `unavailable` instead — not a confirmed absence,
  // and not confirmed content either — so the honest "could not be checked" line and the
  // `rootPolicyUnavailable` limitation (`harnessRuntime.ts`) both fire exactly as they do for any other
  // read this resolver could not fully trust.
  if (result.state === 'paginated' || result.state === 'truncated') {
    return {
      ...file,
      state: 'unavailable',
      reason: `${file.name} exceeds the ${maxLines}-line read cap (state: "${result.state}"); a partial read cannot be treated as the complete policy.`,
    };
  }
  if (result.state !== 'complete') {
    return { ...file, state: 'unavailable', reason: `${file.name} read returned "${result.state}".` };
  }
  return { ...file, state: 'present', content: result.value.text };
}

/**
 * Combines one directory's two independent file outcomes into the single three-valued level the
 * rest of the harness reasons about. Any file present makes the level `present` — a level with one
 * readable file and one unreadable companion is still `present`, on the theory that "a policy was
 * found and applied" is the fact that matters operationally; it does not, on its own, push the
 * `harnessRuntime.ts` `selectionLimitations` entry that a level with *nothing* readable does (see
 * that call site's own doc comment) — the reviewer can already see, from the render naming exactly
 * which file(s) contributed, that the other file's status was never confirmed either way. Both
 * files absent is the only way to reach `absent`: a genuine "neither file exists here" fact the host
 * actually checked, not an assumption. Anything else — one or both unavailable, none present — folds
 * to `unavailable`, because "no policy" cannot be asserted when a check that could have found one
 * never completed.
 */
function combineLevel(directory: string, sourceId: string, agents: PolicyFileOutcome, claude: PolicyFileOutcome): AgentsPolicyLevel {
  const present = [agents, claude].filter((outcome): outcome is Extract<PolicyFileOutcome, { state: 'present' }> => outcome.state === 'present');
  if (present.length > 0) {
    const files = present.map((outcome) => outcome.kind);
    if (present.length === 1) {
      const only = present[0]!;
      return { directory, state: 'present', sourceId, digest: sha256Hex(only.content), content: only.content, citable: false, files };
    }
    const [first, second] = present as [Extract<PolicyFileOutcome, { state: 'present' }>, Extract<PolicyFileOutcome, { state: 'present' }>];
    const identical = first.content === second.content;
    const content = identical
      ? first.content
      : present.map((outcome) => `--- ${outcome.name} (${directory === '' ? 'repository root' : directory})\n${outcome.content}`).join('\n\n');
    return { directory, state: 'present', sourceId, digest: sha256Hex(content), content, citable: false, files, identical };
  }
  if (agents.state === 'absent' && claude.state === 'absent') return { directory, state: 'absent' };
  const reasons = [agents, claude]
    .filter((outcome): outcome is Extract<PolicyFileOutcome, { state: 'unavailable' }> => outcome.state === 'unavailable')
    .map((outcome) => outcome.reason);
  const distinctReasons = [...new Set(reasons)];
  return {
    directory,
    state: 'unavailable',
    reason: distinctReasons.length > 0 ? distinctReasons.join(' ') : 'AGENTS.md/CLAUDE.md could not be read.',
  };
}

/**
 * One resolver per harness attempt, shared across every changeset member —
 * `getSource` is looked up per member because a changeset can span different
 * repositories, each with its own object store (D15). Caches by
 * `(repoId, baseSha, directory)` so files sharing an ancestor directory
 * never refetch it, and caches the in-flight promise (not just the
 * resolved value) so two concurrent lookups of the same level share one
 * request.
 */
export function createAgentsPolicyResolver(
  getSource: (member: AgentsPolicyMemberRef) => InvestigationSource | undefined,
  options: { capabilities?: (member: AgentsPolicyMemberRef) => InvestigationSourceCapabilities | undefined; maxLinesPerFile?: number } = {},
): AgentsPolicyResolver {
  const maxLinesPerFile = options.maxLinesPerFile ?? DEFAULT_HARNESS_POLICY.diffOrFileReadPageLines;
  const cache = new Map<string, Promise<AgentsPolicyLevel>>();

  async function fetchLevel(member: AgentsPolicyMemberRef, directory: string): Promise<AgentsPolicyLevel> {
    const source = getSource(member);
    const capabilities = options.capabilities?.(member);
    const [agents, claude] = await Promise.all(
      POLICY_FILES.map((file) => fetchFile(source, capabilities, member, directory, file, maxLinesPerFile)),
    );
    const sourceId = `agents-policy:${member.baseSha}:${directory === '' ? '.' : directory}`;
    return combineLevel(directory, sourceId, agents!, claude!);
  }

  function cachedLevel(member: AgentsPolicyMemberRef, directory: string): Promise<AgentsPolicyLevel> {
    const cacheKey = `${member.repoId}\u0000${member.baseSha}\u0000${directory}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const promise = fetchLevel(member, directory);
    cache.set(cacheKey, promise);
    return promise;
  }

  return {
    async resolveChain(member, changedPath) {
      const levels = await Promise.all(
        ancestorDirectories(changedPath).map((directory) => cachedLevel(member, directory)),
      );
      return { memberId: member.memberId, baseSha: member.baseSha, path: changedPath, levels };
    },
  };
}

/** Ordered root-to-leaf composition of every present level's content — the "ordered policy composition" task 6.3 asks for. */
export function composeAgentsPolicyText(chain: AgentsPolicyChain): string | undefined {
  const present = chain.levels.filter(
    (level): level is Extract<AgentsPolicyLevel, { state: 'present' }> => level.state === 'present',
  );
  if (present.length === 0) return undefined;
  return present
    .map((level) => `--- policy (${level.directory === '' ? 'repository root' : level.directory})\n${level.content}`)
    .join('\n\n');
}

/**
 * Folds the chain's root level into the fixed task-2.2 snapshot shape, now carrying the composed
 * text alongside identity (the fix that lets root policy content reach the initial model
 * submission: `harnessAttempt.ts`'s `rootPoliciesFor` reads this field straight off the snapshot,
 * never re-fetching at bootstrap time, since `resolvePolicy` is not bootstrap-legal — see that
 * function's own doc comment).
 *
 * `unavailable` still folds to `present: false`, documented above — but no longer silently: an
 * `unavailable` root level's `reason` survives as `unavailableReason`, so a rendered "could not be
 * checked" line and a `harnessRuntime.ts` `selectionLimitations` entry are both possible downstream,
 * where a genuinely `absent` root (both files checked, neither exists) carries no reason at all and
 * renders as plain absence.
 */
export function rootAgentsPolicySourceFor(chain: AgentsPolicyChain): ReviewRunAgentsPolicySource {
  const root = chain.levels[0];
  if (root?.state === 'present') {
    return {
      present: true,
      sourceId: root.sourceId,
      digest: root.digest,
      text: root.content,
      files: root.files,
      ...(root.identical !== undefined ? { identical: root.identical } : {}),
    };
  }
  if (root?.state === 'unavailable') return { present: false, unavailableReason: root.reason };
  return { present: false };
}
