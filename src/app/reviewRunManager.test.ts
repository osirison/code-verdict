import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_AGENT_DESCRIPTOR, DEMO_AGENT_DESCRIPTOR } from './agents';
import { ReviewRunStore } from './reviewRuns';
import { readRetained, type SessionDraft } from './retainedReview';
import {
  InFlightRunStore,
  ReviewRunManager,
  isLegalRunTransition,
  legacyStatusFor,
  sweepInterruptedRuns,
  type DemoRunResult,
  type RunInput,
  type RunRecord,
  type RunnerOptions,
  type RunStatus,
} from './reviewRunManager';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { RUN_LIFECYCLES, type RunLifecycle } from '../domain/harnessLifecycle';
import type { AgentRunTimeouts } from './lmAgent';
import type { AgentReviewResponse } from '../domain/agentResponse';
import type { ChangeRequestDiff } from '../platform/types';
import type { KeyValueStore } from './storage';
import { DEFAULT_CONTEXT_BUDGETS } from './reviewContext';

function memoryStore(): KeyValueStore & { snapshot(): Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    // Synchronous write, then a resolved promise — the contract `storage.ts`
    // states and every real `Memento` satisfies.
    update: async (key, value) => {
      map.set(key, value);
    },
    snapshot: () => map,
  };
}

/**
 * The shipped defaults, written out rather than imported: `lmAgent.ts` reaches
 * for `vscode` at module load, and the manager under test deliberately does
 * not — importing a value from there would drag the editor into a test that
 * has no need of it.
 */
const TIMEOUTS: AgentRunTimeouts = { inactivityMs: 90_000, ceilingMs: 600_000 };

const diff: ChangeRequestDiff = {
  ref: { repoId: 'repo-1', number: '2841' },
  headSha: 'head-1',
  files: [{ oldPath: 'src/a.ts', newPath: 'src/a.ts', diff: '@@ -1 +1 @@\n+const a = 1;' }],
  anchorRefs: {},
};

function response(itemCount: number, headSha = 'head-1'): AgentReviewResponse {
  return {
    schemaVersion: '1',
    agentId: BUILTIN_AGENT_DESCRIPTOR.id,
    agentLabel: 'Default review',
    headSha,
    items: Array.from({ length: itemCount }, (_, index) => ({
      id: `i${index}`,
      file: 'src/a.ts',
      anchored: true,
      line: 1,
      severity: 'major' as const,
      category: 'security' as const,
      confidence: 90,
      title: `Finding ${index}`,
      body: 'Body',
      code: 'const a = 1;',
    })),
    candidates: [],
  };
}

function crInput(number: string, over: Partial<RunInput> = {}): RunInput {
  return {
    target: { kind: 'cr', ref: { repoId: 'repo-1', number }, diff },
    refLabel: `!${number}`,
    podId: 'pod-a',
    criteria: DEFAULT_CRITERIA,
    agent: BUILTIN_AGENT_DESCRIPTOR,
    agentLabel: 'Default review',
    modelId: 'lm:acme/turbo',
    effort: 'none',
    timeouts: TIMEOUTS,
    contextBudgets: DEFAULT_CONTEXT_BUDGETS,
    steps: ['Sending…', 'Indexing…', 'Cross-referencing…', 'Scoring…', 'Items ready'],
    demo: false,
    ...over,
  };
}

/** A runner whose every call is resolved by the test, one deferred per target. */
function controllableRunners() {
  const pending = new Map<string, { resolve(r: AgentReviewResponse): void; reject(e: unknown): void }>();
  const started: string[] = [];
  const cancelled: string[] = [];
  const progressOf = new Map<string, RunnerOptions['onProgress']>();
  const warningsOf = new Map<string, RunnerOptions['onAttachmentWarnings']>();
  // Task 12.4/9.6: captures each call's `onEnterWaiting`/`onResuming` hooks so
  // a test can simulate a harness-attempt-backed `lm` reporting a long
  // backoff wait and its later resumption, the same way `progressOf`/
  // `warningsOf` above already let a test simulate progress and warnings.
  const waitingOf = new Map<string, NonNullable<RunnerOptions['onEnterWaiting']>>();
  const resumingOf = new Map<string, NonNullable<RunnerOptions['onResuming']>>();
  return {
    started,
    cancelled,
    pending,
    progressOf,
    warningsOf,
    waitingOf,
    resumingOf,
    runners: {
      lm(input: RunInput, options: RunnerOptions): Promise<AgentReviewResponse> {
        const key = input.refLabel;
        started.push(key);
        progressOf.set(key, options.onProgress);
        warningsOf.set(key, options.onAttachmentWarnings);
        if (options.onEnterWaiting) waitingOf.set(key, options.onEnterWaiting);
        if (options.onResuming) resumingOf.set(key, options.onResuming);
        return new Promise<AgentReviewResponse>((resolve, reject) => {
          pending.set(key, { resolve, reject });
          options.cancellation.onCancellationRequested(() => {
            cancelled.push(key);
            // What a real transport does when its token trips.
            reject(Object.assign(new Error('run cancelled'), { cancelled: true, requestId: 'abc123' }));
          });
        });
      },
      demo(): DemoRunResult {
        return { response: response(1), steps: ['Reading the diff…', 'Items ready'] };
      },
    },
  };
}

