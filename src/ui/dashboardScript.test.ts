/**
 * The refresh hop, executed rather than asserted about as text (bug 5: "the
 * refresh button does not work"). Every other dashboard test greps the
 * rendered HTML, which cannot tell a wired button from a dead one. This runs
 * the real page script in jsdom: click ⟳, prove the message leaves, then post
 * the region patch back and prove it lands.
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

/** The page under test, with the host API stubbed before any script parses. */
function loadPage(): { dom: JSDOM; posted: unknown[] } {
  const posted: unknown[] = [];
  // The region patch ends by restoring scroll, and jsdom does not implement
  // window.scrollTo — it reports that as a jsdomError on the virtual console,
  // which would otherwise print on every run. The page is not the thing at
  // fault, so drop jsdomErrors here rather than changing theme.ts for a test.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(renderDashboardHtml(state, 'testnonce'), {
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (message: unknown) => posted.push(message),
      });
    },
  });
  return { dom, posted };
}

function click(dom: JSDOM, el: Element): void {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
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
