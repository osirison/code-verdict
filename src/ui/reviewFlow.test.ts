import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Pod } from '../domain/types';
import type { ScmProvider } from '../platform/provider';
import type { ChangeRequestRef } from '../platform/types';
import { clearProviders, registerProvider } from '../platform/registry';
import { GITHUB_VOCABULARY } from '../testing/specFixtures';
import type { PodStore } from '../app/pods';
import type { ReviewRunManager } from '../app/reviewRunManager';
import type { KeyValueStore, SecretStore } from '../app/storage';

interface RenderSnapshot {
  title: string;
  autoContextLabels: string[];
  attachmentIds: string[];
  unresolvedReferences: string[];
}

const harness = vi.hoisted(() => ({
  message: undefined as ((message: unknown) => void) | undefined,
  leave: undefined as (() => void) | undefined,
  rendered: [] as RenderSnapshot[],
  findReferenceFile: vi.fn(),
  resolveAttachment: vi.fn(),
  loadAgentSelection: vi.fn(),
  discoverModels: vi.fn(),
  trigger: vi.fn(),
}));

const panel = vi.hoisted(() => ({
  active: true,
  title: '',
  onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
}));

const route = vi.hoisted(() => ({
  panel,
  onMessage: vi.fn((handler: (message: unknown) => void) => { harness.message = handler; }),
  onLeave: vi.fn((handler: () => void) => { harness.leave = handler; }),
  onReload: vi.fn(),
  setHtml: vi.fn(),
  postRegions: vi.fn(() => false),
}));

vi.mock('vscode', () => ({
  commands: { executeCommand: vi.fn() },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    onDidChangeConfiguration: () => ({ dispose: vi.fn() }),
  },
  window: {
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
}));

vi.mock('./appSurface', () => ({
  AppSurface: {
    show: vi.fn(() => route),
    reveal: vi.fn(),
  },
}));

vi.mock('./agentRefresh', () => ({
  loadAgentSelection: harness.loadAgentSelection,
  watchAgentSources: vi.fn(() => []),
}));

vi.mock('../app/lmAgent', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, discoverModels: harness.discoverModels };
});

vi.mock('../app/connections', () => ({
  connectionForPod: vi.fn(async () => ({
    listOpenChangeRequests: async () => [changeRequest('1', 'Change A'), changeRequest('2', 'Change B')],
    getChangeRequestDiff: async (ref: ChangeRequestRef) => ({
      ref,
      headSha: `head-${ref.number}`,
      files: [],
      anchorRefs: {},
    }),
    listWorkItems: async () => [],
  })),
}));

vi.mock('./contextAttachmentPicker', () => ({
  attachmentFileTarget: vi.fn(),
  attachmentRange: vi.fn(),
  findReferenceFile: harness.findReferenceFile,
  modelVisibleWorkspaceRoots: vi.fn(() => []),
  pickContextAttachment: vi.fn(),
}));

vi.mock('../app/attachments', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveAttachment: harness.resolveAttachment };
});

vi.mock('./reviewFlowHtml', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const capture = (state: {
    header: { title: string };
    autoContextItems: Array<{ label: string }>;
    attachments: Array<{ id: string }>;
    unresolvedContextReferences: string[];
  }): string => {
    harness.rendered.push({
      title: state.header.title,
      autoContextLabels: state.autoContextItems.map((item) => item.label),
      attachmentIds: state.attachments.map((item) => item.id),
      unresolvedReferences: [...state.unresolvedContextReferences],
    });
    return '';
  };
  return {
    ...actual,
    renderReviewFlowBody: capture,
    renderReviewFlowHtml: capture,
    renderReviewFlowLoadingHtml: vi.fn(() => ''),
    renderReviewFlowErrorHtml: vi.fn(() => ''),
    reviewFlowCrumb: vi.fn(() => ''),
  };
});

const PROVIDER = {
  id: 'test',
  displayName: 'Test provider',
  vocabulary: GITHUB_VOCABULARY,
  capabilities: { requestChanges: true },
  authModesFor: () => ['token'],
  connect: () => { throw new Error('connectionForPod is mocked'); },
} as unknown as ScmProvider;

function changeRequest(number: string, title: string) {
  return {
    ref: { repoId: 'acme/repo', number },
    title,
    description: `${title} context`,
    state: 'open' as const,
    sourceBranch: `feature-${number}`,
    targetBranch: 'main',
    author: { username: 'author' },
    reviewers: [],
    webUrl: `https://example.test/pulls/${number}`,
    updatedAt: '2026-09-03T12:00:00Z',
    headSha: `head-${number}`,
  };
}

function pod(): Pod {
  return {
    id: 'pod-1',
    name: 'Test pod',
    providerId: 'test',
    instanceUrl: 'https://example.test',
    sources: [{ kind: 'repository', repoId: 'acme/repo' }],
    criteria: { ...DEFAULT_CRITERIA },
    agentId: 'demo',
    repos: [{ id: 'acme/repo', path: 'acme/repo', name: 'repo' }],
  };
}

function demoSelection() {
  return {
    agents: [{
      id: 'demo',
      label: 'Demo review',
      description: 'Deterministic test agent',
      source: 'demo' as const,
      instructions: '',
    }],
    models: [],
    skippedAgents: [],
    agentId: 'demo',
    modelId: undefined,
    selectionNotices: [],
  };
}

const MODEL = {
  id: 'lm:test/reviewer',
  label: 'Test reviewer',
  description: 'Test model',
  vendor: 'test',
  family: 'reviewer',
};

function modelSelection() {
  return {
    agents: [{
      id: 'agent:test',
      label: 'Test agent',
      description: 'Model-backed test agent',
      source: 'builtin' as const,
      instructions: 'Review the change.',
    }],
    models: [MODEL],
    skippedAgents: [],
    agentId: 'agent:test',
    modelId: MODEL.id,
    selectionNotices: [],
  };
}