function manager(
  over: Partial<ConstructorParameters<typeof ReviewRunManager>[0]> = {},
): {
  runs: ReviewRunManager;
  workspaceState: ReturnType<typeof memoryStore>;
  globalState: ReturnType<typeof memoryStore>;
  changes: RunRecord[];
} {
  const workspaceState = memoryStore();
  const globalState = memoryStore();
  const changes: RunRecord[] = [];
  const runs = new ReviewRunManager({
    workspaceState,
    globalState,
    runners: { lm: async () => response(1), demo: () => ({ response: response(1), steps: [] }) },
    onChange: (record) => changes.push(record),
    delay: async () => {},
    ...over,
  });
  return { runs, workspaceState, globalState, changes };
}

describe('a run completes with nobody watching', () => {
  it('writes the retained review and records the run for a finish no screen saw', async () => {
    const { runs, workspaceState, globalState } = manager({
      runners: { lm: async () => response(2), demo: () => ({ response: response(0), steps: [] }) },
    });

    runs.trigger(crInput('2841'), 3);
    // No subscriber, no panel, nothing rendering — the point of the change.
    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined());

    const retained = readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'));
    expect(retained?.outcome).toBe('findings');
    expect(retained?.draft.review.items).toHaveLength(2);
    expect(retained?.agentLabel).toBe('Default review');
    expect(retained?.ranAt).toBeDefined();

    const recorded = new ReviewRunStore(globalState).list();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ repoId: 'repo-1', crNumber: '2841', outcome: 'findings', findingCount: 2 });
  });

  it('writes a clean run as a record rather than as a deletion', async () => {
    const { runs, workspaceState, globalState } = manager({
      runners: { lm: async () => response(0), demo: () => ({ response: response(0), steps: [] }) },
    });

    runs.trigger(crInput('2841'), 3);
    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined());

    const retained = readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'));
    // A clean run is a result, not the absence of one: it keeps the head it
    // read and the agent that read it, so the screen can be re-opened.
    expect(retained?.outcome).toBe('clean');
    expect(retained?.draft.review.items).toEqual([]);
    expect(retained?.draft.review.headSha).toBe('head-1');
    expect(new ReviewRunStore(globalState).list()[0]).toMatchObject({ outcome: 'clean', findingCount: 0 });
  });

  it('announces the finished review with the pod it belonged to', async () => {
    const ready: unknown[] = [];
    const { runs } = manager({
      runners: { lm: async () => response(3), demo: () => ({ response: response(0), steps: [] }) },
      onReviewReady: (info) => ready.push(info),
    });

    runs.trigger(crInput('2841'), 3);
    await vi.waitFor(() => expect(ready).toHaveLength(1));

    expect(ready[0]).toEqual({
      ref: { repoId: 'repo-1', number: '2841' },
      refLabel: '!2841',
      itemCount: 3,
      // The notification's open action resolves a ref against the *active*
      // pod, so a run that finished after a switch has to be able to say it is
      // not about this one.
      podId: 'pod-a',
    });
  });

  it('writes the retained review before telling anyone the run succeeded', async () => {
    // A panel watching its own run reacts to `succeeded` by reading the record
    // back off the store. Notified first, it would read the PREVIOUS run's
    // review — or an empty screen — and nothing would repaint when the write
    // landed a microtask later.
    const workspaceState = memoryStore();
    const seenAtNotify: Array<SessionDraft | undefined> = [];
    const { runs } = manager({
      workspaceState,
      runners: { lm: async () => response(2), demo: () => ({ response: response(0), steps: [] }) },
      onChange: (record) => {
        if (record.status === 'succeeded') {
          seenAtNotify.push(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'));
        }
      },
    });

    runs.trigger(crInput('2841'), 3);
    await vi.waitFor(() => expect(seenAtNotify).toHaveLength(1));
    expect(seenAtNotify[0]?.review.items).toHaveLength(2);
  });

  it('records the run before telling anything to repaint', async () => {
    // The callback fans out to views that read this very store; firing it
    // first repaints them onto the previous run.
    const seen: number[] = [];
    const globalState = memoryStore();
    const { runs } = manager({
      globalState,
      runners: { lm: async () => response(1), demo: () => ({ response: response(0), steps: [] }) },
      onRunRecorded: () => seen.push(new ReviewRunStore(globalState).list().length),
    });

    runs.trigger(crInput('2841'), 3);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBe(1);
  });
});

