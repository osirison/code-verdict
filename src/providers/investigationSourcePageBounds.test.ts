/**
 * Every shipped investigation source's *declared* page bound must fit the
 * default harness policy.
 *
 * This is the check that was missing when diff search shipped dead.
 * `harnessToolDispatcher.ts`'s `pageBoundWithinPolicy` refuses a tool outright
 * when the declared bound exceeds the policy field that tool pages against —
 * and an operation that declares no per-operation bound falls back to
 * `pagination.maxPageSize`. Both shipped providers set that fallback to their
 * *manifest* page size (100 files) while `searchResultPageMatches` is 50
 * *matches*, so every `searchDiff` (and, on GitLab, every `searchRepository`)
 * call was refused with `outOfBounds` from the first release onward. A live
 * review of a 2-file dependency bump spent 26 model turns and 9 minutes
 * re-reading the same two diffs because its 7 attempts to search them were all
 * refused.
 *
 * **It checks sources now, not providers.** The two providers it used to check
 * declare no paging operations at all any more — the five that page are the
 * investigation source's, and a provider answers none of them. The shipped
 * sources are the local git one and the demo pod's sample data, and the failure
 * this file exists to prevent is theirs to make now.
 *
 * The harness fixtures never caught the original bug: they declare correct
 * bounds of their own, so they exercised the dispatcher against a source the
 * real ones do not resemble. This file tests the shipped declarations
 * themselves, against the real `DEFAULT_HARNESS_POLICY`.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_HARNESS_POLICY } from '../domain/harnessPolicy';
import { HOST_TOOL_DEFINITIONS } from '../domain/harnessTools';
import { LOCAL_GIT_INVESTIGATION_CAPABILITIES } from '../localgit/localGitSource';
import { DEMO_INVESTIGATION_CAPABILITIES } from './fixture/demoInvestigationSource';
import type { InvestigationOperationCapability, InvestigationSourceCapabilities } from '../platform/types';

const SOURCES: readonly { id: string; capabilities: InvestigationSourceCapabilities }[] = [
  { id: 'localGit', capabilities: LOCAL_GIT_INVESTIGATION_CAPABILITIES },
  { id: 'sample', capabilities: DEMO_INVESTIGATION_CAPABILITIES },
];

/**
 * Only tools that page, and only those a source answers. A tool declared
 * unsupported is withheld from the catalog entirely, which is a deliberate,
 * honest "no" and not the silent always-refuse this file exists to prevent.
 */
const PAGING_TOOLS = HOST_TOOL_DEFINITIONS.filter(
  (tool) =>
    tool.pageSizePolicyField !== undefined &&
    tool.capability !== undefined &&
    tool.capability !== 'changeRequestDetails' &&
    tool.capability !== 'issueDetails',
);

function operationOf(capabilities: InvestigationSourceCapabilities, key: string): InvestigationOperationCapability | undefined {
  return (capabilities as unknown as Record<string, InvestigationOperationCapability | undefined>)[key];
}

describe('shipped investigation source page bounds fit the default harness policy', () => {
  for (const source of SOURCES) {
    for (const tool of PAGING_TOOLS) {
      const operation = operationOf(source.capabilities, tool.capability!);
      const available = operation?.supported === true;
      it(`${source.id}: ${tool.name} is ${available ? 'usable, not refused on every call' : 'withheld rather than always-refused'}`, () => {
        if (!available) return;
        const maxPageSize = operation?.pageBound?.maxPageSize ?? source.capabilities.pagination.maxPageSize;
        expect(maxPageSize).toBeLessThanOrEqual(DEFAULT_HARNESS_POLICY[tool.pageSizePolicyField!]);
      });
    }
  }

  /**
   * A declared byte bound is a promise about the largest page the source will
   * ever return. If it exceeds what the attempt will accept, every large read
   * becomes a budget refusal the model cannot act on — the same shape of
   * unactionable "no" that turned diff search into a nine-minute loop.
   */
  it('every declared page byte bound fits what a single tool result may carry', () => {
    for (const source of SOURCES) {
      for (const tool of PAGING_TOOLS) {
        const operation = operationOf(source.capabilities, tool.capability!);
        if (operation?.supported !== true) continue;
        const declared = operation.pageBound?.maxPageBytes;
        if (declared === undefined) continue;
        expect({ source: source.id, tool: tool.name, declared }).toEqual({
          source: source.id,
          tool: tool.name,
          declared: Math.min(declared, DEFAULT_HARNESS_POLICY.maxToolResultBytes, DEFAULT_HARNESS_POLICY.diffOrFileReadPageBytes),
        });
      }
    }
  });

  /**
   * Reads page in *lines*, whose individual size a source cannot predict, so a
   * line bound generous enough to return a whole file is only safe alongside a
   * byte bound.
   */
  it('every read operation whose line bound could exceed the byte ceiling declares one', () => {
    const offenders: string[] = [];
    for (const source of SOURCES) {
      for (const tool of PAGING_TOOLS) {
        if (tool.pageSizePolicyField !== 'diffOrFileReadPageLines') continue;
        const operation = operationOf(source.capabilities, tool.capability!);
        if (operation?.supported !== true) continue;
        if (operation.pageBound?.maxPageBytes === undefined) offenders.push(`${source.id}:${tool.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no supported paging operation relies on the shared pagination fallback for a different unit', () => {
    // The fallback is a *manifest* page size. Any tool paging against a
    // different policy field must declare its own bound rather than inherit a
    // number measured in another unit.
    const offenders: string[] = [];
    for (const source of SOURCES) {
      for (const tool of PAGING_TOOLS) {
        if (tool.pageSizePolicyField === 'manifestPageSize') continue;
        const operation = operationOf(source.capabilities, tool.capability!);
        if (operation?.supported !== true) continue;
        if (operation.pageBound?.maxPageSize === undefined) offenders.push(`${source.id}:${tool.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
