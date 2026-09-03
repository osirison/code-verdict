/**
 * Task 10.1 gap 2 — "Progress within an unchanged status" (spec: "Data that
 * has not changed notifies nobody"): a run reports progress at a 250ms floor
 * while streaming, and only a status change is one screens showing only the
 * run's status need to hear about.
 *
 * `extension.ts` has no test of its own — `activate()` wires together the
 * whole command surface, every panel and the notifier, and building all of
 * that just to drive one run's status through `runManager.onChange` is not
 * practical. The guard at that call site (`extension.ts:163-167` before this
 * task) is extracted into `RunStatusGate` so it can be driven directly; this
 * is that test, not a stand-in for one.
 */
import { describe, expect, it } from 'vitest';
import { RunStatusGate } from './runStatusGate';

describe('RunStatusGate — the dashboard repaints on a status change, never on progress alone', () => {
  it('reports the first status seen for a key as a change', () => {
    const gate = new RunStatusGate();
    expect(gate.changed('run-1', 'queued')).toBe(true);
  });

  it('reports repeated progress at the same status as no change', () => {
    const gate = new RunStatusGate();
    expect(gate.changed('run-1', 'running')).toBe(true);
    // Four emissions a second at the 250ms progress floor, status unchanged —
    // none of them may repaint the dashboard.
    expect(gate.changed('run-1', 'running')).toBe(false);
    expect(gate.changed('run-1', 'running')).toBe(false);
    expect(gate.changed('run-1', 'running')).toBe(false);
  });

  it('reports queued -> running -> succeeded as three changes', () => {
    const gate = new RunStatusGate();
    expect(gate.changed('run-1', 'queued')).toBe(true);
    expect(gate.changed('run-1', 'running')).toBe(true);
    expect(gate.changed('run-1', 'succeeded')).toBe(true);
  });

  it('tracks each run key independently — one run\'s progress never masks another\'s status change', () => {
    const gate = new RunStatusGate();
    expect(gate.changed('run-1', 'running')).toBe(true);
    expect(gate.changed('run-2', 'running')).toBe(true);
    expect(gate.changed('run-1', 'running')).toBe(false);
    // run-2 changing must still be reported, independent of run-1's history.
    expect(gate.changed('run-2', 'succeeded')).toBe(true);
  });

  it('forgets a terminal status, so a later run reusing the same key starts its own queued -> running transition', () => {
    const gate = new RunStatusGate();
    expect(gate.changed('run-1', 'running')).toBe(true);
    expect(gate.changed('run-1', 'succeeded')).toBe(true);

    // The run manager's own keys are stable per target, so a re-run on the
    // same change request reuses this exact key. If the terminal status were
    // left in the map, this 'running' would look identical to a stale replay
    // of the record above rather than a new run's real first transition —
    // it must still report a change.
    expect(gate.changed('run-1', 'queued')).toBe(true);
    expect(gate.changed('run-1', 'running')).toBe(true);
  });
});
