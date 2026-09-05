import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SidebarActiveRun } from './sidebarHtml';

interface FakeItem {
  priority: number;
  text: string;
  tooltip: string;
  command: string;
  visible: boolean;
  show: () => void;
  hide: () => void;
  dispose: () => void;
}

const items = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1 },
  window: {
    createStatusBarItem: vi.fn((_alignment: number, priority: number) => {
      const item = {
        priority,
        text: '',
        tooltip: '',
        command: '',
        visible: false,
        show(): void {
          item.visible = true;
        },
        hide(): void {
          item.visible = false;
        },
        dispose: vi.fn(),
      };
      items.push(item as unknown as Record<string, unknown>);
      return item;
    }),
  },
  commands: { executeCommand: vi.fn() },
}));

/** The review segments in creation order: verdict, agent, keys, bell. */
function segments(): [FakeItem, FakeItem, FakeItem, FakeItem] {
  return items.slice(0, 4) as unknown as [FakeItem, FakeItem, FakeItem, FakeItem];
}

/** The fifth: background polling paused, hidden whenever it is running. */
function pausedSegment(): FakeItem {
  return items[4] as unknown as FakeItem;
}

/** The sixth: how many reviews are running, plus a concise read on the lead one. */
function runsSegment(): FakeItem {
  return items[5] as unknown as FakeItem;
}

/** A `SidebarActiveRun` fixture (task 14.5) — the same shape `toSidebarActiveRuns` produces, never a status-bar-local re-derivation. */
function run(over: Partial<SidebarActiveRun> = {}): SidebarActiveRun {
  return {
    key: 'repo-1!2841',
    label: '!2841',
    lifecycle: 'investigating',
    elapsedMs: 30_000,
    progressMode: 'indeterminate',
    attention: 'none',
    ...over,
  };
}

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

