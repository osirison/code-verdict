/**
 * The refresh hop, executed rather than asserted about as text (bug 5: "the
 * refresh button does not work"). Every other dashboard test greps the
 * rendered HTML, which cannot tell a wired button from a dead one. This runs
 * the real page script in jsdom: click ⟳, prove the message leaves, then post
 * the region patch back and prove it lands. The view-state suites below
 * (design D8, tasks 9.1/9.4/9.6) drive the same REGIONS_SCRIPT the same way:
 * patch, then assert what a reviewer would keep — scroll, expanded sections,
 * focus and caret.
 *
 * `new JSDOM(..., { runScripts: 'dangerously' })` under the normal node
 * environment, deliberately: vitest's jsdom environment hands you a document
 * whose scripts never ran, and flipping the global `environment` would drag
 * every other test file into a DOM they do not need. Scope is one path, not a
 * general webview harness — that is issue #43.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { GITLAB_VOCABULARY } from '../testing/specFixtures';
import type { DashboardViewState } from './dashboardHtml';
import { renderDashboardHtml } from './dashboardHtml';
import { renderShellDocument } from './appShell';
import { extractRouteRegions } from './theme';

const state: DashboardViewState = {
  vocabulary: GITLAB_VOCABULARY,
  podName: 'Platform squad',
  meta: '6 repositories · 9 open changes',
  scopeCounts: { you: 3, them: 6 },
  stats: { waitingOnYou: 3, aiCoverage: { reviewed: 1, total: 2 }, pipelinesFailing: 0, projectsInPod: 6 },
  fetchedLabel: '14:32',
  projects: [{ id: '9101', label: 'core', count: 1 }],
  rows: [{
    repoId: '9101', number: '2841', refLabel: '!2841', title: 'Refactor token refresh',
    author: 'kai', branch: 'feat/auth-refresh', project: 'core', scope: 'you',
    ai: { label: 'no findings', cls: 'pill-ok' }, submitted: false, ciStatus: 'success', age: '2d',
  }],
  issues: [],
  activity: [],
  pipelines: [],
};

/**
 * The window-scroll double jsdom does not provide: jsdom has no layout, so
 * its own `window.scrollTo` is unimplemented (it only reports a jsdomError).
 * The stub records what the page asked for, exposes it through scrollX/Y the
 * way a browser would, and clamps against a settable `max` — the clamp is
 * how a test stands in for a document too short to take a saved offset (the
 * loading-skeleton case REGIONS_SCRIPT's pending re-apply exists for).
 */
interface ScrollDouble { x: number; y: number; max: number }

/** The page under test, with the host API stubbed before any script parses. */
function loadPage(html: string = renderDashboardHtml(state, 'testnonce')): {
  dom: JSDOM; posted: unknown[]; scroll: ScrollDouble;
} {
  const posted: unknown[] = [];
  const scroll: ScrollDouble = { x: 0, y: 0, max: Number.MAX_SAFE_INTEGER };
  // Still constructed with a bare VirtualConsole so stray jsdom noise never
  // prints as though the page were at fault.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (message: unknown) => posted.push(message),
      });
      window.scrollTo = ((x: number, y: number) => {
        scroll.x = Math.min(x, scroll.max);
        scroll.y = Math.min(y, scroll.max);
      }) as typeof window.scrollTo;
      Object.defineProperty(window, 'scrollX', { get: () => scroll.x });
      Object.defineProperty(window, 'scrollY', { get: () => scroll.y });
    },
  });
  return { dom, posted, scroll };
}

function click(dom: JSDOM, el: Element): void {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

/** A host-side region patch arriving in the page, as AppSurface posts it. */
function patch(dom: JSDOM, regions: Record<string, string>, routeKey?: string): void {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: routeKey === undefined
      ? { type: 'verdict:regions', regions }
      : { type: 'verdict:regions', routeKey, regions },
  }));
}

