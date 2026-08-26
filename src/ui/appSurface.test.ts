import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    onDidReceiveMessage: vi.fn((handler: (message: unknown) => void) => {
      handlers.message = handler;
      return { dispose: vi.fn() };
    }),
  },
  onDidDispose: vi.fn((handler: () => void) => {
    handlers.dispose = handler;
    return { dispose: vi.fn() };
  }),
}));

const createWebviewPanel = vi.hoisted(() => vi.fn(() => panel));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  window: { createWebviewPanel },
}));

describe('AppSurface', () => {
  beforeEach(() => {
    createWebviewPanel.mockClear();
    panel.reveal.mockClear();
    panel.webview.postMessage.mockClear();
  });

  it('reuses one panel and replaces route message and back handlers', async () => {
    const { AppSurface } = await import('./appSurface.js');
    const dashboardMessage = vi.fn();
    const dashboardLeave = vi.fn();
    const reviewMessage = vi.fn();
    const reviewBack = vi.fn();
    const routeChanged = vi.fn();
    const routeSubscription = AppSurface.onDidChangeRoute(routeChanged);

    const dashboard = AppSurface.show('dashboard', 'Verdict');
    dashboard.onMessage(dashboardMessage);
    dashboard.onLeave(dashboardLeave);

    const review = AppSurface.show('review', 'Verdict: Review', reviewBack);
    review.onMessage(reviewMessage);
    handlers.message?.({ type: 'select', itemId: 'finding-1' });
    handlers.message?.({ type: 'appBack' });

    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(dashboardLeave).toHaveBeenCalledOnce();
    expect(dashboardMessage).not.toHaveBeenCalled();
    expect(reviewMessage).toHaveBeenCalledWith({ type: 'select', itemId: 'finding-1' });
    expect(reviewBack).toHaveBeenCalledOnce();
    expect(routeChanged).toHaveBeenLastCalledWith('review');
    expect(panel.title).toBe('Verdict: Review');

    routeSubscription.dispose();
    handlers.dispose?.();
  });

  it('postRegions falls back to setHtml until verdictReady, and setHtml resets readiness', async () => {
    const { AppSurface } = await import('./appSurface.js');
    const dashboard = AppSurface.show('dashboard', 'Verdict');

    // Not ready yet — the caller must fall back to a full render.
    expect(dashboard.postRegions({ body: '<p>1</p>' })).toBe(false);
    expect(panel.webview.postMessage).not.toHaveBeenCalled();

    handlers.message?.({ type: 'verdictReady' });
    expect(dashboard.postRegions({ body: '<p>2</p>' })).toBe(true);
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'verdict:regions',
      regions: { body: '<p>2</p>' },
    });

    dashboard.setHtml('<p>fresh</p>');
    expect(panel.webview.html).toBe('<p>fresh</p>');
    expect(dashboard.postRegions({ body: '<p>3</p>' })).toBe(false);

    handlers.dispose?.();
  });

  it('fires onReload and resets readiness only on a second verdictReady past ready — the first does neither', async () => {
    const { AppSurface } = await import('./appSurface.js');
    const dashboard = AppSurface.show('dashboard', 'Verdict');
    const reloaded = vi.fn();
    dashboard.onReload(reloaded);

    // The first verdictReady is the ordinary not-ready → ready transition:
    // the document just finished its first load, nothing was recreated.
    handlers.message?.({ type: 'verdictReady' });
    expect(reloaded).not.toHaveBeenCalled();
    expect(dashboard.postRegions({ body: '<p>1</p>' })).toBe(true);

    // A second verdictReady while already ready means the document was
    // recreated out from under this route (e.g. "Developer: Reload
    // Webviews") — its REGIONS_SCRIPT re-armed and signalled again.
    handlers.message?.({ type: 'verdictReady' });
    expect(reloaded).toHaveBeenCalledOnce();
    // Readiness is reset first, so the handler's own repaint (or any repaint
    // that follows) falls back to a full setHtml rather than trusting the
    // fresh DOM to already hold whatever the last patch delivered.
    expect(dashboard.postRegions({ body: '<p>2</p>' })).toBe(false);

    handlers.dispose?.();
  });

  it('drops a patch queued by a route that is no longer active', async () => {
    const { AppSurface } = await import('./appSurface.js');
    const dashboard = AppSurface.show('dashboard', 'Verdict');
    handlers.message?.({ type: 'verdictReady' });

    // Navigate away before the stale route's data arrives.
    AppSurface.show('review', 'Verdict: Review');
    panel.webview.postMessage.mockClear();

    // Dropped, not delivered — and reported as handled so the caller does
    // not fall back to setHtml() and clobber the screen now showing.
    expect(dashboard.postRegions({ body: '<p>stale</p>' })).toBe(true);
    expect(panel.webview.postMessage).not.toHaveBeenCalled();

    handlers.dispose?.();
  });
});