describe('status bar segments (spec §14)', () => {
  beforeEach(() => {
    items.length = 0;
  });

  it('shows only the Verdict segment with no review, pointing at the dashboard', async () => {
    const { VerdictStatusBar } = await import('./sidebar.js');
    const bar = new VerdictStatusBar();
    const [verdict, agent, keys] = segments();

    expect(verdict.text).toBe('$(verified) Verdict: no active review');
    expect(verdict.command).toBe('codeVerdict.openDashboard');
    expect(verdict.visible).toBe(true);
    // The agent and keys segments describe a review in progress.
    expect(agent.visible).toBe(false);
    expect(keys.visible).toBe(false);
    bar.dispose();
  });

  it('names the merge request, the agent and the keys hint during a review', async () => {
    const { VerdictStatusBar } = await import('./sidebar.js');
    const bar = new VerdictStatusBar();

    bar.setActiveReview(review);
    const [verdict, agent, keys] = segments();
    expect(verdict.text).toBe('$(verified) Verdict: !2841 · 5 left');
    expect(verdict.tooltip).toBe(
      '!2841 · Refactor token refresh — 2 accepted, 1 rejected, 0 skipped',
    );
    // Clicking through goes to the review being counted, not the dashboard.
    expect(verdict.command).toBe('codeVerdict.openReview');
    expect(agent.text).toBe('HVE Core / PR Review');
    expect(agent.command).toBe('codeVerdict.selectAgent');
    expect(agent.visible).toBe(true);
    expect(keys.text).toBe('$(keyboard) ? keys');
    expect(keys.command).toBe('codeVerdict.internal.keyboardHelp');
    expect(keys.visible).toBe(true);

    bar.setActiveReview({ ...review, counts: { accepted: 8, rejected: 0, skipped: 0, undecided: 0 } });
    expect(verdict.text).toBe('$(verified) Verdict: !2841 · all triaged');
    bar.dispose();
  });

  it('keeps the segments in spec order, left to right', async () => {
    const { VerdictStatusBar } = await import('./sidebar.js');
    const bar = new VerdictStatusBar();
    const [verdict, agent, keys, bell] = segments();

    // Higher priority sorts further left within the same alignment.
    expect(verdict.priority).toBeGreaterThan(agent.priority);
    expect(agent.priority).toBeGreaterThan(keys.priority);
    expect(keys.priority).toBeGreaterThan(bell.priority);
    bar.dispose();
  });

  it('shows the 🔔 count independent of any review, hidden at zero', async () => {
    const { VerdictStatusBar } = await import('./sidebar.js');
    const bar = new VerdictStatusBar();
    const [, , , bell] = segments();

    // Notifications arrive with no review open (a pipeline fails, a reply
    // lands) — the bell must not depend on setActiveReview.
    expect(bell.visible).toBe(false);
    bar.setNotifications(2);
    expect(bell.text).toBe('$(bell) 2');
    expect(bell.command).toBe('codeVerdict.internal.showNotifications');
    expect(bell.visible).toBe(true);
    bar.setActiveReview(undefined);
    expect(bell.visible).toBe(true);
    bar.setNotifications(0);
    expect(bell.visible).toBe(false);
    bar.dispose();
  });

  it('hides the paused segment until polling actually stops', async () => {
    const { VerdictStatusBar } = await import('./sidebar.js');
    const bar = new VerdictStatusBar();
    const paused = pausedSegment();

    // Polling running is the ordinary state, and the ordinary state gets no
    // segment — a permanent "everything is fine" indicator is noise.
    expect(paused.visible).toBe(false);
    expect(paused.priority).toBeLessThan(segments()[3].priority);
    bar.dispose();
  });

  it('names the platform and the wait while polling is paused, then clears', async () => {
    const { VerdictStatusBar } = await import('./sidebar.js');
    const bar = new VerdictStatusBar();
    const paused = pausedSegment();

    bar.setPollPaused({ platformName: 'GitHub', resumesAt: Date.now() + 12 * 60_000 });
    expect(paused.visible).toBe(true);
    expect(paused.text).toBe('$(clock) Verdict: updates paused');
    // The question during the pause is "until when?", which is why this lives
    // on a surface that stays up rather than in a toast.
    expect(paused.tooltip).toContain('GitHub');
    expect(paused.tooltip).toContain('about 12 minutes');

    bar.setPollPaused(undefined);
    expect(paused.visible).toBe(false);
    bar.dispose();
  });

  it('reverts when the review tab closes', async () => {
    const { VerdictStatusBar } = await import('./sidebar.js');
    const bar = new VerdictStatusBar();

    bar.setActiveReview(review);
    bar.setActiveReview(undefined);
    const [verdict, agent, keys] = segments();
    expect(verdict.text).toBe('$(verified) Verdict: no active review');
    expect(verdict.command).toBe('codeVerdict.openDashboard');
    expect(agent.visible).toBe(false);
    expect(keys.visible).toBe(false);
    bar.dispose();
  });

  /**
   * Task 14.5 (design.md D10/D14): active-run count plus a concise read on
   * the lead run — the same `runLifecycleLabel`/determinate-or-indeterminate
   * decision the sidebar's own active-run list renders from
   * (`statusBarRunsSummary`, ./sidebarHtml.ts), never a status-bar-local
   * re-derivation.
   */
  describe('the running-reviews segment (task 14.5)', () => {
    it('hides when nothing is running', async () => {
      const { VerdictStatusBar } = await import('./sidebar.js');
      const bar = new VerdictStatusBar();

      bar.setActiveRuns([]);
      expect(runsSegment().visible).toBe(false);
      bar.dispose();
    });

    it('names the count and the lead run\'s phase, with an elapsed clock while progress is indeterminate', async () => {
      const { VerdictStatusBar } = await import('./sidebar.js');
      const bar = new VerdictStatusBar();

      bar.setActiveRuns([run({ lifecycle: 'investigating', elapsedMs: 65_000 })]);
      const runs = runsSegment();
      expect(runs.visible).toBe(true);
      expect(runs.text).toBe('$(sync~spin) 1 · Investigating · 1:05');
      expect(runs.tooltip).toContain('!2841');
      expect(runs.tooltip).toContain('Investigating');
      expect(runs.tooltip).toContain('1:05');
      bar.dispose();
    });

    it('shows a real fraction only once a denominator exists — never a fabricated percentage', async () => {
      const { VerdictStatusBar } = await import('./sidebar.js');
      const bar = new VerdictStatusBar();

      bar.setActiveRuns([
        run({ lifecycle: 'verifying', progressMode: 'determinate', progressUnits: { completed: 5, total: 20 } }),
      ]);
      expect(runsSegment().text).toBe('$(sync~spin) 1 · Verifying · 5/20');
      expect(runsSegment().text).not.toMatch(/%/);
      bar.dispose();
    });

    it('counts every run in flight, naming only the lead (earliest-triggered) one — never growing with every extra run', async () => {
      const { VerdictStatusBar } = await import('./sidebar.js');
      const bar = new VerdictStatusBar();

      bar.setActiveRuns([
        run({ key: 'repo-1!1', label: '!1', lifecycle: 'planning' }),
        run({ key: 'repo-1!2', label: '!2', lifecycle: 'investigating' }),
        run({ key: 'repo-1!3', label: '!3', lifecycle: 'queued' }),
      ]);
      expect(runsSegment().text).toBe('$(sync~spin) 3 · Planning · 0:30');
      bar.dispose();
    });

    it('reports "queued" as the lead run\'s unit, never an elapsed clock for a slot it has not started using', async () => {
      const { VerdictStatusBar } = await import('./sidebar.js');
      const bar = new VerdictStatusBar();

      bar.setActiveRuns([run({ lifecycle: 'queued' })]);
      expect(runsSegment().text).toBe('$(sync~spin) 1 · Queued · queued');
      bar.dispose();
    });

    it('names when the lead run needs attention', async () => {
      const { VerdictStatusBar } = await import('./sidebar.js');
      const bar = new VerdictStatusBar();

      bar.setActiveRuns([run({ lifecycle: 'paused', attention: 'attentionRequired' })]);
      expect(runsSegment().tooltip).toContain('needs your attention');
      bar.dispose();
    });
  });
});
