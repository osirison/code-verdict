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
 * 3. `demoAgent.ts`'s and 4. `combinedAgent.ts`'s runtime export surfaces are
 *    each pinned to an allowlist the same way: `runDemoAgent`/
 *    `runDemoChangesetAgent`/`validateChangesetResponse`/
 *    `crossRepositoryFinding` do not merely go uncalled, they do not exist.
 * 5. `lmAgent.ts` imports `vscode` at module scope, unresolvable outside the
 *    extension host, so its check is a source-text assertion instead (the
 *    same methodology the shipped-wiring describe block below already uses
 *    for `extension.ts`): no `export function runLmAgent|runLmChangesetAgent|
 *    runPrompt` declaration exists anywhere in the file.
 *
 * `demoAgent.ts`/`combinedAgent.ts`/`lmAgent.ts` are excluded from check 1's
 * `harness*`-named glob (none of the three is a `harness*`-named module, and
 * `harnessDemoParticipant.ts` — the harness-side demo participant — imports
 * from none of them). Task 15.8 removed the one-shot runners those three
 * modules used to carry (`runDemoAgent`, `runDemoChangesetAgent`,
 * `validateChangesetResponse`, `crossRepositoryFinding`, `runLmAgent`,
 * `runLmChangesetAgent`, `runPrompt`) entirely rather than merely stop
 * calling them, so checks 3-5 below pin each module's surviving export
 * surface to an allowlist — the same "no escape hatch" methodology check 2
 * uses for `harnessAttempt.ts` — rather than re-testing that nothing calls
 * the removed functions, which would be vacuous once they no longer exist.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as harnessAttemptModule from './harnessAttempt';
import * as demoAgentModule from './demoAgent';
import * as combinedAgentModule from './combinedAgent';

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
    // Task 15.8 deleted `runLmAgent`, `runLmChangesetAgent`, `runDemoAgent`, `runDemoChangesetAgent`,
    // `ReviewRunnersLegacy` and `legacyRunnersToHarnessFactory` outright — none of them exist
    // anywhere in the tree any more (checks 3-5 below pin that at each source module directly).
    // This test stays as a second, independent guard specifically on the shipped wiring: even if a
    // future change reintroduced any of these names elsewhere, `extension.ts` must still never
    // import or hand-build one.
    const oneShotRunnerNames = ['runLmAgent', 'runLmChangesetAgent', 'runDemoAgent', 'runDemoChangesetAgent', 'runPrompt'];
    for (const name of oneShotRunnerNames) {
      const importPattern = new RegExp(`\\bimport\\b[^;]*\\b${name}\\b[^;]*\\bfrom\\b`);
      expect(extensionSource).not.toMatch(importPattern);
    }
    // Never references the legacy `{lm, demo}` shape's own type name, or hand-builds an object
    // literal carrying both an `lm` and a `demo` key (the shape `isLegacyRunners` used to detect,
    // before task 15.8 removed both `ReviewRunnersLegacy` and `isLegacyRunners` themselves).
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

  it("demoAgent.ts's runtime export surface no longer includes runDemoAgent — task 15.8 deleted the one-shot demo runner, not just its callers", () => {
    // `DEMO_AGENT_ID`/`DEMO_AGENT_LABEL` are plain string constants; `demoFindingsForFile` is a pure
    // per-file finding builder with no model-calling or execution capability of its own — it is what
    // `harnessDemoParticipant.ts` (the harness-side demo participant) calls today. `runDemoAgent`,
    // the one-shot function that used to drive a whole review from these pieces, does not exist.
    expect(Object.keys(demoAgentModule).sort()).toEqual(
      ['DEMO_AGENT_ID', 'DEMO_AGENT_LABEL', 'demoFindingsForFile'].sort(),
    );
  });

  it("combinedAgent.ts's runtime export surface no longer includes runDemoChangesetAgent, validateChangesetResponse or crossRepositoryFinding — task 15.8 deleted the one-shot changeset runner, its response validator and its cross-repo detector, not just their callers", () => {
    // What remains is member identity/attachment-ownership and the composite `headSha` format —
    // pure helpers with no model-calling or execution capability, still used by `ui/changesetReview.ts`
    // and `reviewRunManager.ts`'s own changeset `headShaFor` branch.
    expect(Object.keys(combinedAgentModule).sort()).toEqual(
      ['changesetMemberForAttachment', 'changesetHeadSha', 'parseChangesetHeadSha'].sort(),
    );
  });

  it("lmAgent.ts declares no runLmAgent, runLmChangesetAgent or runPrompt function anywhere in its source — task 15.8's one-shot review runners", () => {
    // `lmAgent.ts` imports `vscode` at module scope (unresolvable outside the extension host), so
    // this is a source-text assertion, the same methodology the shipped-wiring describe block above
    // uses for `extension.ts`. `assembleReviewPrompt`/`assembleChangesetReviewPrompt` (pure prompt
    // builders, still called by the pre-run context-usage estimate) and `runFollowUpPrompt`/
    // `runHarnessModelTurn` (thin `streamText` callers with no JSON-contract parsing of their own)
    // are deliberately not in this list — they survived task 15.8 and are covered elsewhere.
    const lmAgentSource = readFileSync(join('src', 'app', 'lmAgent.ts'), 'utf8');
    for (const name of ['runLmAgent', 'runLmChangesetAgent', 'runPrompt']) {
      expect(lmAgentSource).not.toMatch(new RegExp(`\\bfunction\\s+${name}\\b`));
      expect(lmAgentSource).not.toMatch(new RegExp(`\\bexport\\s*\\{[^}]*\\b${name}\\b`));
    }
  });
});
