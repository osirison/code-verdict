/**
 * The onboarding wizard's region patch (task 7.3): a message that changes
 * the current step must patch the container that decides which step's
 * markup is showing (`onb-body`), not just some inner fragment — otherwise
 * a step change would silently do nothing once the page starts patching
 * instead of reassigning the whole document.
 *
 * Driven through the real panel and `AppSurface` against a mocked `vscode`,
 * matching settings.test.ts's shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PodStore } from '../app/pods';
import type { Connection, ScmProvider } from '../platform/provider';
import { clearProviders, registerProvider } from '../platform/registry';
import { GITLAB_HOST, GITLAB_VOCABULARY } from '../testing/specFixtures';
import type { OnboardingDeps } from './onboarding';

const handlers = vi.hoisted(() => ({
  message: undefined as ((message: unknown) => void) | undefined,
  dispose: undefined as (() => void) | undefined,
}));

const panel = vi.hoisted(() => ({
  title: '',
  reveal: vi.fn(),
  webview: {
    html: '',
    postMessage: vi.fn(),
    onDidReceiveMessage: (handler: (message: unknown) => void) => {
      handlers.message = handler;
      return { dispose: vi.fn() };
    },
  },
  onDidDispose: (handler: () => void) => {
    handlers.dispose = handler;
    return { dispose: vi.fn() };
  },
}));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  window: { createWebviewPanel: () => panel },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
  },
  commands: { executeCommand: vi.fn(() => Promise.resolve(undefined)) },
}));

const PROVIDER = {
  id: 'test',
  displayName: 'GitLab',
  vocabulary: GITLAB_VOCABULARY,
  host: GITLAB_HOST,
  capabilities: {},
  authModesFor: () => ['token'],
  connect: () =>
    ({
      testConnection: () => Promise.resolve({ ok: true, username: 'you', scopes: ['api'] }),
    }) as unknown as Connection,
} as unknown as ScmProvider;

function makeDeps(): { deps: OnboardingDeps; onComplete: ReturnType<typeof vi.fn> } {
  const onComplete = vi.fn();
  const podStore = { upsert: vi.fn(), setActive: vi.fn() };
  return {
    deps: {
      podStore: podStore as unknown as PodStore,
      secrets: { get: () => Promise.resolve(undefined), store: () => Promise.resolve(), delete: () => Promise.resolve() },
      onComplete,
      providerId: 'test',
    },
    onComplete,
  };
}

type RegionsMessage = { type: 'verdict:regions'; regions: Record<string, string> };

function lastPosted(): RegionsMessage {
  return panel.webview.postMessage.mock.calls.at(-1)?.[0] as RegionsMessage;
}

/** Drains the microtasks the panel's `await`-chained message handling needs. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  clearProviders();
  registerProvider(PROVIDER);
  panel.webview.html = '';
  panel.webview.postMessage.mockClear();
});

afterEach(() => {
  // Dispose the surface so the next test builds a fresh panel and route —
  // `AppSurface`'s and `OnboardingPanel`'s statics otherwise survive test
  // boundaries in the same module instance (settings.test.ts's pattern).
  handlers.dispose?.();
  handlers.message = undefined;
});

describe('OnboardingPanel region patch', () => {
  it('opening the wizard paints the whole document (first paint, not yet ready)', async () => {
    const { deps } = makeDeps();
    const { OnboardingPanel } = await import('./onboarding.js');

    OnboardingPanel.show(deps);

    expect(panel.webview.html).toContain('Welcome to Code Verdict');
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('once ready, a step change patches onb-body — the container that decides which step shows — not the whole document', async () => {
    const { deps } = makeDeps();
    const { OnboardingPanel } = await import('./onboarding.js');
    OnboardingPanel.show(deps);
    handlers.message?.({ type: 'verdictReady' });
    const paintedAfterFirstShow = panel.webview.html;
    panel.webview.postMessage.mockClear();

    // Connect, then advance past step 1 — goStep to 2 is refused while
    // `connected` is false, so the connection has to succeed first.
    handlers.message?.({ type: 'testConnection', instanceUrl: 'https://gitlab.example', token: 'tok' });
    await flush();
    expect(panel.webview.html).toBe(paintedAfterFirstShow);
    let posted = lastPosted();
    expect(posted.type).toBe('verdict:regions');
    expect(Object.keys(posted.regions)).toEqual(['onb-body']);
    expect(posted.regions['onb-body']).toContain('Connected as @you');

    panel.webview.postMessage.mockClear();
    handlers.message?.({ type: 'goStep', step: 2 });
    await flush();

    // The document was never reassigned across either message.
    expect(panel.webview.html).toBe(paintedAfterFirstShow);
    posted = lastPosted();
    expect(Object.keys(posted.regions)).toEqual(['onb-body']);
    // Step 2's own heading is showing, and step 1's is gone — proving the
    // patched container is the one that decides which step renders, not an
    // inner fragment step 1 and step 2 happen to share.
    expect(posted.regions['onb-body']).toContain('Name your pod');
    expect(posted.regions['onb-body']).not.toContain('Welcome to Code Verdict');
  });

  it('a reload resets readiness and the next repaint falls back to a full setHtml, from the step already reached', async () => {
    const { deps } = makeDeps();
    const { OnboardingPanel } = await import('./onboarding.js');
    OnboardingPanel.show(deps);
    handlers.message?.({ type: 'verdictReady' });
    handlers.message?.({ type: 'testConnection', instanceUrl: 'https://gitlab.example', token: 'tok' });
    await flush();
    handlers.message?.({ type: 'goStep', step: 2 });
    await flush();
    panel.webview.postMessage.mockClear();
    panel.webview.html = '';

    // A second `verdictReady` while already ready is what a webview reload
    // looks like (AppRoute.onReload's doc comment) — it resets `ready` and
    // fires onboarding.ts's `onReload`, which repaints from the wizard state
    // already held (step 2, connected) rather than resetting to step 1.
    handlers.message?.({ type: 'verdictReady' });

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    expect(panel.webview.html).toContain('Name your pod');
    expect(panel.webview.html).not.toContain('Welcome to Code Verdict');
  });
});
