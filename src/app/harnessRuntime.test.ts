import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { checkCheckpointIntegrity } from './harnessResume';
import { computeSnapshotDigest } from './harnessCheckpoint';
import { createHarnessRunStore, type HarnessRunStore } from './harnessRunStore';
import { CONTRADICTION_CHECK_MARKER } from './harnessSynthesisVerification';
import { createReviewHarnessFactory, type HarnessRuntimeDeps } from './harnessRuntime';
import { BUILTIN_AGENT_DESCRIPTOR } from './agents';
import { DEFAULT_CONTEXT_BUDGETS } from './reviewContext';
import { ReviewRunManager, type CrRunTarget, type RunInput, type RunRecord } from './reviewRunManager';
import { clearProviders, registerProvider } from '../platform/registry';
import type { KeyValueStore } from './storage';
import type { Connection, ProviderCapabilities, ScmProvider } from '../platform/provider';

// ---- Fixture identity: the harness snapshot's own member-key formula, mirrored here ----

const REPO_ID = 'repo-e2e';
const CR_NUMBER = '101';
const BASE_SHA = 'base-e2e-1';
const HEAD_SHA = 'head-e2e-1';
const FILE_PATH = 'src/a.ts';
const MEMBER_ID = `${REPO_ID}!${CR_NUMBER}`;
const PROVIDER_ID = 'fake-e2e-provider';
const POD_ID = 'pod-e2e-1';

// ---- Fakes: a Connection, a provider, a pod store, a model turn — no fixture provider ----

function notImplemented(): never {
  throw new Error('not implemented in this fake connection');
}

function fakeConnection(methods: Partial<Connection>): Connection {
  return {
    testConnection: notImplemented,
    resolveSource: notImplemented,
    listGroupRepositories: notImplemented,
    getRepository: notImplemented,
    listOpenChangeRequests: notImplemented,
    listWorkItems: notImplemented,
    listCiRuns: notImplemented,
    getChangeRequestDiff: notImplemented,
    submitReview: notImplemented,
    listThreads: notImplemented,
    resolveThread: notImplemented,
    replyToThread: notImplemented,
    approve: notImplemented,
    ...methods,
  };
}

function e2eConnection(): Connection {
  return fakeConnection({
    getChangeRequestDetails: async (request) => ({
      snapshot: request.snapshot,
      state: 'complete',
      value: { title: 'A small end-to-end change', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] },
    }),
    listChangedFiles: async (request) => ({
      snapshot: request.snapshot,
      state: 'complete',
      value: [{ path: FILE_PATH, kind: 'modified', binary: false, addedLines: 3, removedLines: 1, byteSize: 120 }],
    }),
    readDiff: async (request) => ({
      snapshot: request.snapshot,
      state: 'complete',
      value: {
        path: request.path,
        patch: '@@ -1,1 +1,1 @@\n-old\n+new\n',
        positions: [{ path: request.path, side: 'new', line: 1, endLine: 1 }],
      },
    }),
    readFile: async (request) => ({ snapshot: request.snapshot, state: 'notFound', reason: 'no such file in this fixture' }),
    getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
  });
}

function e2eCapabilities(): ProviderCapabilities {
  const supported = { supported: true, pageBound: { maxPageSize: 100 } };
  return {
    suggestions: false,
    approvals: false,
    requestChanges: false,
    threadResolution: false,
    groupHierarchy: false,
    batchedReview: false,
    reviewInvestigation: {
      manifests: supported,
      diffReads: supported,
      fileReads: supported,
      repositorySearch: supported,
      diffSearch: supported,
      changeRequestDetails: supported,
      issueDetails: supported,
      pagination: { maxPageSize: 100 },
    },
  };
}

function fakePodStore() {
  return {
    list: () => [
      {
        id: POD_ID,
        name: 'E2E pod',
        providerId: PROVIDER_ID,
        instanceUrl: 'https://example.test',
        sources: [],
        authMode: 'none' as const,
      },
    ],
  };
}

function registerFakeProvider(connection: Connection): void {
  const provider: ScmProvider = {
    id: PROVIDER_ID,
    displayName: 'Fake E2E',
    capabilities: e2eCapabilities(),
    vocabulary: {} as ScmProvider['vocabulary'],
    host: {} as ScmProvider['host'],
    authModesFor: () => ['none'],
    connect: () => connection,
  } as unknown as ScmProvider;
  registerProvider(provider);
}

const fakeSecrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };

