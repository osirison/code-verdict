/**
 * Base-revision `AGENTS.md` chain resolution (task 6.3 of
 * `add-agentic-review-harness`, design.md D7): walks repository root to a
 * changed file's own directory, reading `AGENTS.md` at each level through
 * the neutral `Connection.readFile` operation at the base SHA — never a
 * concrete provider, per docs/ARCHITECTURE.md's dependency rule.
 *
 * Every level's outcome is explicit and three-valued: `present` (with the
 * exact content and a digest), `absent` (the host actually read the
 * directory and there is no `AGENTS.md` there), or `unavailable` (the host
 * could not determine either way — capability withheld, connection has no
 * `readFile`, or the read itself failed). `ReviewRunAgentsPolicySource`
 * (task 2.2) only has two states, so `rootAgentsPolicySourceFor` folds
 * `unavailable` into `present: false` for the snapshot: asserting a policy
 * exists without being able to read it would be worse than reporting none,
 * and the richer three-state chain above remains available to whatever
 * calls this resolver directly (the task 9 `resolvePolicy` tool).
 *
 * Composed policy text is authoritative instruction, not evidence: D7 says
 * so explicitly ("Policy is authoritative instruction but remains
 * non-citable"), and task 6.4's bootstrap builder is what actually places it
 * on the authoritative side of the trust boundary. Non-citability itself is
 * enforced by the evidence ledger (task 7.4), not by this module.
 */
import { createHash } from 'node:crypto';
import type { Connection, ProviderCapabilities } from '../platform/provider';
import { investigationResultValue, type FileRangeResult } from '../platform/types';
import { DEFAULT_HARNESS_POLICY } from '../domain/harnessPolicy';
import type { ReviewRunAgentsPolicySource } from '../domain/reviewRunSnapshot';

export interface AgentsPolicyMemberRef {
  memberId: string;
  repoId: string;
  baseSha: string;
  headSha: string;
}

export type AgentsPolicyLevel =
  | {
      readonly directory: string;
      readonly state: 'present';
      readonly sourceId: string;
      readonly digest: string;
      readonly content: string;
      /** Always `false`: D7/review-evidence-ledger classify `AGENTS.md` policy as authoritative instruction but never citable evidence. */
      readonly citable: false;
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

function agentsMdPathFor(directory: string): string {
  return directory === '' ? 'AGENTS.md' : `${directory}/AGENTS.md`;
}

async function fetchLevel(
  connection: Connection,
  capabilities: ProviderCapabilities | undefined,
  member: AgentsPolicyMemberRef,
  directory: string,
  maxLines: number,
): Promise<AgentsPolicyLevel> {
  if (capabilities?.reviewInvestigation && !capabilities.reviewInvestigation.fileReads.supported) {
    return { directory, state: 'unavailable', reason: 'This provider does not support pinned file reads.' };
  }
  if (!connection.readFile) {
    return { directory, state: 'unavailable', reason: 'This connection cannot read repository files.' };
  }

  let result: FileRangeResult;
  try {
    result = await connection.readFile({
      snapshot: { repoId: member.repoId, baseSha: member.baseSha, headSha: member.headSha },
      revision: 'base',
      path: agentsMdPathFor(directory),
      startLine: 1,
      endLine: maxLines,
    });
  } catch (error) {
    return { directory, state: 'unavailable', reason: error instanceof Error ? error.message : 'AGENTS.md read failed.' };
  }

  if (result.state === 'notFound') return { directory, state: 'absent' };
  const content = investigationResultValue(result)?.text;
  if (content === undefined) {
    return { directory, state: 'unavailable', reason: `AGENTS.md read returned "${result.state}".` };
  }

  // Digested with the same sha256-hex primitive the snapshot builder uses (task 6.1) — no separate hashing convention.
  const digest = createHash('sha256').update(content, 'utf8').digest('hex');
  return {
    directory,
    state: 'present',
    sourceId: `agents-policy:${member.baseSha}:${directory === '' ? '.' : directory}`,
    digest,
    content,
    citable: false,
  };
}

/**
 * One resolver per harness attempt, shared across every changeset member —
 * `getConnection` is looked up per member because a changeset can span
 * different repositories on different provider instances (D15). Caches by
 * `(repoId, baseSha, directory)` so files sharing an ancestor directory
 * never refetch it, and caches the in-flight promise (not just the
 * resolved value) so two concurrent lookups of the same level share one
 * request.
 */
export function createAgentsPolicyResolver(
  getConnection: (member: AgentsPolicyMemberRef) => Connection,
  options: { capabilities?: (member: AgentsPolicyMemberRef) => ProviderCapabilities | undefined; maxLinesPerFile?: number } = {},
): AgentsPolicyResolver {
  const maxLinesPerFile = options.maxLinesPerFile ?? DEFAULT_HARNESS_POLICY.diffOrFileReadPageLines;
  const cache = new Map<string, Promise<AgentsPolicyLevel>>();

  function cachedLevel(member: AgentsPolicyMemberRef, directory: string): Promise<AgentsPolicyLevel> {
    const cacheKey = `${member.repoId}\u0000${member.baseSha}\u0000${directory}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const promise = fetchLevel(getConnection(member), options.capabilities?.(member), member, directory, maxLinesPerFile);
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
    .map((level) => `--- AGENTS.md (${level.directory === '' ? 'repository root' : level.directory})\n${level.content}`)
    .join('\n\n');
}

/**
 * Folds the chain's root level into the fixed task-2.2 snapshot shape.
 * `unavailable` folds to `present: false`, documented above.
 */
export function rootAgentsPolicySourceFor(chain: AgentsPolicyChain): ReviewRunAgentsPolicySource {
  const root = chain.levels[0];
  if (root?.state === 'present') return { present: true, sourceId: root.sourceId, digest: root.digest };
  return { present: false };
}
