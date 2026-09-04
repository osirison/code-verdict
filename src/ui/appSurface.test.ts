import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from './theme';

const handlers = vi.hoisted(() => ({
  message: undefined as ((message: unknown) => void) | undefined,
  dispose: undefined as (() => void) | undefined,
}));

/** Every full document assignment, logged — the resident shell's whole claim
 * is how rarely this grows (task 8.6). */
const panel = vi.hoisted(() => {
  const htmlLog: string[] = [];
  return {
    htmlLog,
    title: '',
    reveal: vi.fn(),
    webview: {
      get html(): string {
        return htmlLog.at(-1) ?? '';
      },
      set html(value: string) {
        htmlLog.push(value);
      },
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
  };
});

const createWebviewPanel = vi.hoisted(() => vi.fn(() => panel));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  window: { createWebviewPanel },
}));

/** A route's own document, the way every screen's render*Html builds one. */
function routeDoc(routeClass: string, body: string, crumb?: string): string {
  return renderPage({
    title: 'Verdict: Test',
    nonce: 'nonce123',
    css: '.local { color: red; }',
    body,
    routeClass,
    breadcrumb: crumb === undefined ? undefined : { current: crumb },
  });
}

describe('AppSurface', () => {
  beforeEach(() => {
    createWebviewPanel.mockClear();
    panel.reveal.mockClear();
    panel.webview.postMessage.mockClear();
    panel.htmlLog.length = 0;
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

  it('postRegions falls back to setHtml until verdictReady, and a full assignment resets readiness', async () => {
    const { AppSurface } = await import('./appSurface.js');
    const dashboard = AppSurface.show('dashboard', 'Verdict');

    // Nothing loaded, nothing armed — the caller must fall back to setHtml.
    expect(dashboard.postRegions({ body: '<p>1</p>' })).toBe(false);
    expect(panel.webview.postMessage).not.toHaveBeenCalled();

    // First paint: setHtml assigns the shell with the route's content in
    // place, but the page has not echoed verdictReady yet, so patches still
    // report not-ready.
    dashboard.setHtml(routeDoc('route-dashboard', '<div id="db-body">one</div>'));
    expect(panel.htmlLog).toHaveLength(1);
    expect(dashboard.postRegions({ 'db-body': '<p>2</p>' })).toBe(false);

    handlers.message?.({ type: 'verdictReady' });
    expect(dashboard.postRegions({ 'db-body': '<p>2</p>' })).toBe(true);
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'verdict:regions',
      regions: { 'db-body': '<p>2</p>' },
    });

    // A marker-less document (renderFallbackHtml's script-free pages) is
    // assigned verbatim and readiness drops with it — that page carries no
    // REGIONS_SCRIPT, so no patch could ever reach it.
    dashboard.setHtml('<p>fresh</p>');
    expect(panel.webview.html).toBe('<p>fresh</p>');
    expect(dashboard.postRegions({ 'db-body': '<p>3</p>' })).toBe(false);

    handlers.dispose?.();
  });

  it('fires onReload and resets readiness only on a second verdictReady past ready — the first does neither', async () => {
    const { AppSurface } = await import('./appSurface.js');
    const dashboard = AppSurface.show('dashboard', 'Verdict');
    const reloaded = vi.fn();
    dashboard.onReload(reloaded);
    dashboard.setHtml(routeDoc('route-dashboard', '<div id="db-body">one</div>'));

    // The first verdictReady is the ordinary not-ready → ready transition:
    // the document just finished its first load, nothing was recreated.
    handlers.message?.({ type: 'verdictReady' });
    expect(reloaded).not.toHaveBeenCalled();
    expect(dashboard.postRegions({ 'db-body': '<p>1</p>' })).toBe(true);

    // A second verdictReady while already ready means the document was
    // recreated out from under this route (e.g. "Developer: Reload
    // Webviews") — its REGIONS_SCRIPT re-armed and signalled again.
    handlers.message?.({ type: 'verdictReady' });
    expect(reloaded).toHaveBeenCalledOnce();
    // Readiness is reset first, so the handler's own repaint (or any repaint
    // that follows) falls back to a full setHtml rather than trusting the
    // fresh DOM to already hold whatever the last patch delivered.
    expect(dashboard.postRegions({ 'db-body': '<p>2</p>' })).toBe(false);

    handlers.dispose?.();
  });

  it('drops a patch queued by a route that is no longer active', async () => {
    const { AppSurface } = await import('./appSurface.js');
    const dashboard = AppSurface.show('dashboard', 'Verdict');
    dashboard.setHtml(routeDoc('route-dashboard', '<div id="db-body">one</div>'));
    handlers.message?.({ type: 'verdictReady' });

    // Navigate away before the stale route's data arrives.
    AppSurface.show('review', 'Verdict: Review');
    panel.webview.postMessage.mockClear();

    // Dropped, not delivered — and reported as handled so the caller does
    // not fall back to setHtml() and clobber the screen now showing.
    expect(dashboard.postRegions({ 'db-body': '<p>stale</p>' })).toBe(true);
    expect(panel.webview.postMessage).not.toHaveBeenCalled();

    handlers.dispose?.();
  });

  it('assigns webview.html exactly once across a navigation between two routes (task 8.6)', async () => {
    const { AppSurface } = await import('./appSurface.js');
    const dashboard = AppSurface.show('dashboard', 'Verdict: Dashboard');
    dashboard.setHtml(routeDoc('route-dashboard', '<div id="db-body">dash rows</div>'));

    // The one assignment of the panel's lifetime: the shell — union CSS and
    // scripts for every route, not just the one that painted first.
    expect(panel.htmlLog).toHaveLength(1);
    expect(panel.webview.html).toContain('dash rows');
    expect(panel.webview.html).toContain('.route-dashboard {');
    expect(panel.webview.html).toContain('.route-posted {');
    expect(panel.webview.html).toContain('.route-flow {');

    handlers.message?.({ type: 'verdictReady' });
    panel.webview.postMessage.mockClear();

    const posted = AppSurface.show('posted', 'Verdict: Posted reviews');
    posted.setHtml(routeDoc('route-posted', '<div id="pr-rows">posted rows</div>', 'Posted reviews'));

    // Entering the second route patched the shell's two swap points instead
    // of assigning a document — still exactly one assignment across both.
    expect(panel.htmlLog).toHaveLength(1);
    expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
    const patch = panel.webview.postMessage.mock.calls[0]?.[0] as {
      type: string;
      routeKey?: string;
      regions: Record<string, string>;
    };
    expect(patch.type).toBe('verdict:regions');
    // The navigation patch names the route it swaps in (task 9.4) — the key
    // the page files the departed route's view state under and looks the
    // entered route's up by. Without it, returning to a screen could not
    // restore its scroll and expanded sections.
    expect(patch.routeKey).toBe('posted');
    expect(Object.keys(patch.regions).sort()).toEqual(['app-breadcrumb', 'app-route']);
    expect(patch.regions['app-route']).toContain('class="route-posted"');
    expect(patch.regions['app-route']).toContain('posted rows');
    expect(patch.regions['app-breadcrumb']).toContain('Posted reviews');
    // The dashboard has no breadcrumb; navigating back must clear it, so the
    // patched region for a crumb-less route is empty, not absent.
    const dashboardAgain = AppSurface.show('dashboard', 'Verdict: Dashboard');
    panel.webview.postMessage.mockClear();
    dashboardAgain.setHtml(routeDoc('route-dashboard', '<div id="db-body">dash again</div>'));
    const back = panel.webview.postMessage.mock.calls[0]?.[0] as { regions: Record<string, string> };
    expect(back.regions['app-breadcrumb']).toBe('');
    expect(panel.htmlLog).toHaveLength(1);

    handlers.dispose?.();
  });

  it('navigating repeatedly costs the same every time and accumulates nothing (spec: navigating repeatedly)', async () => {
    const { AppSurface } = await import('./appSurface.js');
    const first = AppSurface.show('dashboard', 'Verdict: Dashboard');
    first.setHtml(routeDoc('route-dashboard', '<div id="db-body">dash</div>'));
    handlers.message?.({ type: 'verdictReady' });

    // Three full round trips between the two routes.
    let lastMessageSpy = vi.fn();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      panel.webview.postMessage.mockClear();
      const posted = AppSurface.show('posted', 'Verdict: Posted reviews');
      posted.setHtml(routeDoc('route-posted', '<div id="pr-rows">rows</div>', 'Posted reviews'));
      // Each transition is exactly one navigation patch — the same cost as
      // the first; nothing extra is posted on later cycles.
      expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);

      panel.webview.postMessage.mockClear();
      const dashboard = AppSurface.show('dashboard', 'Verdict: Dashboard');
      dashboard.setHtml(routeDoc('route-dashboard', '<div id="db-body">dash</div>'));
      expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
      lastMessageSpy = vi.fn();
      dashboard.onMessage(lastMessageSpy);
    }

    // Still the single document assignment from before the cycles began.
    expect(panel.htmlLog).toHaveLength(1);
    // Handlers were replaced per entry, never stacked: one message dispatches
    // once, to the live route's handler alone.
    handlers.message?.({ type: 'probe' });
    expect(lastMessageSpy).toHaveBeenCalledTimes(1);

    handlers.dispose?.();
  });

  it('a route change makes postRegions report not-ready until the new route\'s content is swapped in', async () => {
    const { AppSurface } = await import('./appSurface.js');
    const dashboard = AppSurface.show('dashboard', 'Verdict: Dashboard');
    dashboard.setHtml(routeDoc('route-dashboard', '<div id="db-body">dash</div>'));
    handlers.message?.({ type: 'verdictReady' });

    // The shell is armed, but #app-route still holds the dashboard — a patch
    // aimed at this route's region ids would find nothing and silently leave
    // the old screen up. Reporting not-ready sends the caller down its
    // setHtml fallback, which swaps the route in as a patch.
    const posted = AppSurface.show('posted', 'Verdict: Posted reviews');
    expect(posted.postRegions({ 'pr-rows': '<p>rows</p>' })).toBe(false);
    posted.setHtml(routeDoc('route-posted', '<div id="pr-rows">rows</div>', 'Posted reviews'));
    expect(posted.postRegions({ 'pr-rows': '<p>rows</p>' })).toBe(true);
    expect(panel.htmlLog).toHaveLength(1);

    handlers.dispose?.();
  });

  it('a reload reassigns the shell and restores the current route (task 8.6)', async () => {
    const { AppSurface } = await import('./appSurface.js');
    const dashboard = AppSurface.show('dashboard', 'Verdict: Dashboard');
    dashboard.setHtml(routeDoc('route-dashboard', '<div id="db-body">dash</div>'));
    handlers.message?.({ type: 'verdictReady' });

    const posted = AppSurface.show('posted', 'Verdict: Posted reviews');
    posted.setHtml(routeDoc('route-posted', '<div id="pr-rows">posted rows</div>', 'Posted reviews'));
    // The screen's reload handler repaints the way every panel's does —
    // through its normal render path, whose setHtml falls back to a full
    // assignment because readiness was just reset.
    posted.onReload(() => {
      posted.setHtml(routeDoc('route-posted', '<div id="pr-rows">posted rows</div>', 'Posted reviews'));
    });
    expect(panel.htmlLog).toHaveLength(1);

    // The webview was recreated (its REGIONS_SCRIPT signalled a second time):
    // the shell is reassigned whole, carrying the current route's content.
    handlers.message?.({ type: 'verdictReady' });
    expect(panel.htmlLog).toHaveLength(2);
    expect(panel.webview.html).toContain('posted rows');
    expect(panel.webview.html).toContain('.route-dashboard {');

    handlers.dispose?.();
  });
});
