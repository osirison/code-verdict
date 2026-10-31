/**
 * Posted reviews: sending a reply while the send is still in flight.
 *
 * Reported from a live run: two Enter presses during one send post the reply
 * twice, and text typed while a send is in flight is dropped. These drive the
 * real rendered page script in jsdom and press keys the way a person would;
 * the host's answer is played back by hand as a `verdict:regions` patch. The
 * panel's half (one send per thread, the draft kept on success and failure)
 * is in postedReviews.test.ts; the triage ask box is at the end of
 * reviewFlowHtml.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { GITLAB_VOCABULARY } from '../testing/specFixtures';
import type { PostedReviewView, PostedThreadView } from '../app/postedReviews';
import type { PostedRow, PostedViewState } from './postedReviewsHtml';
import { renderPostedReviewsHtml, renderPostedReviewsRegions } from './postedReviewsHtml';

const thread: PostedThreadView = {
  threadId: 'thread-1',
  title: 'Refresh token logged in error path',
  severity: 'major',
  file: 'src/auth/token.ts',
  line: 63,
  status: 'replied',
  yourBody: 'This logs the refresh token in cleartext.',
  replies: [{ author: 'dana', body: 'Pushed a fix.', at: '2026-08-20T11:00:00.000Z', yours: false }],
};
const view: PostedReviewView = {
  repoId: '9101',
  crNumber: '2841',
  agentLabel: 'Verdict · Demo Review',
  submittedAt: '2026-08-20T10:00:00.000Z',
  threads: [thread],
  counts: { you: 1, author: 0, closed: 0 },
};
const row: PostedRow = { view, refLabel: '!2841', title: 'Add rate limiting', project: 'core', age: '2d', archived: false };
const postedState = (replyDrafts: Record<string, string> = {}): PostedViewState => ({
  vocabulary: GITLAB_VOCABULARY,
  podName: 'Platform squad',
  now: Date.parse('2026-08-22T10:00:00.000Z'),
  waitingOnYouTotal: 1,
  rows: [row],
  showArchived: false,
  archivedCount: 0,
  expandedThreadId: 'thread-1',
  opinions: {},
  replyDrafts,
});

function load(html: string): { dom: JSDOM; posted: Array<{ type?: string; text?: string }> } {
  const posted: Array<{ type?: string; text?: string }> = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (m: { type?: string }) => posted.push(m),
      });
    },
  });
  posted.length = 0;
  return { dom, posted };
}

/** One keystroke's worth of typing: set the value, then fire the input event. */
function type(dom: JSDOM, el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
function enter(dom: JSDOM, el: Element, init: KeyboardEventInit = {}): void {
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }));
}
function patch(dom: JSDOM, regions: Record<string, string>): void {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'verdict:regions', regions } }));
}

describe('posted reviews: a reply sent while the send is in flight', () => {
  const field = (dom: JSDOM): HTMLInputElement => dom.window.document.getElementById('reply-input') as HTMLInputElement;
  const replies = (posted: Array<{ type?: string }>): unknown[] => posted.filter((m) => m.type === 'reply');

  function openAndSend(text: string) {
    const page = load(renderPostedReviewsHtml(postedState(), 'nonce123'));
    field(page.dom).focus();
    type(page.dom, field(page.dom), text);
    enter(page.dom, field(page.dom));
    return page;
  }

  it('a second Enter before the host answers does not post the reply again', () => {
    const { dom, posted } = openAndSend('Still not convinced.');
    expect(replies(posted)).toHaveLength(1);
    enter(dom, field(dom));
    expect(replies(posted)).toHaveLength(1);
  });

  it('a second click on Send, or an Enter after a click, does not post the reply again', () => {
    const { dom, posted } = openAndSend('Still not convinced.');
    const send = dom.window.document.querySelector('[data-reply-send]') as HTMLElement;
    send.click();
    send.click();
    enter(dom, field(dom));
    expect(replies(posted)).toHaveLength(1);
  });

  it('text typed after the Enter is kept when the send lands, and is not posted', () => {
    const { dom, posted } = openAndSend('Still not convinced.');
    // A person types at the caret: whatever the box holds, the new text goes on the end.
    type(dom, field(dom), `${field(dom).value}And one more thing`);
    // The host's success: the draft it held is gone, the region repaints.
    patch(dom, renderPostedReviewsRegions(postedState()));
    expect(field(dom).value).toBe('And one more thing');
    expect(replies(posted)).toHaveLength(1);
  });
});
