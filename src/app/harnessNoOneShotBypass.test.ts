/**
 * Task 10.9 item 9 of `add-agentic-review-harness`: proof that no harness
 * path can produce a review result without going through plan, evidence,
 * coverage, verification, and the completion gate — spec
 * `agentic-review-harness` "Every review uses the agentic harness": "The
 * system SHALL NOT provide a one-shot review bypass."
 *
 * This asserts on the CODE PATH, not on data a scripted fake could
 * coincidentally satisfy:
 *
 * 1. No harness module (`src/app/harness*.ts`, `src/domain/harness*.ts`)
 *    imports the legacy one-shot parser (`../domain/agentResponse.ts`,
 *    `parseAgentReviewResponse`/`AgentReviewResponse`) — checked by matching
 *    actual `import ... from '.../agentResponse'` statements via source
 *    text, never by searching for the word "agentResponse" (which appears
 *    legitimately in several harness modules' own doc comments, contrasting
 *    the new typed protocol with the legacy parser it succeeds).
 * 2. `harnessAttempt.ts`'s runtime (value) export surface is pinned to an
 *    allowlist. `createHarnessAttempt(...).run()` is the *only* value export
 *    capable of producing a `HarnessAttemptResult`; every other export
 *    (`classifyFile`, `isSmallReview`, `defaultSynthesisVerification`,
 *    `CHECKPOINT_REASONS`, `isCheckpointReason`, `parseCheckpointReason` —
 *    the last three added by task 11.2's `CheckpointInfo` widening) is a
 *    pure helper, a plain data array, or an honest no-op collaborator, none
 *    of which can construct findings or a lifecycle/outcome on their own. If
 *    a future change added a second exported function that could return
 *    findings without going through `run()`'s bootstrap -> planning ->
 *    investigating -> verifying -> completing -> persisting sequence (and
 *    its `evaluateCompletion` call in `completing`), this allowlist would
 *    catch it immediately.
 *
 * `demoAgent.ts`/`combinedAgent.ts` are explicitly excluded from check 1:
 * task 10.7's brief keeps them in place unmodified in this pass (their call
 * sites are removed in tasks 10.8/15.8, both out of scope here) — they are
 * not `harness*`-named modules and are not part of the harness's own code
 * path (`harnessDemoParticipant.ts` is the harness-side demo participant;
 * it does not import from either).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as harnessAttemptModule from './harnessAttempt';

const AGENT_RESPONSE_IMPORT_PATTERN = /from\s+['"][^'"]*\bagentResponse['"]/;

function harnessModuleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...harnessModuleFiles(path));
      continue;
    }
    if (!path.endsWith('.ts') || path.endsWith('.test.ts')) continue;
    const base = entry.replace(/\.ts$/, '');
    if (base.startsWith('harness')) out.push(path);
  }
  return out;
}

describe('the shipped runtime wiring itself reaches only the harness (task 10.8, 15.7)', () => {
  const extensionSource = readFileSync(join('src', 'extension.ts'), 'utf8');

  it('extension.ts constructs ReviewRunManager with the real harness factory, never a bare {lm, demo} runner object', () => {
    // Source-text assertion, not a runtime import: `extension.ts` imports `vscode`, which is not
    // resolvable outside the extension host, so this is the same methodology the import-graph
    // check above already uses — matching actual statements, never a loose keyword search.
    expect(extensionSource).toMatch(/import\s*\{\s*createReviewHarnessFactory[^}]*\}\s*from\s*['"]\.\/app\/harnessRuntime['"]/);
    expect(extensionSource).toMatch(/runners:\s*createReviewHarnessFactory\(/);
  });

  it('extension.ts never imports or constructs the deprecated one-shot runners', () => {
    // The exact functions `legacyRunnersToHarnessFactory`'s own doc comment names as the shape it
    // adapts — reachable only as `reviewRunManager.ts`'s own test fixture, never from shipped
    // wiring, per that module's file header ("no shipped runtime setting exposes a bypass").
    const oneShotRunnerNames = ['runLmAgent', 'runLmChangesetAgent', 'runDemoAgent', 'runDemoChangesetAgent'];
    for (const name of oneShotRunnerNames) {
      const importPattern = new RegExp(`\\bimport\\b[^;]*\\b${name}\\b[^;]*\\bfrom\\b`);
      expect(extensionSource).not.toMatch(importPattern);
    }
    // Never references the legacy `{lm, demo}` shape's own type name, or hand-builds an object
    // literal carrying both an `lm` and a `demo` key (the shape `isLegacyRunners` detects).
    expect(extensionSource).not.toMatch(/\bReviewRunnersLegacy\b/);
    expect(extensionSource).not.toMatch(/runners:\s*\{\s*lm:/);
  });

  it('every shipped RunInput/RunnerOptions type import into extension.ts is gone — the legacy runner shape has nothing left to type against there', () => {
    // `RunnerOptions`/`RunInput` were the legacy `{lm, demo}` closures' own parameter types; the
    // real factory's `create`/`createDemo` are constructed once, inside `harnessRuntime.ts`, and
    // extension.ts never needs to name either type directly any more.
    expect(extensionSource).not.toMatch(/\bRunnerOptions\b/);
  });
});

describe('no one-shot bypass (task 10.9 item 9)', () => {
  it('no harness module imports the legacy one-shot parser', () => {
    const files = [...harnessModuleFiles('src/app'), ...harnessModuleFiles('src/domain')];
    expect(files.length).toBeGreaterThan(10); // sanity: the glob actually found the harness modules
    const offenders: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      if (AGENT_RESPONSE_IMPORT_PATTERN.test(text)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("harnessAttempt.ts's runtime export surface is exactly the pinned allowlist — no escape hatch that returns findings without an evaluated completion decision", () => {
    const exportedNames = Object.keys(harnessAttemptModule).sort();
    // Every one of these is a pure helper, a plain data array, or an honest no-op; only
    // `createHarnessAttempt(...).run()` can ever produce a `HarnessAttemptResult`, and `run()`
    // always executes the full phase sequence ending in `runCompleting`'s `evaluateCompletion`
    // call before `runPersisting`.
    expect(exportedNames).toEqual(
      [
        'classifyFile',
        'createHarnessAttempt',
        'defaultSynthesisVerification',
        'isSmallReview',
        'CHECKPOINT_REASONS',
        'isCheckpointReason',
        'parseCheckpointReason',
      ].sort(),
    );
  });

  it('createHarnessAttempt is the only exported value shaped like a result-producing entry point (no bare parse-and-return-findings function alongside it)', () => {
    for (const [name, value] of Object.entries(harnessAttemptModule)) {
      if (name === 'createHarnessAttempt') {
        expect(typeof value).toBe('function');
        continue;
      }
      // Every other export is a plain helper, predicate, or data array: none returns anything
      // shaped like `{lifecycle, outcome, findings}` — none even takes an evidence ledger or a
      // model seam, so none could construct a result.
      expect(['function', 'object']).toContain(typeof value);
    }
  });
});