describe('dashboard page script', () => {
  it('posts a refresh when ⟳ is clicked, and marks the button busy on the way out', () => {
    const { dom, posted } = loadPage();
    const button = dom.window.document.getElementById('refresh');
    expect(button).not.toBeNull();

    click(dom, button!);

    expect(posted).toContainEqual({ type: 'refresh' });
    // The acknowledgement is what makes the button distinguishable from a
    // dead one while the fetch is in flight.
    expect(button!.classList.contains('busy')).toBe(true);
  });

  it('reaches the delegated handler from the glyph inside the button, not only the button itself', () => {
    const { dom, posted } = loadPage();
    const glyph = dom.window.document.querySelector('#refresh .refresh-glyph');
    expect(glyph).not.toBeNull();

    click(dom, glyph!);

    expect(posted).toContainEqual({ type: 'refresh' });
  });

  it('replaces the body when the refresh reply patches db-body, clearing the busy button with it', () => {
    const { dom } = loadPage();
    const document = dom.window.document;
    click(dom, document.getElementById('refresh')!);
    expect(document.querySelector('.mr-row')?.getAttribute('data-number')).toBe('2841');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'verdict:regions',
        regions: { 'db-body': '<header><button class="tool" id="refresh">⟳ 14:35</button></header><div class="mr-row" data-number="7">patched</div>' },
      },
    }));

    expect(document.getElementById('db-body')?.innerHTML).toContain('patched');
    expect(document.querySelector('.mr-row')?.getAttribute('data-number')).toBe('7');
    // Nothing clears the class explicitly — the patched markup simply has no
    // such class, which is why the busy state needs no timeout or reply hook.
    expect(document.getElementById('refresh')?.classList.contains('busy')).toBe(false);
  });

  it('arms the region listener by telling the host it is ready, or every patch would fall back to a full render', () => {
    const { posted } = loadPage();
    expect(posted).toContainEqual({ type: 'verdictReady' });
  });
});

// ---- view state around a patch (design D8, tasks 9.1, 9.2, 9.6) ------------
//
// The region contents below are synthetic, like the db-body patch above: the
// mechanism keys on stable ids, not on any screen's markup, and the dashboard
// page carries the same REGIONS_SCRIPT every full page does. What each block
// stands in for is named where it is used.

/** A region holding the three kinds of state a patch would otherwise discard. */
function statefulRegion(fieldValue: string): string {
  return '<details id="sec-checks"><summary>Failing checks</summary>details body</details>'
    + '<div id="log-pane">tall scrollable log</div>'
    + `<input id="note-field" value="${fieldValue}">`;
}

describe('a patch preserves the state a reviewer is standing in (task 9.1)', () => {
  it('keeps window scroll, an open section, a container scroll and the focused field\'s caret', () => {
    const { dom, scroll } = loadPage();
    const document = dom.window.document;
    patch(dom, { 'db-body': statefulRegion('auth') });

    // The reviewer's working position: section opened, log scrolled, caret
    // placed mid-word, page scrolled down.
    (document.getElementById('sec-checks') as HTMLDetailsElement).open = true;
    document.getElementById('log-pane')!.scrollTop = 140;
    document.getElementById('log-pane')!.scrollLeft = 6;
    const field = document.getElementById('note-field') as HTMLInputElement;
    field.focus();
    field.setSelectionRange(2, 4);
    dom.window.scrollTo(0, 380);

    patch(dom, { 'db-body': statefulRegion('auth') });

    // Everything the patch's innerHTML replacement reset comes back.
    expect((document.getElementById('sec-checks') as HTMLDetailsElement).open).toBe(true);
    expect(document.getElementById('log-pane')!.scrollTop).toBe(140);
    expect(document.getElementById('log-pane')!.scrollLeft).toBe(6);
    expect(document.activeElement?.id).toBe('note-field');
    expect((document.activeElement as HTMLInputElement).selectionStart).toBe(2);
    expect((document.activeElement as HTMLInputElement).selectionEnd).toBe(4);
    expect(scroll.y).toBe(380);
  });

  it('a deliberately closed section stays closed — the restore is the reviewer\'s state, not the default', () => {
    const { dom } = loadPage();
    const document = dom.window.document;
    patch(dom, { 'db-body': '<details id="sec-checks" open><summary>s</summary>b</details>' });
    (document.getElementById('sec-checks') as HTMLDetailsElement).open = false;

    patch(dom, { 'db-body': '<details id="sec-checks" open><summary>s</summary>b</details>' });

    expect((document.getElementById('sec-checks') as HTMLDetailsElement).open).toBe(false);
  });
});