describe('ReviewFlowPanel Run preparation', () => {
  beforeEach(() => {
    clearProviders();
    registerProvider(PROVIDER);
    harness.message = undefined;
    harness.leave = undefined;
    harness.rendered = [];
    harness.findReferenceFile.mockReset().mockResolvedValue(undefined);
    harness.resolveAttachment.mockReset().mockResolvedValue({
      id: 'old-a-reference',
      kind: 'file',
      label: 'a.ts',
      path: 'a.ts',
      content: 'old A context',
    });
    harness.loadAgentSelection.mockReset().mockResolvedValue(demoSelection());
    harness.discoverModels.mockReset().mockResolvedValue([]);
    harness.trigger.mockReset();
  });

  afterEach(() => {
    harness.leave?.();
    clearProviders();
  });

  it('drops delayed A reference preparation after navigating to B', async () => {
    const activePod = pod();
    const upsert = vi.fn(async () => undefined);
    const deps = {
      podStore: { activePod, upsert } as unknown as PodStore,
      secrets: {} as SecretStore,
      workspaceState: { get: () => undefined, update: async () => undefined } as KeyValueStore,
      globalState: { get: () => undefined, update: async () => undefined } as KeyValueStore,
      runs: {
        get: vi.fn(() => undefined),
        subscribe: vi.fn(() => ({ dispose: vi.fn() })),
        trigger: harness.trigger,
      } as unknown as ReviewRunManager,
    };
    const { ReviewFlowPanel } = await import('./reviewFlow.js');

    await ReviewFlowPanel.open(deps, { repoId: 'acme/repo', number: '1' });
    activePod.criteria.extraInstructions = 'Review #file:a.ts';
    let releaseOldReference!: (target: { uri: unknown; workspaceFolder: unknown; relativePath: string }) => void;
    harness.findReferenceFile.mockImplementationOnce(() => new Promise((resolve) => {
      releaseOldReference = resolve;
    }));

    harness.message?.({ type: 'run' });
    await vi.waitFor(() => expect(releaseOldReference).toBeTypeOf('function'));

    await ReviewFlowPanel.open(deps, { repoId: 'acme/repo', number: '2' });
    const beforeOldResolution = harness.rendered.at(-1);
    expect(beforeOldResolution).toEqual({
      title: 'Change B',
      autoContextLabels: ['Title · Change B', 'Change request description'],
      attachmentIds: [],
      unresolvedReferences: ['#file:a.ts'],
    });

    releaseOldReference({ uri: {}, workspaceFolder: {}, relativePath: 'a.ts' });
    await vi.waitFor(() => expect(harness.resolveAttachment).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.trigger).not.toHaveBeenCalled();
    expect(harness.rendered.at(-1)).toEqual(beforeOldResolution);
  });

  it('drops A after navigating to B while pod persistence is pending', async () => {
    const activePod = pod();
    let releaseUpsert!: () => void;
    const upsert = vi.fn(() => new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    }));
    const deps = {
      podStore: { activePod, upsert } as unknown as PodStore,
      secrets: {} as SecretStore,
      workspaceState: { get: () => undefined, update: async () => undefined } as KeyValueStore,
      globalState: { get: () => undefined, update: async () => undefined } as KeyValueStore,
      runs: {
        get: vi.fn(() => undefined),
        subscribe: vi.fn(() => ({ dispose: vi.fn() })),
        trigger: harness.trigger,
      } as unknown as ReviewRunManager,
    };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const { ReviewFlowPanel } = await import('./reviewFlow.js');
      await ReviewFlowPanel.open(deps, { repoId: 'acme/repo', number: '1' });

      harness.message?.({ type: 'run' });
      await vi.waitFor(() => expect(releaseUpsert).toBeTypeOf('function'));

      await ReviewFlowPanel.open(deps, { repoId: 'acme/repo', number: '2' });
      const beforeUpsertCompletes = harness.rendered.at(-1);

      releaseUpsert();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(harness.trigger).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
      expect(harness.rendered.at(-1)).toEqual(beforeUpsertCompletes);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('drops A after navigating to B while model discovery is pending', async () => {
    harness.loadAgentSelection.mockResolvedValue(modelSelection());
    const activePod = pod();
    let releaseDiscovery!: (models: typeof MODEL[]) => void;
    harness.discoverModels.mockImplementationOnce(() => new Promise((resolve) => {
      releaseDiscovery = resolve;
    }));
    const deps = {
      podStore: { activePod, upsert: vi.fn(async () => undefined) } as unknown as PodStore,
      secrets: {} as SecretStore,
      workspaceState: { get: () => undefined, update: async () => undefined } as KeyValueStore,
      globalState: { get: () => undefined, update: async () => undefined } as KeyValueStore,
      runs: {
        get: vi.fn(() => undefined),
        subscribe: vi.fn(() => ({ dispose: vi.fn() })),
        trigger: harness.trigger,
      } as unknown as ReviewRunManager,
    };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const { ReviewFlowPanel } = await import('./reviewFlow.js');
      await ReviewFlowPanel.open(deps, { repoId: 'acme/repo', number: '1' });

      harness.message?.({ type: 'run' });
      await vi.waitFor(() => expect(releaseDiscovery).toBeTypeOf('function'));

      await ReviewFlowPanel.open(deps, { repoId: 'acme/repo', number: '2' });
      const beforeDiscoveryCompletes = harness.rendered.at(-1);

      releaseDiscovery([MODEL]);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(harness.trigger).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
      expect(harness.rendered.at(-1)).toEqual(beforeDiscoveryCompletes);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});