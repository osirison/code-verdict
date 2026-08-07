import { beforeEach, describe, expect, it, vi } from 'vitest';

const item = vi.hoisted(() => ({
  text: '',
  tooltip: '',
  command: '',
  show: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1 },
  window: { createStatusBarItem: vi.fn(() => item) },
  commands: { executeCommand: vi.fn() },
}));

const review = {
  headline: '!2841 · Refactor token refresh',
  refLabel: '!2841',
  context: 'feat/auth-refresh',
  agent: 'HVE Core / PR Review',
  added: 284,
  removed: 91,
  counts: { accepted: 2, rejected: 1, skipped: 0, undecided: 5 },
  items: [],
};

describe('status bar Verdict segment (spec §14)', () => {
  beforeEach(() => {
    item.show.mockClear();
  });

  it('starts on "no active review" and points at the dashboard', async () => {
    const { VerdictStatusBar } = await import('./sidebar.js');
    const bar = new VerdictStatusBar();

    expect(item.text).toBe('$(verified) Verdict: no active review');
    expect(item.command).toBe('codeVerdict.openDashboard');
    expect(item.show).toHaveBeenCalledOnce();
    bar.dispose();
  });

  it('names the merge request and how much triage is left', async () => {
    const { VerdictStatusBar } = await import('./sidebar.js');
    const bar = new VerdictStatusBar();

    bar.setActiveReview(review);
    expect(item.text).toBe('$(verified) Verdict: !2841 · 5 left');
    expect(item.tooltip).toBe(
      '!2841 · Refactor token refresh — 2 accepted, 1 rejected, 0 skipped',
    );
    // Clicking through goes to the review being counted, not the dashboard.
    expect(item.command).toBe('codeVerdict.openReview');

    bar.setActiveReview({ ...review, counts: { accepted: 8, rejected: 0, skipped: 0, undecided: 0 } });
    expect(item.text).toBe('$(verified) Verdict: !2841 · all triaged');
    bar.dispose();
  });

  it('reverts when the review tab closes', async () => {
    const { VerdictStatusBar } = await import('./sidebar.js');
    const bar = new VerdictStatusBar();

    bar.setActiveReview(review);
    bar.setActiveReview(undefined);
    expect(item.text).toBe('$(verified) Verdict: no active review');
    expect(item.command).toBe('codeVerdict.openDashboard');
    bar.dispose();
  });
});