describe('a patch never restores a stale value (tasks 9.2, 9.7)', () => {
  it('the regenerated text wins over what was typed, while focus and caret still come back', () => {
    const { dom } = loadPage();
    const document = dom.window.document;
    patch(dom, { 'db-body': statefulRegion('draft summary') });
    const field = document.getElementById('note-field') as HTMLInputElement;
    // Typed but never committed — exactly the value that must NOT survive a
    // patch that carries a regenerated one.
    field.value = 'my own words';
    field.focus();
    field.setSelectionRange(3, 3);

    patch(dom, { 'db-body': statefulRegion('regenerated summary') });

    const after = document.getElementById('note-field') as HTMLInputElement;
    expect(after.value).toBe('regenerated summary');
    expect(document.activeElement?.id).toBe('note-field');
    expect(after.selectionStart).toBe(3);
  });
});

// ---- per-route view state (design D8, tasks 9.4, 9.6) -----------------------

/** The resident shell showing the real dashboard, stamped with its route key. */
function loadShell(): ReturnType<typeof loadPage> {
  const regions = extractRouteRegions(renderDashboardHtml(state, 'testnonce'));
  expect(regions).toBeDefined();
  return loadPage(renderShellDocument({
    title: 'Verdict', nonce: 'testnonce', regions: regions!, routeKey: 'dashboard',
  }));
}

