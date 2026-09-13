import { describe, expect, it } from 'vitest';
import { isRunPhase } from './harnessActivity';
import { HOST_TOOL_CATALOG } from './harnessBootstrap';
import {
  HARNESS_TOOL_CONTRACT_VERSION,
  HOST_TOOL_DEFINITIONS,
  HOST_TOOL_NAMES,
  hostToolDefinition,
  isHostToolName,
  type HostToolName,
} from './harnessTools';

describe('HOST_TOOL_NAMES / HOST_TOOL_DEFINITIONS (task 9.1)', () => {
  it('declares exactly the ten D6 tools, in the design table order', () => {
    expect(HOST_TOOL_NAMES).toEqual([
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
    ]);
  });

  it('has exactly one definition per catalog name, and every definition names a real catalog tool', () => {
    expect(HOST_TOOL_DEFINITIONS).toHaveLength(HOST_TOOL_NAMES.length);
    expect(HOST_TOOL_DEFINITIONS.map((definition) => definition.name).sort()).toEqual([...HOST_TOOL_NAMES].sort());
    const seen = new Set<string>();
    for (const definition of HOST_TOOL_DEFINITIONS) {
      expect(seen.has(definition.name)).toBe(false);
      seen.add(definition.name);
    }
  });

  it('gives every definition a non-empty requiredScope and description', () => {
    for (const definition of HOST_TOOL_DEFINITIONS) {
      expect(definition.requiredScope.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  it('bounds every allowedPhases entry to a real RunPhase, and forbids persisting for every tool', () => {
    for (const definition of HOST_TOOL_DEFINITIONS) {
      expect(definition.allowedPhases.length).toBeGreaterThan(0);
      for (const phase of definition.allowedPhases) {
        expect(isRunPhase(phase)).toBe(true);
        expect(phase).not.toBe('persisting');
      }
    }
  });

  it('marks the eight provider-touching tools providerRead and the two submission tools hostAction', () => {
    const providerRead = new Set([
      'listChangedFiles',
      'readDiff',
      'readFile',
      'searchRepository',
      'searchDiff',
      'resolvePolicy',
      'getChangeRequestDetails',
      'getIssueDetails',
    ]);
    for (const definition of HOST_TOOL_DEFINITIONS) {
      expect(definition.kind).toBe(providerRead.has(definition.name) ? 'providerRead' : 'hostAction');
    }
  });

  it('declares a connectionMethod for every providerRead tool, including resolvePolicy, and none for host actions', () => {
    for (const definition of HOST_TOOL_DEFINITIONS) {
      if (definition.kind === 'providerRead') expect(definition.connectionMethod).toBeDefined();
      else expect(definition.connectionMethod).toBeUndefined();
    }
    expect(hostToolDefinition('resolvePolicy')?.connectionMethod).toBe('readFile');
  });

  it('leaves resolvePolicy, submitCandidateFinding, and requestCompletion without a declared ReviewInvestigationCapabilities key', () => {
    expect(hostToolDefinition('resolvePolicy')?.capability).toBeUndefined();
    expect(hostToolDefinition('submitCandidateFinding')?.capability).toBeUndefined();
    expect(hostToolDefinition('requestCompletion')?.capability).toBeUndefined();
    expect(hostToolDefinition('readFile')?.capability).toBe('fileReads');
  });

  it('declares submitCandidateFinding and every provider read idempotent, and requestCompletion not idempotent (D12)', () => {
    for (const definition of HOST_TOOL_DEFINITIONS) {
      expect(definition.idempotent).toBe(definition.name !== 'requestCompletion');
    }
  });

  it('allows listChangedFiles and the two detail tools in bootstrap; nothing else', () => {
    for (const definition of HOST_TOOL_DEFINITIONS) {
      const allowsBootstrap = definition.allowedPhases.includes('bootstrap');
      const shouldAllowBootstrap = ['listChangedFiles', 'getChangeRequestDetails', 'getIssueDetails'].includes(definition.name);
      expect(allowsBootstrap).toBe(shouldAllowBootstrap);
    }
  });

  it('allows submitCandidateFinding only in investigating/verifying, and requestCompletion only in verifying/completing', () => {
    expect(hostToolDefinition('submitCandidateFinding')?.allowedPhases).toEqual(['investigating', 'verifying']);
    expect(hostToolDefinition('requestCompletion')?.allowedPhases).toEqual(['verifying', 'completing']);
  });

  it('pins the tool contract version to "1"', () => {
    expect(HARNESS_TOOL_CONTRACT_VERSION).toBe('1');
  });
});

describe('hostToolDefinition / isHostToolName fail closed on unknown input', () => {
  it('resolves every declared name', () => {
    for (const name of HOST_TOOL_NAMES) {
      expect(hostToolDefinition(name)?.name).toBe(name);
      expect(isHostToolName(name)).toBe(true);
    }
  });

  it.each([undefined, null, 42, {}, [], '', 'deleteRepository', 'listchangedfiles'])(
    'refuses unknown or malformed input %p rather than guessing',
    (value) => {
      expect(hostToolDefinition(value)).toBeUndefined();
      expect(isHostToolName(value)).toBe(false);
    },
  );

  it('narrows to HostToolName only for a recognized string (compile-time sanity, exercised at runtime)', () => {
    const candidate: unknown = 'readDiff';
    if (isHostToolName(candidate)) {
      const narrowed: HostToolName = candidate;
      expect(narrowed).toBe('readDiff');
    } else {
      throw new Error('expected readDiff to be recognized');
    }
  });
});

describe('derived bootstrap catalog (task 9.1 replaces the placeholder in harnessBootstrap.ts)', () => {
  it('still matches the ten D6 tools, in order, projected to name/requiredScope/description', () => {
    expect(HOST_TOOL_CATALOG.map((tool) => tool.name)).toEqual([...HOST_TOOL_NAMES]);
    expect(HOST_TOOL_CATALOG).toEqual(
      HOST_TOOL_DEFINITIONS.map((definition) => ({
        name: definition.name,
        requiredScope: definition.requiredScope,
        description: definition.description,
      })),
    );
  });
});