/**
 * A scripted "model" driven entirely by the *real rendered prompt text*
 * (`./harnessModelSeam.ts`'s `renderModelPrompt`, via `createLiveModelSeam`)
 * — never a hand-built `HarnessModelSeam`. Extracting the prior turn's
 * `sourceId`/`digest` straight out of the rendered prompt (rather than
 * hardcoding one) is what proves the model is actually told the evidence
 * source's identifier by the real seam, not by test scaffolding.
 */
function scriptedRunTurn(): (modelId: string, prompt: string) => Promise<string> {
  let investigatingCalls = 0;
  return async (_modelId: string, prompt: string) => {
    if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) {
      const match = /candidateId: (\S+)/.exec(prompt);
      return JSON.stringify({ candidateId: match?.[1] ?? 'unknown', contradicted: false });
    }
    const phase = /You are in the "(\w+)" phase/.exec(prompt)?.[1];
    if (phase === 'planning') {
      return JSON.stringify({ messages: [{ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate the changed file.' }] }] });
    }
    if (phase === 'investigating') {
      investigatingCalls += 1;
      if (investigatingCalls === 1) {
        return JSON.stringify({
          messages: [
            {
              kind: 'toolRequest',
              tool: 'readDiff',
              memberId: MEMBER_ID,
              request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: FILE_PATH },
            },
          ],
        });
      }
      if (investigatingCalls === 2) {
        const citation = /sourceId=(\S+) digest=(\S+)/.exec(prompt);
        if (!citation) throw new Error('test model: expected a citable prior tool result in the rendered prompt');
        return JSON.stringify({
          messages: [
            {
              kind: 'candidateSubmission',
              candidate: {
                candidateId: 'cand-1',
                memberId: MEMBER_ID,
                file: FILE_PATH,
                line: 1,
                endLine: 1,
                severity: 'major',
                category: 'errorHandling',
                confidence: 90,
                title: 'Issue found during investigation',
                body: 'A real issue found in the changed file.',
                citations: { primary: { sourceId: citation[1], digest: citation[2], path: FILE_PATH, range: { startLine: 1, endLine: 1 } } },
              },
            },
          ],
        });
      }
      return JSON.stringify({ messages: [{ kind: 'publicRationale', rationale: 'Investigation is complete.' }] });
    }
    if (phase === 'verifying') {
      return JSON.stringify({ messages: [{ kind: 'completionRequest', rationale: 'Coverage looks complete.' }] });
    }
    throw new Error(`test model: unexpected turn — phase "${phase ?? 'unknown'}", prompt starts: ${prompt.slice(0, 120)}`);
  };
}

function jsonMemoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => (map.has(key) ? (JSON.parse(JSON.stringify(map.get(key))) as T) : undefined),
    update: async (key: string, value: unknown) => {
      if (value === undefined) {
        map.delete(key);
        return;
      }
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    keys: () => [...map.keys()],
  };
}

function runInput(overrides: Partial<RunInput> = {}): RunInput {
  const target: CrRunTarget = {
    kind: 'cr',
    ref: { repoId: REPO_ID, number: CR_NUMBER },
    diff: {
      ref: { repoId: REPO_ID, number: CR_NUMBER },
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      files: [{ oldPath: FILE_PATH, newPath: FILE_PATH, diff: '@@ -1,1 +1,1 @@\n-old\n+new\n' }],
      anchorRefs: {},
    },
  };
  return {
    target,
    refLabel: `!${CR_NUMBER}`,
    podId: POD_ID,
    criteria: DEFAULT_CRITERIA,
    agent: BUILTIN_AGENT_DESCRIPTOR,
    agentLabel: BUILTIN_AGENT_DESCRIPTOR.label,
    modelId: 'lm:test/test-model',
    effort: 'none',
    timeouts: { inactivityMs: 0, ceilingMs: 0 },
    contextBudgets: DEFAULT_CONTEXT_BUDGETS,
    steps: [],
    demo: false,
    ...overrides,
  };
}

function noopRunOptions(identity: { runId: string; lineageId: string; attempt: number }) {
  return {
    identity,
    timeouts: { inactivityMs: 0, ceilingMs: 0 },
    onProgress: () => {},
    onAttachmentWarnings: () => {},
    cancellation: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
    onCheckpoint: () => {},
  };
}

let harnessRunStore: HarnessRunStore;
let store: KeyValueStore;
let connection: Connection;
let deps: HarnessRuntimeDeps;

beforeEach(() => {
  clearProviders();
  connection = e2eConnection();
  registerFakeProvider(connection);
  store = jsonMemoryStore();
  harnessRunStore = createHarnessRunStore(store, { now: () => Date.parse('2026-09-04T00:00:00.000Z') });
  deps = {
    podStore: fakePodStore() as unknown as HarnessRuntimeDeps['podStore'],
    secrets: fakeSecrets,
    discoverModel: async (modelId: string) => ({ id: modelId, label: 'Test model', description: '', vendor: 'test', family: 'test-model', maxInputTokens: undefined }),
    countTokens: async () => undefined,
    runTurn: scriptedRunTurn(),
    revalidateAttachments: async (attachments) => ({ attachments: [...attachments], warnings: [] }),
    harnessRunStore,
  };
});

afterEach(() => {
  clearProviders();
});

describe('createReviewHarnessFactory — the real runtime wiring (task 15.7)', () => {
  it('runs a real review through typed turns against a fake Connection and fake model, dispatches tools, registers evidence, evaluates completion, writes a checkpoint, and reaches a terminal outcome', async () => {
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-e2e-1', lineageId: 'lineage-e2e-1', attempt: 1 };
    const attempt = factory.create(runInput(), noopRunOptions(identity));

    const result = await attempt.run();

    expect(result.lifecycle).toBe('succeeded');
    expect(result.outcome.completeness).toBe('complete');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.item.file).toBe(FILE_PATH);

    // The snapshot and at least one checkpoint were actually persisted to the store — not just
    // reported to the manager through `onCheckpoint`'s reporting-only callback.
    const storedSnapshot = harnessRunStore.readSnapshot(identity.lineageId as never, identity.attempt as never);
    expect(storedSnapshot).toBeDefined();
    const checkpoints = harnessRunStore.checkpointsFor(identity.lineageId as never);
    expect(checkpoints.length).toBeGreaterThan(0);

    // A checkpoint written on the live path is readable by the store and accepted by the resume
    // compatibility check.
    const latest = harnessRunStore.latestCheckpoint(identity.lineageId as never)!;
    expect(checkCheckpointIntegrity(storedSnapshot!, latest)).toEqual([]);
    expect(latest.snapshotDigest).toBe(computeSnapshotDigest(storedSnapshot!));
  });

  it('fails truthfully with no fallback when the selected model is no longer available', async () => {
    const missingModelDeps: HarnessRuntimeDeps = { ...deps, discoverModel: async () => undefined };
    const factory = createReviewHarnessFactory(missingModelDeps);
    const identity = { runId: 'run-e2e-2', lineageId: 'lineage-e2e-2', attempt: 1 };
    const attempt = factory.create(runInput(), noopRunOptions(identity));

    await expect(attempt.run()).rejects.toThrow(/no longer available/);
  });

  it('fails truthfully with no fallback when the model itself rejects (a refusing/unavailable model)', async () => {
    const refusing: HarnessRuntimeDeps = {
      ...deps,
      runTurn: async () => {
        throw new Error('Model test-model is no longer available');
      },
    };
    const factory = createReviewHarnessFactory(refusing);
    const identity = { runId: 'run-e2e-3', lineageId: 'lineage-e2e-3', attempt: 1 };
    const attempt = factory.create(runInput(), noopRunOptions(identity));

    await expect(attempt.run()).rejects.toThrow(/no longer available/);
  });
});

describe('ReviewRunManager driven by the real harness factory (task 10.2/10.8)', () => {
  it('a triggered review genuinely goes through phase-specific typed turns end to end and settles as a succeeded, complete RunRecord', async () => {
    const factory = createReviewHarnessFactory(deps);
    const globalState = jsonMemoryStore();
    const workspaceState = jsonMemoryStore();
    const manager = new ReviewRunManager({ workspaceState, globalState, runners: factory });

    const record = manager.trigger(runInput(), 1);
    expect(record.lifecycle === 'queued' || record.lifecycle === 'planning').toBe(true);

    const settled = await new Promise<RunRecord>((resolve) => {
      const subscription = manager.subscribe((next) => {
        if (next.key !== record.key) return;
        if (next.lifecycle === 'succeeded' || next.lifecycle === 'failed' || next.lifecycle === 'cancelled') {
          subscription.dispose();
          resolve(next);
        }
      });
    });

    expect(settled.lifecycle).toBe('succeeded');
    expect(settled.completeness).toBe('complete');
    expect(settled.response?.items).toHaveLength(1);
    expect(settled.response?.items[0]?.file).toBe(FILE_PATH);
  });
});