describe('one run per target, several targets at once', () => {
  it('refuses a second run on a target already running, and leaves the first alone', async () => {
    const { started, pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    const first = runs.trigger(crInput('2841'), 3);
    const second = runs.trigger(crInput('2841'), 3);

    // Not a second request, and not a replacement of the first.
    expect(started).toEqual(['!2841']);
    expect(second.key).toBe(first.key);
    expect(second.status).toBe('running');
    expect(pending.size).toBe(1);
  });

  it('returns the identical queued record when the same target is triggered again before it starts', async () => {
    const { started, pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    // Fill the only slot with a different target so the next trigger for '2841' queues.
    runs.trigger(crInput('other'), 1);
    const queued = runs.trigger(crInput('2841'), 1);
    expect(queued.status).toBe('queued');

    const second = runs.trigger(crInput('2841'), 1);
    expect(second).toBe(queued);

    pending.get('!other')!.resolve(response(0));
    await vi.waitFor(() => expect(started).toEqual(['!other', '!2841']));
    // The repeated trigger did not queue a second dispatch for the same target.
    expect(started.filter((label) => label === '!2841')).toHaveLength(1);
  });

  it('runs two different change requests at the same time', async () => {
    const { started, pending, runners } = controllableRunners();
    const { runs, workspaceState } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    runs.trigger(crInput('2842'), 3);
    expect(started).toEqual(['!2841', '!2842']);

    // They finish in the opposite order to make sure nothing is positional.
    pending.get('!2842')!.resolve(response(1));
    pending.get('!2841')!.resolve(response(2));

    await vi.waitFor(() => {
      expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined();
      expect(workspaceState.get('codeVerdict.draft.repo-1!2842')).toBeDefined();
    });
    expect(readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'))?.draft.review.items).toHaveLength(2);
    expect(readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2842'))?.draft.review.items).toHaveLength(1);
  });

  it('allows a new run once the previous one on that target has finished', async () => {
    const { started, pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(response(0));
    await vi.waitFor(() => expect(runs.active()).toHaveLength(0));

    runs.trigger(crInput('2841'), 3);
    expect(started).toEqual(['!2841', '!2841']);
  });
});

describe('the concurrency cap and its queue', () => {
  it('queues past the limit and starts in trigger order as slots free', async () => {
    const { started, pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    runs.trigger(crInput('1'), 2);
    runs.trigger(crInput('2'), 2);
    const third = runs.trigger(crInput('3'), 2);
    const fourth = runs.trigger(crInput('4'), 2);

    expect(started).toEqual(['!1', '!2']);
    // Accepted and held, not rejected and not failed.
    expect(third.status).toBe('queued');
    expect(fourth.status).toBe('queued');

    pending.get('!1')!.resolve(response(0));
    await vi.waitFor(() => expect(started).toEqual(['!1', '!2', '!3']));
    pending.get('!2')!.resolve(response(0));
    await vi.waitFor(() => expect(started).toEqual(['!1', '!2', '!3', '!4']));
  });

  it('never queues when the limit is removed', () => {
    const { started, runners } = controllableRunners();
    const { runs } = manager({ runners });

    for (const number of ['1', '2', '3', '4', '5', '6']) runs.trigger(crInput(number), 0);

    expect(started).toHaveLength(6);
    expect(runs.active().every((record) => record.status === 'running')).toBe(true);
  });

  it('frees the slot when a run fails, so the queue is not stuck behind it', async () => {
    const { started, pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    runs.trigger(crInput('1'), 1);
    runs.trigger(crInput('2'), 1);
    expect(started).toEqual(['!1']);

    pending.get('!1')!.reject(Object.assign(new Error('model exploded'), { requestId: 'req-1' }));
    await vi.waitFor(() => expect(started).toEqual(['!1', '!2']));
  });
});

describe('cancellation', () => {
  it('cancels the request, frees the slot at once, and starts the queued run', async () => {
    const { started, cancelled, pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    runs.trigger(crInput('1'), 1);
    const queued = runs.trigger(crInput('2'), 1);
    expect(queued.status).toBe('queued');

    runs.cancel(runs.active()[0]!.key);

    // The request is stopped, not merely stopped being listened to.
    expect(cancelled).toEqual(['!1']);
    await vi.waitFor(() => expect(started).toEqual(['!1', '!2']));
    expect(pending.size).toBe(2);
  });

  it('drops a queued run without ever making a request, and advances the ones behind it', async () => {
    const { started, runners } = controllableRunners();
    const { runs } = manager({ runners });

    runs.trigger(crInput('1'), 1);
    const second = runs.trigger(crInput('2'), 1);
    runs.trigger(crInput('3'), 1);

    runs.cancel(second.key);
    expect(started).toEqual(['!1']);

    // Its place in the queue is gone, and the one behind it moves up.
    runs.cancel(runs.active().find((record) => record.status === 'running')!.key);
    await vi.waitFor(() => expect(started).toEqual(['!1', '!3']));
  });

  it('leaves an earlier retained review exactly as it was', async () => {
    const { pending, runners } = controllableRunners();
    const { runs, workspaceState } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(response(2));
    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined());
    const before = workspaceState.get('codeVerdict.draft.repo-1!2841');

    // A re-run, cancelled halfway.
    runs.trigger(crInput('2841'), 3);
    runs.cancel(runs.active()[0]!.key);
    await vi.waitFor(() => expect(runs.active()).toHaveLength(0));

    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toEqual(before);
  });

  it('leaves an earlier retained review alone when a re-run fails', async () => {
    const { pending, runners } = controllableRunners();
    const { runs, workspaceState } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(response(2));
    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined());
    const before = workspaceState.get('codeVerdict.draft.repo-1!2841');

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.reject(Object.assign(new Error('timed out'), { timedOut: true, requestId: 'r' }));
    await vi.waitFor(() => expect(runs.get(runs.get('repo-1!2841')?.key ?? 'repo-1!2841')?.status).toBe('failed'));

    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toEqual(before);
  });

  it('cancels a pod\'s runs when that pod is deleted, and only that pod\'s', async () => {
    const { cancelled, runners } = controllableRunners();
    const { runs } = manager({ runners });

    runs.trigger(crInput('1'), 0);
    runs.trigger(crInput('2', { podId: 'pod-b', refLabel: '!2' }), 0);

    runs.cancelForPod('pod-a');

    expect(cancelled).toEqual(['!1']);
    expect(runs.active().map((r) => r.input.podId)).toEqual(['pod-b']);
  });
});

describe('a later success replaces the retained review', () => {
  it('overwrites the retained review written by an earlier successful run on the same target', async () => {
    const { pending, runners } = controllableRunners();
    const { runs, workspaceState } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(response(2));
    await vi.waitFor(() => expect(runs.active()).toHaveLength(0));
    expect(readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'))?.draft.review.items).toHaveLength(2);

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(response(5));
    await vi.waitFor(() => {
      expect(readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'))?.draft.review.items).toHaveLength(5);
    });
  });
});

describe('attribution is fixed at trigger', () => {
  it('records against the pod, agent and criteria the run started with', async () => {
    const { pending, runners } = controllableRunners();
    const ready: Array<{ podId: string }> = [];
    const { runs, globalState, workspaceState } = manager({
      runners,
      onReviewReady: (info) => ready.push(info),
    });

    const input = crInput('2841', { agentLabel: 'Security Reviewer', modelId: 'lm:acme/turbo' });
    runs.trigger(input, 3);

    // Everything the old `finishRun` would have re-read on the way out is now
    // changed underneath the run. None of it may reach the result.
    pending.get('!2841')!.resolve(response(1));
    await vi.waitFor(() => expect(ready).toHaveLength(1));

    expect(ready[0]?.podId).toBe('pod-a');
    expect(new ReviewRunStore(globalState).list()[0]).toMatchObject({
      repoId: 'repo-1',
      crNumber: '2841',
      agentLabel: 'Security Reviewer',
    });
    const retained = readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'));
    expect(retained?.agentLabel).toBe('Security Reviewer');
    expect(retained?.modelId).toBe('lm:acme/turbo');
  });
});

describe('progress and transitions', () => {
  it('exposes attachment warnings during the run and retains them after completion', async () => {
    const { pending, warningsOf, runners } = controllableRunners();
    const { runs, workspaceState } = manager({ runners });
    const record = runs.trigger(crInput('2841'), 3);

    warningsOf.get('!2841')?.([{
      code: 'attachment-unreadable',
      attachmentId: 'schema',
      label: 'schema.ts',
      path: 'src/schema.ts',
      reason: 'ENOENT',
    }]);

    expect(runs.get(record.key)?.attachmentWarnings).toEqual([
      expect.objectContaining({ code: 'attachment-unreadable', path: 'src/schema.ts' }),
    ]);

    pending.get('!2841')!.resolve(response(1));
    await vi.waitFor(() => {
      const retained = readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'));
      expect(retained?.attachmentWarnings).toEqual([
        expect.objectContaining({ code: 'attachment-unreadable', path: 'src/schema.ts' }),
      ]);
    });
  });

  it('emits a finish at once even when it lands inside the progress throttle', async () => {
    const { pending, progressOf, runners } = controllableRunners();
    let now = 1_000;
    const changes: RunRecord[] = [];
    const { runs } = manager({ runners, now: () => now, onChange: (r) => changes.push(r) });

    runs.trigger(crInput('2841'), 3);
    const onProgress = progressOf.get('!2841')!;
    now += 1_000;
    onProgress({ requestId: 'r', fragmentsReceived: 1, charsReceived: 10, elapsedMs: 10 });
    const afterProgress = changes.length;

    // Well inside the 250ms floor: a throttle applied to transitions would
    // swallow this and leave the screen on a spinner after the run was over.
    now += 10;
    pending.get('!2841')!.resolve(response(1));
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(afterProgress));
    expect(changes.at(-1)?.status).toBe('succeeded');
  });

  it('throttles progress updates without losing the counters they carried', () => {
    const { progressOf, runners } = controllableRunners();
    let now = 1_000;
    const changes: RunRecord[] = [];
    const { runs } = manager({ runners, now: () => now, onChange: (r) => changes.push(r) });

    const record = runs.trigger(crInput('2841'), 3);
    const onProgress = progressOf.get('!2841')!;
    const before = changes.length;
    // Three fragments inside one window: at most one emission, but the record
    // holds the latest numbers, so a screen opening mid-run reads them all.
    for (let n = 1; n <= 3; n += 1) {
      now += 10;
      onProgress({ requestId: 'r', fragmentsReceived: n, charsReceived: n * 10, elapsedMs: n });
    }
    expect(changes.length).toBe(before);
    expect(runs.get(record.key)?.progress).toMatchObject({ fragmentsReceived: 3, charsReceived: 30 });
  });
});

describe('the demo agent runs in the background too', () => {
  it('walks its log and finishes with no screen attached', async () => {
    const { runs, workspaceState } = manager({
      runners: {
        lm: async () => response(0),
        demo: () => ({ response: response(1), steps: ['Reading the diff…', 'Scoring…', 'Items ready'] }),
      },
    });

    runs.trigger(crInput('2841', { demo: true, agent: DEMO_AGENT_DESCRIPTOR, modelId: undefined }), 3);

    // The walk used to be driven by the panel's own `render()`, so navigating
    // away mid-walk ended it. It runs here now, like every other run.
    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined());
    expect(readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'))?.draft.review.items).toHaveLength(1);
  });

  it('stops the walk when the run is cancelled', async () => {
    let resolveStep: (() => void) | undefined;
    const { runs, workspaceState } = manager({
      runners: {
        lm: async () => response(0),
        demo: () => ({ response: response(1), steps: ['One', 'Two', 'Three'] }),
      },
      delay: () => new Promise<void>((resolve) => { resolveStep = resolve; }),
    });

    const record = runs.trigger(crInput('2841', { demo: true }), 3);
    await vi.waitFor(() => expect(resolveStep).toBeDefined());
    runs.cancel(record.key);
    resolveStep?.();

    await vi.waitFor(() => expect(runs.active()).toHaveLength(0));
    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeUndefined();
  });
});

describe('changeset runs', () => {
  it('records under the changeset identity, where no change-request row can match it', async () => {
    const { runs, workspaceState, globalState } = manager({
      runners: { lm: async () => response(2), demo: () => ({ response: response(0), steps: [] }) },
    });

    runs.trigger(
      crInput('ignored', {
        target: { kind: 'changeset', changesetId: 'cs-7', members: [] },
        refLabel: 'Payments rollout',
      }),
      3,
    );

    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.changesetDraft.cs-7')).toBeDefined());
    expect(new ReviewRunStore(globalState).list()[0]).toMatchObject({
      repoId: 'changeset',
      crNumber: 'cs-7',
      outcome: 'findings',
    });
  });

  it('runs a changeset and a change request at the same time without colliding', () => {
    const { started, runners } = controllableRunners();
    const { runs } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    runs.trigger(
      crInput('2841', {
        target: { kind: 'changeset', changesetId: '2841', members: [] },
        refLabel: 'A changeset that shares the number',
      }),
      3,
    );

    // Prefixed keys: a changeset id can never be read as a `repoId!number`.
    expect(started).toHaveLength(2);
    expect(runs.active()).toHaveLength(2);
  });
});

describe('stored effort attribution', () => {
  it('records the immutable run effort on the review', async () => {
    const { runs, workspaceState } = manager({
      runners: { lm: async () => response(1), demo: () => ({ response: response(0), steps: [] }) },
    });

    runs.trigger(crInput('2841', { effort: 'xhigh' }), 3);

    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined());
    expect((workspaceState.get('codeVerdict.draft.repo-1!2841') as { review: { effort: string } }).review.effort)
      .toBe('xhigh');
  });
});

describe('the in-flight record and the interrupted sweep', () => {
  it('records a run as in flight while it runs and clears it when it finishes', async () => {
    const { pending, runners } = controllableRunners();
    const { runs, globalState } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(1));
    expect(new InFlightRunStore(globalState).list()[0]).toMatchObject({
      key: 'repo-1!2841',
      podId: 'pod-a',
      refLabel: '!2841',
    });

    pending.get('!2841')!.resolve(response(0));
    await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(0));
  });

  it('clears the in-flight record when a run is cancelled', async () => {
    const { runners } = controllableRunners();
    const { runs, globalState } = manager({ runners });

    const record = runs.trigger(crInput('2841'), 3);
    await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(1));
    runs.cancel(record.key);
    await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(0));
  });

  it('sweeps a run left behind by a closed window into an interrupted outcome', async () => {
    const globalState = memoryStore();
    await new InFlightRunStore(globalState).add({
      key: 'repo-1!2841',
      podId: 'pod-a',
      refLabel: '!2841',
      repoId: 'repo-1',
      crNumber: '2841',
      startedAt: '2026-08-28T09:00:00.000Z',
    });

    const swept = await sweepInterruptedRuns(globalState);

    expect(swept).toBe(1);
    expect(new ReviewRunStore(globalState).list()[0]).toMatchObject({
      repoId: 'repo-1',
      crNumber: '2841',
      outcome: 'interrupted',
      // Its own start time, not the time of the sweep: the reviewer needs to
      // know when the lost run began.
      ranAt: '2026-08-28T09:00:00.000Z',
    });
    expect(new InFlightRunStore(globalState).list()).toEqual([]);
  });

  it('sweeps nothing when every run finished cleanly', async () => {
    const globalState = memoryStore();
    expect(await sweepInterruptedRuns(globalState)).toBe(0);
    expect(new ReviewRunStore(globalState).list()).toEqual([]);
  });

  it('does not touch the target\'s retained review', async () => {
    const globalState = memoryStore();
    const workspaceState = memoryStore();
    const existing = { review: { items: [1] } };
    await workspaceState.update('codeVerdict.draft.repo-1!2841', existing);
    await new InFlightRunStore(globalState).add({
      key: 'repo-1!2841',
      podId: 'pod-a',
      refLabel: '!2841',
      repoId: 'repo-1',
      crNumber: '2841',
      startedAt: '2026-08-28T09:00:00.000Z',
    });

    await sweepInterruptedRuns(globalState);

    // An interruption is reported alongside the last completed review, never
    // in place of it.
    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toEqual(existing);
  });
});

/**
 * A runner that never settles on its own and, unlike `controllableRunners`,
 * does not react to cancellation at all — it models the risk design.md names
 * directly ("cancellation may not stop a provider or model immediately"), so
 * a test can resolve/reject it *after* the manager already considers the
 * record terminal and prove the late arrival is ignored, rather than only
 * exercising the cooperative-cancellation fast path `controllableRunners`
 * already covers above.
 */
function unresponsiveRunner() {
  const pending = new Map<string, { resolve(r: AgentReviewResponse): void; reject(e: unknown): void }>();
  return {
    pending,
    runners: {
      lm(input: RunInput): Promise<AgentReviewResponse> {
        return new Promise<AgentReviewResponse>((resolve, reject) => {
          pending.set(input.refLabel, { resolve, reject });
        });
      },
      demo(): DemoRunResult {
        return { response: response(0), steps: [] };
      },
    },
  };
}

describe('task 12.2: every canonical lifecycle maps to a documented legacy status', () => {
  it('maps all thirteen lifecycles', () => {
    const expected: Record<RunLifecycle, RunStatus> = {
      queued: 'queued',
      planning: 'running',
      investigating: 'running',
      verifying: 'running',
      completing: 'running',
      waiting: 'running',
      paused: 'running',
      resuming: 'running',
      cancelling: 'running',
      cancelled: 'cancelled',
      succeeded: 'succeeded',
      failed: 'failed',
      interrupted: 'failed',
    };
    expect(RUN_LIFECYCLES).toHaveLength(13);
    for (const lifecycle of RUN_LIFECYCLES) {
      expect(legacyStatusFor(lifecycle)).toBe(expected[lifecycle]);
    }
  });
});

describe('task 12.3: the one validated transition path', () => {
  it('accepts the edges the lifecycle diagram and the spec describe', () => {
    expect(isLegalRunTransition('queued', 'planning')).toBe(true);
    expect(isLegalRunTransition('planning', 'investigating')).toBe(true);
    // A forward skip among active phases is legal: this pass's coarse
    // lm/demo seam has no per-phase feedback of its own.
    expect(isLegalRunTransition('investigating', 'completing')).toBe(true);
    expect(isLegalRunTransition('completing', 'succeeded')).toBe(true);
    expect(isLegalRunTransition('investigating', 'waiting')).toBe(true);
    expect(isLegalRunTransition('verifying', 'paused')).toBe(true);
    expect(isLegalRunTransition('waiting', 'resuming')).toBe(true);
    expect(isLegalRunTransition('paused', 'resuming')).toBe(true);
    expect(isLegalRunTransition('resuming', 'verifying')).toBe(true);
    expect(isLegalRunTransition('investigating', 'cancelling')).toBe(true);
    expect(isLegalRunTransition('queued', 'cancelling')).toBe(true);
    expect(isLegalRunTransition('waiting', 'cancelling')).toBe(true);
    expect(isLegalRunTransition('paused', 'cancelling')).toBe(true);
    expect(isLegalRunTransition('cancelling', 'cancelled')).toBe(true);
  });

  it('refuses an illegal transition', () => {
    expect(isLegalRunTransition('queued', 'succeeded')).toBe(false);
    expect(isLegalRunTransition('queued', 'investigating')).toBe(false);
    expect(isLegalRunTransition('completing', 'investigating')).toBe(false); // backward
    expect(isLegalRunTransition('waiting', 'succeeded')).toBe(false);
    expect(isLegalRunTransition('paused', 'failed')).toBe(false);
    expect(isLegalRunTransition('cancelling', 'failed')).toBe(false);
  });

  it('gives every terminal lifecycle zero outgoing edges', () => {
    for (const terminal of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
      for (const to of RUN_LIFECYCLES) {
        expect(isLegalRunTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('refuses to move an already-terminal record through the manager itself', async () => {
    const { pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    const record = runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.reject(Object.assign(new Error('boom'), { requestId: 'r1' }));
    await vi.waitFor(() => expect(runs.get(record.key)?.status).toBe('failed'));
    const finishedAt = runs.get(record.key)?.finishedAt;

    // The only other public path that could move it: cancelling an
    // already-failed record is refused, not silently applied.
    runs.cancel(record.key);

    expect(runs.get(record.key)?.status).toBe('failed');
    expect(runs.get(record.key)?.lifecycle).toBe('failed');
    expect(runs.get(record.key)?.finishedAt).toBe(finishedAt);
  });
});

describe('task 12.4/9.6: waiting releases the slot, resuming keeps queue fairness', () => {
  it('releases the slot on entering waiting, lets the next queued run start, and resumes without losing queue position', async () => {
    const { started, pending, waitingOf, resumingOf, runners } = controllableRunners();
    const { runs } = manager({ runners });

    const first = runs.trigger(crInput('1'), 1); // limit 1: holds the only slot
    const second = runs.trigger(crInput('2'), 1); // queued behind it
    expect(started).toEqual(['!1']);
    expect(second.status).toBe('queued');

    // '1' enters a long backoff wait — the slot is released at once, so '2'
    // starts even though '1' has not finished.
    waitingOf.get('!1')!({ reason: 'A transient provider issue requires a longer wait.' });
    expect(runs.get(first.key)?.lifecycle).toBe('waiting');
    await vi.waitFor(() => expect(started).toEqual(['!1', '!2']));

    // '1' still owns its target while waiting: a retrigger returns the same
    // waiting record rather than starting a second run.
    const stillOwned = runs.trigger(crInput('1'), 1);
    expect(stillOwned.key).toBe(first.key);
    expect(stillOwned.lifecycle).toBe('waiting');

    // A third target, triggered after '1' resumes, must not cut ahead of it.
    const third = runs.trigger(crInput('3'), 1);
    expect(third.status).toBe('queued');

    resumingOf.get('!1')!();
    expect(runs.get(first.key)?.lifecycle).toBe('resuming');

    // '2' finishes, freeing the slot. '1' (resuming, original queuedAt) goes
    // before '3' (queued after it) — original admission order, not FIFO by
    // resume time.
    pending.get('!2')!.resolve(response(0));
    await vi.waitFor(() => expect(runs.get(first.key)?.lifecycle).toBe('investigating'));
    // No second dispatch for '1': this pass's coarse lm/demo seam has no
    // per-turn continuation to re-issue — the original call is still live.
    expect(started).toEqual(['!1', '!2']);
    expect(runs.get(third.key)?.status).toBe('queued');

    pending.get('!1')!.resolve(response(0));
    await vi.waitFor(() => expect(runs.active().some((r) => r.key === third.key && r.status === 'running')).toBe(true));
  });

  it('cancellation from queued, active, waiting and paused each ends promptly and releases the slot at once', async () => {
    const { started, cancelled, waitingOf, runners } = controllableRunners();
    const { runs } = manager({ runners });

    // 'w' takes the only slot, then enters `waiting` (releasing it).
    const waitingRun = runs.trigger(crInput('w'), 1);
    waitingOf.get('!w')!();
    expect(runs.get(waitingRun.key)?.lifecycle).toBe('waiting');

    // 'p' takes the freed slot, then is explicitly paused (releasing it again).
    const pausedRun = runs.trigger(crInput('p'), 1);
    runs.pause(pausedRun.key);
    expect(runs.get(pausedRun.key)?.lifecycle).toBe('paused');

    // 'a' takes the slot and stays active.
    const activeRun = runs.trigger(crInput('a'), 1);
    expect(runs.get(activeRun.key)?.lifecycle).toBe('investigating');

    // 'q' finds the slot taken and queues behind it.
    const queuedRun = runs.trigger(crInput('q'), 1);
    expect(queuedRun.status).toBe('queued');

    // Cancel 'q' first, while 'a' still holds the slot — otherwise cancelling
    // 'a' below would free the slot and let 'q' start via the queue pump
    // before this test gets to assert it was never dispatched.
    runs.cancel(queuedRun.key);
    runs.cancel(waitingRun.key);
    runs.cancel(pausedRun.key);
    runs.cancel(activeRun.key);

    expect(runs.active()).toHaveLength(0);
    // Only the three that ever held a live dispatch had a token to stop;
    // the queued run never made a request at all.
    expect(cancelled).toEqual(['!w', '!p', '!a']);
    expect(started).toEqual(['!w', '!p', '!a']);

    // The slot cancelling 'a' released is usable at once.
    runs.trigger(crInput('fresh'), 1);
    expect(started).toContain('!fresh');
  });

  it('does not double-release the slot when a waiting or paused attempt is cancelled', () => {
    // A slot-accounting bug (releasing the running count a second time for a
    // key that already released it on entering waiting/paused) would only
    // show up once *another* run genuinely holds the slot at cancel time —
    // the test above cancels 'w'/'p' after their slot has already gone to a
    // later run, but never checks that cancelling them leaves that run's
    // slot alone. This does, chaining the same relay through both cases:
    // 'w' (waiting, released) -> 'b' (active) -> 'b' (paused, released) ->
    // 'c' (active, was queued) -> 'd' (queued).
    const { started, waitingOf, runners } = controllableRunners();
    const { runs } = manager({ runners });

    const waitingRun = runs.trigger(crInput('w'), 1); // takes the only slot
    waitingOf.get('!w')!(); // enters `waiting`, releasing it
    const holder = runs.trigger(crInput('b'), 1); // takes the freed slot
    expect(runs.get(holder.key)?.lifecycle).toBe('investigating');
    const queuedBehindHolder = runs.trigger(crInput('c'), 1); // must stay queued
    expect(queuedBehindHolder.status).toBe('queued');

    // Cancelling a `waiting` attempt must not touch the slot 'b' genuinely
    // holds: a double release would drop `running` to 0 and let 'c' start
    // past the limit-1 cap.
    runs.cancel(waitingRun.key);
    expect(started).toEqual(['!w', '!b']);
    expect(runs.get(queuedBehindHolder.key)?.status).toBe('queued');

    // Now pause 'b' itself, releasing its slot the same way. 'c' — already
    // queued — legitimately takes it.
    runs.pause(holder.key);
    expect(runs.get(holder.key)?.lifecycle).toBe('paused');
    expect(runs.get(queuedBehindHolder.key)?.lifecycle).toBe('investigating');
    const queuedBehindNextHolder = runs.trigger(crInput('d'), 1); // must stay queued
    expect(queuedBehindNextHolder.status).toBe('queued');

    // Cancelling the now-`paused` 'b' must not touch the slot 'c' holds.
    runs.cancel(holder.key);
    expect(started).toEqual(['!w', '!b', '!c']);
    expect(runs.get(queuedBehindNextHolder.key)?.status).toBe('queued');
  });
});

describe('task 12.4: late model/provider work cannot settle an already-terminal attempt', () => {
  it('a late success arriving after cancellation does not overwrite the cancelled state or write a retained review', async () => {
    const { pending, runners } = unresponsiveRunner();
    const { runs, workspaceState } = manager({ runners });

    const record = runs.trigger(crInput('2841'), 3);
    runs.cancel(record.key);
    expect(runs.get(record.key)).toBeUndefined();

    // Arrives late; this fixture, unlike `controllableRunners`, never reacted
    // to the cancellation token at all.
    pending.get('!2841')!.resolve(response(3));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeUndefined();
    expect(runs.get(record.key)).toBeUndefined();
  });

  it('a late waiting/resuming signal arriving after failure does not move the failed record', async () => {
    const { pending, waitingOf, resumingOf, runners } = controllableRunners();
    const { runs } = manager({ runners });

    const record = runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.reject(Object.assign(new Error('boom'), { requestId: 'r1' }));
    await vi.waitFor(() => expect(runs.get(record.key)?.status).toBe('failed'));

    // A stray hook call racing the rejection — the same seam that could have
    // reported `onEnterWaiting` calling it (or `onResuming`) after the
    // promise it belonged to already settled the record.
    waitingOf.get('!2841')?.();
    resumingOf.get('!2841')?.();

    expect(runs.get(record.key)?.status).toBe('failed');
    expect(runs.get(record.key)?.lifecycle).toBe('failed');
  });
});

describe('task 12.2/12.4: one active run per target holds through waiting', () => {
  it('refuses a second trigger for a waiting target while a different target runs independently', async () => {
    const { started, waitingOf, runners } = controllableRunners();
    const { runs } = manager({ runners });

    const waiting = runs.trigger(crInput('waiter'), 2);
    waitingOf.get('!waiter')!();
    expect(runs.get(waiting.key)?.lifecycle).toBe('waiting');

    // Retriggering the same target returns the existing waiting record, not
    // a second run.
    const retriggered = runs.trigger(crInput('waiter'), 2);
    expect(retriggered.key).toBe(waiting.key);
    expect(retriggered.lifecycle).toBe('waiting');

    // A different target runs completely independently.
    const other = runs.trigger(crInput('other'), 2);
    expect(started).toEqual(['!waiter', '!other']);
    expect(other.status).toBe('running');
  });
});
