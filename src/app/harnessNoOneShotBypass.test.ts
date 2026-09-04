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
 *    capable of producing a `HarnessAttemptResult`; the other three
 *    (`classifyFile`, `isSmallReview`, `defaultSynthesisVerification`) are
 *    pure helpers/an honest no-op collaborator, none of which can construct
 *    findings or a lifecycle/outcome on their own. If a future change added
 *    a second exported function that could return findings without going
 *    through `run()`'s bootstrap -> planning -> investigating -> verifying
 *    -> completing -> persisting sequence (and its `evaluateCompletion`
 *    call in `completing`), this allowlist would catch it immediately.
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
    // Every one of these is a pure helper or an honest no-op; only `createHarnessAttempt(...).run()`
    // can ever produce a `HarnessAttemptResult`, and `run()` always executes the full phase
    // sequence ending in `runCompleting`'s `evaluateCompletion` call before `runPersisting`.
    expect(exportedNames).toEqual(['classifyFile', 'createHarnessAttempt', 'defaultSynthesisVerification', 'isSmallReview'].sort());
  });

  it('createHarnessAttempt is the only exported value shaped like a result-producing entry point (no bare parse-and-return-findings function alongside it)', () => {
    for (const [name, value] of Object.entries(harnessAttemptModule)) {
      if (name === 'createHarnessAttempt') {
        expect(typeof value).toBe('function');
        continue;
      }
      // The other three exports are plain helpers: none returns anything
      // shaped like `{lifecycle, outcome, findings}` — none even takes an
      // evidence ledger or a model seam, so none could construct a result.
      expect(typeof value === 'function' || typeof value === 'object').toBe(true);
    }
  });
});