describe('leaving and returning to a route restores its view state (task 9.4)', () => {
  it('returning restores the route\'s scroll and expanded sections; a route never visited starts at top', () => {
    const loaded = loadShell();
    const { dom, scroll } = loaded;
    const document = dom.window.document;

    // Working state on the dashboard: an open section, a scrolled container,
    // the page scrolled down.
    patch(dom, { 'db-body': statefulRegion('auth') });
    (document.getElementById('sec-checks') as HTMLDetailsElement).open = true;
    document.getElementById('log-pane')!.scrollTop = 140;
    dom.window.scrollTo(0, 420);

    // Navigate to a route with no saved state: it starts at the top, exactly
    // as a freshly assigned document used to.
    patch(dom, { 'app-breadcrumb': '', 'app-route': '<div class="route-posted">posted rows</div>' }, 'posted');
    expect(scroll.y).toBe(0);
    dom.window.scrollTo(0, 50);

    // Return to the dashboard: the navigation patch renders defaults (closed
    // section, unscrolled container) and the saved snapshot reopens them.
    patch(dom, {
      'app-breadcrumb': '',
      'app-route': `<div class="route-dashboard"><div id="db-body">${statefulRegion('auth')}</div></div>`,
    }, 'dashboard');
    expect(scroll.y).toBe(420);
    expect((document.getElementById('sec-checks') as HTMLDetailsElement).open).toBe(true);
    expect(document.getElementById('log-pane')!.scrollTop).toBe(140);

    // And the posted route kept its own 50 — one route's state never lands
    // on another.
    patch(dom, { 'app-breadcrumb': '', 'app-route': '<div class="route-posted">posted rows</div>' }, 'posted');
    expect(scroll.y).toBe(50);
  });

  it('a route entered through a loading skeleton takes its saved state when the content patch lands, and never again after', () => {
    const loaded = loadShell();
    const { dom, scroll } = loaded;
    const document = dom.window.document;

    // Build state on the review route, then leave (saving it).
    patch(dom, {
      'app-breadcrumb': '',
      'app-route': `<div class="route-flow"><div id="flow-body">${statefulRegion('q')}</div></div>`,
    }, 'review');
    (document.getElementById('sec-checks') as HTMLDetailsElement).open = true;
    document.getElementById('log-pane')!.scrollTop = 90;
    dom.window.scrollTo(0, 500);
    patch(dom, { 'app-breadcrumb': '', 'app-route': '<div class="route-dashboard">dash</div>' }, 'dashboard');

    // Re-enter through a skeleton: the stateful ids are absent and the
    // document is too short for the saved offset (the clamp stands in for a
    // real browser clamping scrollTo against a short page), so the restore
    // cannot land yet.
    scroll.max = 10;
    patch(dom, {
      'app-breadcrumb': '',
      'app-route': '<div class="route-flow"><div id="flow-body">loading…</div></div>',
    }, 'review');
    expect(scroll.y).toBe(10);

    // The content patch for the same route: the held snapshot is reapplied
    // in full, once.
    scroll.max = Number.MAX_SAFE_INTEGER;
    patch(dom, { 'flow-body': statefulRegion('q') });
    expect(scroll.y).toBe(500);
    expect((document.getElementById('sec-checks') as HTMLDetailsElement).open).toBe(true);
    expect(document.getElementById('log-pane')!.scrollTop).toBe(90);

    // The reviewer scrolls on; a later patch must NOT yank the viewport back
    // to the entry-time position — the pending snapshot was dropped when it
    // was applied.
    dom.window.scrollTo(0, 620);
    patch(dom, { 'flow-body': statefulRegion('q') });
    expect(scroll.y).toBe(620);
  });

  it('a route entered with full content never re-applies its snapshot on a later patch', () => {
    const loaded = loadShell();
    const { dom, scroll } = loaded;

    patch(dom, { 'db-body': statefulRegion('auth') });
    dom.window.scrollTo(0, 420);
    patch(dom, { 'app-breadcrumb': '', 'app-route': '<div class="route-posted">rows</div>' }, 'posted');
    // Return with the full content in the navigation patch itself: the
    // restore lands immediately, so nothing stays pending.
    patch(dom, {
      'app-breadcrumb': '',
      'app-route': `<div class="route-dashboard"><div id="db-body">${statefulRegion('auth')}</div></div>`,
    }, 'dashboard');
    expect(scroll.y).toBe(420);

    // Scroll away, then take an ordinary same-route patch minutes later: the
    // viewport stays where the reviewer put it.
    dom.window.scrollTo(0, 800);
    patch(dom, { 'db-body': statefulRegion('auth') });
    expect(scroll.y).toBe(800);
  });

  it('the snapshot map is bounded: the oldest route\'s state is evicted, not kept forever', () => {
    const loaded = loadShell();
    const { dom, scroll } = loaded;

    // Scroll on the first changeset-like route, then churn through more
    // distinct route keys than the cap holds (the changeset routes are keyed
    // per changeset id, so an unbounded map would grow for the life of the
    // panel).
    patch(dom, { 'app-breadcrumb': '', 'app-route': '<div class="route-changeset">one</div>' }, 'changeset:1');
    dom.window.scrollTo(0, 100);
    for (let n = 2; n <= 10; n += 1) {
      patch(dom, { 'app-breadcrumb': '', 'app-route': `<div class="route-changeset">${n}</div>` }, `changeset:${n}`);
    }

    // Returning to the first: its snapshot was evicted, so it starts at the
    // top like a route never seen.
    patch(dom, { 'app-breadcrumb': '', 'app-route': '<div class="route-changeset">one</div>' }, 'changeset:1');
    expect(scroll.y).toBe(0);
  });
});
