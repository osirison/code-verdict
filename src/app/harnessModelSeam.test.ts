import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_HARNESS_POLICY } from '../domain/harnessPolicy';
import { DEFAULT_CRITERIA, SEVERITY_ORDER } from '../domain/criteria';
import { parseModelTurn } from '../domain/harnessProtocol';
import type { RunPhase } from '../domain/harnessActivity';
import { buildBootstrapEnvelope, buildBootstrapSection, type BootstrapEnvelope, type BuildBootstrapEnvelopeInput } from '../domain/harnessBootstrap';
import { HARNESS_TOOL_CONTRACT_VERSION } from '../domain/harnessTools';
import {
  createLiveModelSeam,
  PromptCeilingExceededError,
  renderInvestigationMap,
  renderModelPrompt,
  sealPrompt,
  type InvestigationMapMember,
  type LiveModelSeamOptions,
} from './harnessModelSeam';
import { CONTRADICTION_CHECK_MARKER } from './harnessSynthesisVerification';
import type { HostToolResult } from './harnessToolDispatcher';

function envelopeInput(overrides: Partial<BuildBootstrapEnvelopeInput> = {}): BuildBootstrapEnvelopeInput {
  return {
    members: [{ memberId: 'm1', repoId: 'repo-1', baseSha: 'base-1', headSha: 'head-1' }],
    personaLabel: 'Built-in reviewer',
    agentInstructions: 'You are a code review agent. Review ONLY the diffs below.',
    criteria: DEFAULT_CRITERIA,
    effort: 'medium',
    effortInstruction: 'Reason through the diff before reporting.',
    contextDeclaration: 'Auto-context: title, description. 1 attachment(s).',
    rootPolicies: [{ memberId: 'm1', source: { present: false } }],
    toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
    harnessPolicyVersion: '1',
    memberSections: [
      {
        memberId: 'm1',
        changeRequestDetails: buildBootstrapSection({
          kind: 'changeRequestDetails',
          sectionId: 'crd:m1',
          detail: {
            title: 'Rotate refresh tokens on use',
            body: 'Rotates refresh tokens whenever they are used.',
            labels: [],
            commits: [],
            discussion: [],
            checkSummaries: [],
            relationships: [],
            unavailableSections: [],
          },
          digest: 'digest-cr-1',
          providerState: 'complete',
          maxInlineChars: 10_000,
        }),
        issueDetails: [],
        attachments: [
          { id: 'att-1', label: 'design notes', path: 'notes/design.md', content: 'Never log the refresh token.', truncated: false, sourceId: 'ev_attachment1', digest: 'digest-att-1' },
          { id: 'att-2', label: 'unregistered', path: 'notes/other.md', content: 'This one failed registration.', truncated: false },
        ],
      },
    ],
    ...overrides,
  };
}

function envelope(overrides: Partial<BuildBootstrapEnvelopeInput> = {}): BootstrapEnvelope {
  return buildBootstrapEnvelope(envelopeInput(overrides));
}

function contentResult(overrides: Partial<Extract<HostToolResult, { state: 'complete' }>> = {}): HostToolResult {
  return {
    toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
    requestId: 'req-1',
    tool: 'readDiff',
    memberId: 'm1',
    state: 'complete',
    unitsReturned: 1,
    sourceId: 'ev_readdiff1',
    digest: 'digest-diff-1',
    content: { tool: 'readDiff', patch: '@@ -1 +1 @@\n-old\n+new' },
    ...overrides,
  };
}

describe('renderModelPrompt (task 15.7)', () => {
  it('includes the tool catalog, persona, and criteria from the envelope', () => {
    const prompt = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: [], submissions: [], phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(prompt).toContain('readDiff');
    expect(prompt).toContain('Exact changed evidence and inline anchors.');
    expect(prompt).toContain('Built-in reviewer');
    expect(prompt).toContain('You are a code review agent. Review ONLY the diffs below.');
    expect(prompt).toContain('Severity floor');
    expect(prompt).toContain(DEFAULT_CRITERIA.severityFloor);
  });

  /**
   * Every value on this line is labelled with the request field it fills, because a live run got
   * that mapping wrong: the line used to read "- m1: repository repo-1, ..." and 24 of that run's
   * 176 snapshots put the MEMBER id in the `repoId` field. The model had to map the word
   * "repository" onto a field called `repoId` while the member id sat in the most prominent
   * position on the line; the field names remove the guess.
   *
   * The same rule is why the two SHAs are no longer on the line. They filled exactly one request
   * field, the `snapshot` object, and no request carries one: the host pins every call to the
   * named member's own commits. Printing a 40-character identifier the model has no use for is
   * what produced the run that removed it — 87 of 319 tool results refused, every one a mis-copied
   * head sha.
   */
  it('labels every value on a member line with the request field it fills, and prints nothing the model cannot send', () => {
    const prompt = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: [], submissions: [], phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    const memberLine = prompt.split('\n').find((line) => line.startsWith('- memberId m1'));
    expect(memberLine).toBe('- memberId m1: repoId repo-1');
    // The word the model was previously asked to translate into a field name is gone.
    expect(prompt).not.toContain('repository repo-1');
    // No commit id anywhere in the prompt: nothing asks for one, so nothing offers one to copy.
    expect(prompt).not.toContain('base-1');
    expect(prompt).not.toContain('head-1');
    expect(prompt).not.toContain('baseSha');
    expect(prompt).not.toContain('headSha');
    // What the protocol section says instead of naming three fields to transcribe.
    expect(prompt).toContain("the host pins every request to that member's own base and");
  });

  it('marks a registered attachment CITABLE with its exact sourceId and digest, and an unregistered one not citable', () => {
    const prompt = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: [], submissions: [], phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(prompt).toContain('ev_attachment1');
    expect(prompt).toContain('digest-att-1');
    expect(prompt).toContain('CITABLE');
    // The exact sourceId/digest pair sits together with the attachment's own citable marker,
    // so a model reading this prompt could cite the attachment back with those exact values.
    const attachmentLine = prompt.split('\n').find((line) => line.includes('att-1') && line.includes('sourceId'));
    expect(attachmentLine).toBeDefined();
    expect(attachmentLine).toContain('ev_attachment1');
    expect(attachmentLine).toContain('digest-att-1');
    expect(prompt).toContain('NOT CITABLE');
  });

  it('renders each evidence-bearing tool result with its sourceId and digest', () => {
    const results: HostToolResult[] = [
      contentResult(),
      {
        toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
        requestId: 'req-2',
        tool: 'readDiff',
        memberId: 'm1',
        state: 'unavailable',
        reason: 'The provider could not return this file.',
      },
    ];
    const prompt = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: [], submissions: [], phase: 'investigating', repairInstruction: undefined, toolResults: results, envelope: envelope() });
    expect(prompt).toContain('ev_readdiff1');
    expect(prompt).toContain('digest-diff-1');
    expect(prompt).toContain('CITABLE');
    expect(prompt).toContain('@@ -1 +1 @@');
    expect(prompt).toContain('The provider could not return this file.');
  });

  /**
   * The protocol requires a cursor to come back as a *string*, and this line is the only place the
   * model ever learns what a cursor looks like. Rendering a numeric-looking one bare taught it the
   * opposite: in a live review of a paginated lock file it replied `"cursor": 200`, the turn failed
   * to parse, a whole round trip went to the repair path, and it resent `"cursor": "200"` — the
   * same page, two turns. Quoting removes the ambiguity at the source rather than loosening the
   * schema that catches it.
   */
  it('echoes a pagination cursor JSON-quoted, so the model sends back the string the protocol requires', () => {
    const paginated: HostToolResult = {
      ...(contentResult() as Extract<HostToolResult, { state: 'complete' }>),
      state: 'paginated',
      cursor: '200',
    } as HostToolResult;
    const prompt = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: [], submissions: [], phase: 'investigating', repairInstruction: undefined, toolResults: [paginated], envelope: envelope() });
    expect(prompt).toContain('cursor="200"');
    expect(prompt).not.toContain('cursor=200');
  });

  /**
   * A declined read renders as itself, and nowhere near the map's
   * never-readable list (`add-local-git-investigation` task 3.5). That list
   * tells the model a request would be wasted; this file's content exists and
   * a source that serves it will return it, so putting it there would teach
   * the model to stop asking for a file it should keep asking for.
   */
  it('renders a declined read as its own state and reason, without claiming the file cannot be read', () => {
    const declined: HostToolResult = {
      toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
      requestId: 'req-3',
      tool: 'readDiff',
      memberId: 'm1',
      state: 'contentDeclined',
      reason: 'The platform enumerated src/app/harnessAttempt.ts but did not serve its diff content.',
    };
    const prompt = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: [], submissions: [], phase: 'investigating', repairInstruction: undefined, toolResults: [declined], envelope: envelope() });
    expect(prompt).toContain('state=contentDeclined');
    expect(prompt).toContain('did not serve its diff content');
    expect(prompt).not.toContain('can never be read');
  });

  it('reports no prior tool results honestly on a phase\'s first turn', () => {
    const prompt = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: [], submissions: [], phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(prompt).toContain('this is the first turn of this phase');
  });

  it('names only the current phase\'s legal message kinds', () => {
    const planning = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: [], submissions: [], phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(planning).toContain('planCreated');
    expect(planning).not.toMatch(/legal message kinds.*candidateSubmission/);

    const investigating = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: [], submissions: [], phase: 'investigating', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(investigating).toContain('candidateSubmission');
    expect(investigating).not.toMatch(/legal message kinds.*planCreated/);
  });

  it('appends the repair instruction verbatim when one is present', () => {
    const prompt = renderModelPrompt({
      policy: DEFAULT_HARNESS_POLICY,
      investigation: [], submissions: [],
      phase: 'planning',
      repairInstruction: 'Your last reply was not valid JSON. Resend as {"messages": [...]}.',
      toolResults: [],
      envelope: envelope(),
    });
    expect(prompt).toContain('Protocol repair needed');
    expect(prompt).toContain('Your last reply was not valid JSON.');
  });

  it('marks untrusted bootstrap content as untrusted and non-citable, distinct from the citable attachment', () => {
    const prompt = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: [], submissions: [], phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain('Rotate refresh tokens on use');
  });
});

describe('createLiveModelSeam (task 15.7)', () => {
  it('renders the prompt and returns the raw reply text untouched', async () => {
    const runTurn = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('Built-in reviewer');
      return '{"messages":[{"kind":"publicRationale","rationale":"ok"}]}';
    });
    const seam = createLiveModelSeam({ policy: DEFAULT_HARNESS_POLICY, modelId: 'test-model', runTurn });
    const reply = await seam.askModel({ phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(reply).toBe('{"messages":[{"kind":"publicRationale","rationale":"ok"}]}');
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it('forwards askModel\'s own onTiming callback to runTurn untouched — this module measures nothing itself', async () => {
    const onTiming = vi.fn();
    const runTurn = vi.fn(async (_prompt: string, timing?: (t: { durationMs: number; promptBytes: number; replyBytes: number; outcome: 'completed' | 'failed' }) => void) => {
      timing?.({ durationMs: 5, promptBytes: 10, replyBytes: 20, outcome: 'completed' });
      return '{"messages":[{"kind":"publicRationale","rationale":"ok"}]}';
    });
    const seam = createLiveModelSeam({ policy: DEFAULT_HARNESS_POLICY, modelId: 'test-model', runTurn });
    await seam.askModel({ phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope(), onTiming });
    expect(onTiming).toHaveBeenCalledWith({ durationMs: 5, promptBytes: 10, replyBytes: 20, outcome: 'completed' });
  });

  it('fails closed rather than sending a promptless request when no envelope is attached', async () => {
    const runTurn = vi.fn(async () => 'unused');
    const seam = createLiveModelSeam({ policy: DEFAULT_HARNESS_POLICY, modelId: 'test-model', runTurn });
    await expect(seam.askModel({ phase: 'planning', repairInstruction: undefined, toolResults: [] })).rejects.toThrow(/no bootstrap envelope/);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it('propagates a missing/refusing model\'s rejection without any fallback', async () => {
    const failure = new Error('Model test-model is no longer available');
    const runTurn = vi.fn(async () => {
      throw failure;
    });
    const seam = createLiveModelSeam({ policy: DEFAULT_HARNESS_POLICY, modelId: 'test-model', runTurn });
    await expect(seam.askModel({ phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() })).rejects.toBe(failure);
  });

  it('sends a contradiction-check directive as-is, with no envelope required', async () => {
    const directive = `${CONTRADICTION_CHECK_MARKER}\ncandidateId: c1\nReply with exactly one JSON object...`;
    const runTurn = vi.fn(async (prompt: string) => {
      expect(prompt).toBe(directive);
      return '{"candidateId":"c1","contradicted":false}';
    });
    const seam = createLiveModelSeam({ policy: DEFAULT_HARNESS_POLICY, modelId: 'test-model', runTurn });
    const reply = await seam.askModel({ phase: 'verifying', repairInstruction: directive, toolResults: [] });
    expect(reply).toBe('{"candidateId":"c1","contradicted":false}');
    // `runTurn`'s second argument is `askModel`'s own `onTiming` — forwarded, not fabricated;
    // absent here since this call site never supplied one.
    expect(runTurn).toHaveBeenCalledWith(directive, undefined);
  });

  it('still fails closed on an envelope-less call whose repair instruction is not a contradiction check', async () => {
    const runTurn = vi.fn(async () => 'unused');
    const seam = createLiveModelSeam({ policy: DEFAULT_HARNESS_POLICY, modelId: 'test-model', runTurn });
    await expect(
      seam.askModel({ phase: 'planning', repairInstruction: 'Your last reply was not valid JSON.', toolResults: [] }),
    ).rejects.toThrow(/no bootstrap envelope/);
    expect(runTurn).not.toHaveBeenCalled();
  });
});

/**
 * The map exists because a run against a 26-file change asked for the changed-file manifest 24
 * times and read four files 20-22 times each, spent 234 of its 256 tool calls, and submitted
 * nothing. Every request was individually well-formed. The model simply could not see, on any
 * given turn, what it had already done — the prompt carried only the previous turn's results.
 */
describe('the investigation map — what the model has already gathered', () => {
  const MAP: readonly InvestigationMapMember[] = [
    {
      memberId: 'acme/core!42',
      manifestComplete: true,
      files: [
        { path: 'src/read.ts', inspected: true, addedLines: 12, removedLines: 3, sourceIds: ['ev_aaa', 'ev_bbb'] },
        { path: 'src/todo.ts', inspected: false, addedLines: 40, removedLines: 0, sourceIds: [] },
        { path: 'assets/logo.png', inspected: false, note: 'binary', sourceIds: [] },
      ],
    },
  ];

  it('names every changed file, whether it has been read, and what evidence is held for it', () => {
    const map = renderInvestigationMap(MAP, []);
    expect(map).toContain('read     src/read.ts +12/-3 ev_aaa ev_bbb');
    expect(map).toContain('not read src/todo.ts +40/-0');
    expect(map).toContain('not read assets/logo.png (binary)');
    expect(map).toContain('3 changed file(s), manifest complete, 1 read, 2 not read');
  });

  it('is an index and never the evidence itself — only the current prompt\'s results are citable', () => {
    const map = renderInvestigationMap(MAP, []);
    expect(map).toContain('Only the tool results printed in this prompt are citable');
    // A sourceId with no content beside it is the whole point: carrying every result forward
    // grows without bound, and a remembered line number is a fabricated citation.
    expect(map).not.toContain('digest');
  });

  it('tells the model to stop re-listing a manifest it already has', () => {
    expect(renderInvestigationMap(MAP, [])).toContain('Do not call listChangedFiles');
    expect(renderInvestigationMap(MAP, [])).toContain('manifest complete');
  });

  it('says the manifest is incomplete while pages are outstanding, because then re-listing is right', () => {
    const partial = [{ ...MAP[0]!, manifestComplete: false }];
    expect(renderInvestigationMap(partial, [])).toContain('manifest still being enumerated');
  });

  it('tells the model to submit in the same reply as the evidence, not to hoard until the end', () => {
    expect(renderInvestigationMap(MAP, [])).toContain('never save findings for later');
    expect(renderInvestigationMap(MAP, [])).toContain('submit them in this same reply');
  });

  it('renders nothing at all when there is nothing gathered yet, rather than an empty heading', () => {
    expect(renderInvestigationMap([], [])).toBe('');
    const prompt = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: [], submissions: [], phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(prompt).not.toContain('What you have already gathered');
  });

  it('reaches the prompt', () => {
    const prompt = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: MAP, submissions: [], phase: 'investigating', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(prompt).toContain('## What you have already gathered');
    expect(prompt).toContain('src/read.ts');
  });
});

/**
 * The submitted half of the map. A live run against a 26-file change reached full coverage and
 * then restarted reading from the top four separate times, submitting nothing — a stateless model
 * cannot tell a review whose findings are all recorded from one it has not started writing unless
 * the prompt says which it is. These tests pin the three states that message can be in: nothing
 * submitted yet, candidates on record, and the terminal "everything read, nothing submitted" state
 * that must carry an explicit way out (submit now, or stop asking for tools).
 */
describe('the investigation map — what the model has already submitted', () => {
  const MAP: readonly InvestigationMapMember[] = [
    {
      memberId: 'acme/core!42',
      manifestComplete: true,
      files: [
        { path: 'src/read.ts', inspected: true, addedLines: 12, removedLines: 3, sourceIds: ['ev_aaa'] },
        { path: 'src/todo.ts', inspected: false, addedLines: 40, removedLines: 0, sourceIds: [] },
      ],
    },
  ];
  const FULLY_READ: readonly InvestigationMapMember[] = [
    {
      memberId: 'acme/core!42',
      manifestComplete: true,
      files: [
        { path: 'src/read.ts', inspected: true, addedLines: 12, removedLines: 3, sourceIds: ['ev_aaa'] },
        { path: 'assets/logo.png', inspected: false, note: 'binary', sourceIds: [] },
      ],
    },
  ];

  it('states plainly that nothing has been submitted, because silence reads as "already recorded"', () => {
    const map = renderInvestigationMap(MAP, []);
    expect(map).toContain('Findings submitted so far: none');
    expect(map).toContain('not recorded anywhere');
  });

  it('lists each submitted candidate with its state, so nothing is resubmitted or forgotten', () => {
    const map = renderInvestigationMap(MAP, [
      { candidateId: 'cand-1', state: 'accepted', path: 'src/read.ts' },
      { candidateId: 'cand-2', state: 'unresolved' },
      { candidateId: 'cand-3', state: 'rejected' },
    ]);
    expect(map).toContain('accepted cand-1 — src/read.ts');
    expect(map).toContain('unresolved cand-2 (repair and resubmit)');
    expect(map).toContain('rejected cand-3 (do not resubmit)');
    expect(map).not.toContain('Findings submitted so far: none');
  });

  // A live review submitted nine candidates and had all nine rejected for one cause it was never
  // told. The reasons existed the whole time — the submitting turn's own tool result carries them —
  // but they left the prompt with that turn's results, so from the next turn the map said only
  // that the model was wrong.
  it('names why each rejected or unresolved candidate was refused, so the model can correct itself', () => {
    const map = renderInvestigationMap(MAP, [
      { candidateId: 'cand-1', state: 'accepted', path: 'src/read.ts' },
      { candidateId: 'cand-2', state: 'unresolved', reason: 'primary:rangeMissing: Citation names src/read.ts but not the line range inside it.' },
      { candidateId: 'cand-3', state: 'rejected', reason: 'codeNotInEvidence: The quoted code is not consecutive lines of one side of one hunk of the primary evidence.' },
    ]);
    expect(map).toContain('because: primary:rangeMissing: Citation names src/read.ts but not the line range inside it.');
    expect(map).toContain('because: codeNotInEvidence: The quoted code is not consecutive lines');
    // An accepted candidate has no reason, so a clean review's map is unchanged by this.
    expect(map).toContain('accepted cand-1 — src/read.ts\n');
    expect(map).not.toContain('accepted cand-1 — src/read.ts\n    because');
  });

  it('bounds a reason rather than letting a candidate that failed every check inflate every later prompt', () => {
    const map = renderInvestigationMap(MAP, [{ candidateId: 'cand-1', state: 'rejected', reason: 'x'.repeat(900) }]);
    expect(map).toContain('because: ');
    expect(map).toContain('…');
    expect(map).not.toContain('x'.repeat(400));
  });

  it('when every file is read (or terminally unreadable) and nothing was submitted, says so and names the two ways to finish', () => {
    const map = renderInvestigationMap(FULLY_READ, []);
    expect(map).toContain('Every changed file has been read and nothing has been submitted');
    expect(map).toContain('submit them NOW');
    expect(map).toContain('stop requesting tools');
  });

  it('does not raise that call to action while files remain unread, or once anything was submitted', () => {
    expect(renderInvestigationMap(MAP, [])).not.toContain('Every changed file has been read');
    expect(renderInvestigationMap(FULLY_READ, [{ candidateId: 'cand-1', state: 'accepted', path: 'src/read.ts' }])).not.toContain('Every changed file has been read');
  });
});

/**
 * The bounded form of the map, for a member too large to list in full. The uncapped listing was a
 * recorded known bound that bit on a live run: a 204-file change re-sent ~14KB of map lines in
 * every prompt, the fourth prompt reached 207KB, and the model was killed by the inactivity
 * watchdog having produced nothing. These tests mirror that run's shape (204 files) and the old
 * comment's own worst case (500) and pin the two properties the fix must hold together: the
 * rendered map stays near-constant in size however large the diff, and every count in it stays
 * exact — the elision lines account for precisely the files they hide.
 */
describe('the investigation map — bounded rendering for a very large change', () => {
  /** `read` files come first, then plain unread, then `binary` terminal files, all deterministic. */
  function bigMember(total: number, read: number, binary: number): InvestigationMapMember {
    const files = Array.from({ length: total }, (_, i) => {
      if (i < read) {
        return {
          path: `src/dir${i}/file${i}.ts`,
          inspected: true,
          addedLines: 10,
          removedLines: 2,
          sourceIds: [`ev_${String(i).padStart(32, 'a')}`],
          lastFetchOrder: i + 1,
        };
      }
      if (i >= total - binary) {
        return { path: `assets/blob${i}.png`, inspected: false, note: 'binary', sourceIds: [] };
      }
      return { path: `src/dir${i}/file${i}.ts`, inspected: false, addedLines: 30, removedLines: 5, sourceIds: [] };
    });
    return { memberId: 'acme/core!66', manifestComplete: true, files };
  }

  it('stays bounded at the live failure\'s size (204 files) instead of growing with the diff', () => {
    const map = renderInvestigationMap([bigMember(204, 60, 4)], []);
    // The uncapped listing renders ~12KB here (204 lines); the bound is what stops the map being
    // re-paid on every turn of a large review. Loose enough to survive wording drift, tight
    // enough that per-file growth fails it immediately.
    expect(Buffer.byteLength(map, 'utf8')).toBeLessThan(6_000);
  });

  it('stays bounded at the old comment\'s worst case, 500 files, none read yet', () => {
    const map = renderInvestigationMap([bigMember(500, 0, 0)], []);
    expect(Buffer.byteLength(map, 'utf8')).toBeLessThan(6_000);
    expect(map).toContain('500 changed file(s), manifest complete, 0 read, 500 not read');
    expect(map).toContain('… 468 more not read');
  });

  it('keeps every count exact, and the shown and elided groups sum back to the whole change', () => {
    const map = renderInvestigationMap([bigMember(204, 60, 4)], []);
    // The head line's arithmetic is untouched: 60 read, 204 - 60 = 144 not read (terminal files
    // count as not read there, as they always have).
    expect(map).toContain('204 changed file(s), manifest complete, 60 read, 144 not read');
    // 140 readable-unread files: 32 named, the exact remainder counted.
    expect(map).toContain('… 108 more not read');
    // The 4 terminal files collapse to an exact per-reason count.
    expect(map).toContain('4 file(s) can never be read (4 binary)');
    // 60 read files: 12 named, the exact remainder counted.
    expect(map).toContain('… 48 more read earlier');
    // And the groups reconcile: named unread + elided unread + terminal + named read + elided
    // read = every changed file. This is the assertion that catches an off-by-terminal miscount.
    const lines = map.split('\n');
    const namedUnread = lines.filter((line) => line.startsWith('  not read')).length;
    const namedRead = lines.filter((line) => line.startsWith('  read    ')).length;
    expect(namedUnread).toBe(32);
    expect(namedRead).toBe(12);
    expect(namedUnread + 108 + 4 + namedRead + 48).toBe(204);
  });

  it('names the next unread files in manifest order, so the elided tail pages in as they are read', () => {
    const map = renderInvestigationMap([bigMember(204, 60, 4)], []);
    // Unread files are indices 60..199; the first 32 of them (60..91) are named, 92 onward wait.
    expect(map).toContain('not read src/dir60/file60.ts');
    expect(map).toContain('not read src/dir91/file91.ts');
    expect(map).not.toContain('file92.ts');
  });

  it('keeps the evidence ids of the newest reads — the ones a submission this turn could cite', () => {
    const map = renderInvestigationMap([bigMember(204, 60, 4)], []);
    // Read files carry lastFetchOrder 1..60: the 12 newest (49..60, files 48..59) keep their
    // lines and sourceIds, the oldest do not.
    expect(map).toContain(`read     src/dir59/file59.ts +10/-2 ev_${'59'.padStart(32, 'a')}`);
    expect(map).toContain('src/dir48/file48.ts');
    expect(map).not.toContain('src/dir47/file47.ts');
    expect(map).not.toContain(`ev_${'0'.padStart(32, 'a')}`);
  });

  it('renders a member at the threshold in full, and only one file more switches to the bounded form', () => {
    const atThreshold = renderInvestigationMap([bigMember(40, 10, 0)], []);
    for (let i = 0; i < 40; i += 1) expect(atThreshold).toContain(`file${i}.ts`);
    expect(atThreshold).not.toContain('large change');

    const overThreshold = renderInvestigationMap([bigMember(41, 10, 0)], []);
    expect(overThreshold).toContain('large change');
    expect(overThreshold).toContain('41 changed file(s), manifest complete, 10 read, 31 not read');
  });
});

/**
 * The second live failure the bounded form had to answer, measured over one 207-file review, 39
 * turns and 237 tool calls: only 107 results carried content. 74 calls asked for binary files (the
 * change has 6), 15 asked for the one oversized file, and 57 asked for 13 paths that are not in the
 * change at all — 146 wasted calls, 59% of everything the review spent, and 49 of 207 files read in
 * nine minutes with nothing submitted. Each block below pins one of the three causes: the map
 * counted the unreadable files without naming them, a "no such path" answer was recorded nowhere,
 * and the head of the to-do list was alphabetical.
 */
describe('the investigation map — the unreadable files are named, not only counted', () => {
  /** `unreadable` terminal files first, then plain unread, so the shown/elided split is easy to read. */
  function memberWith(unreadable: number, unread: number): InvestigationMapMember {
    const files = [
      ...Array.from({ length: unreadable }, (_, i) => ({
        path: `assets/blob${i}.png`,
        inspected: false,
        note: i === 0 ? 'oversized' : 'binary',
        sourceIds: [],
      })),
      ...Array.from({ length: unread }, (_, i) => ({
        path: `src/dir${i}/file${i}.ts`,
        inspected: false,
        addedLines: 30,
        removedLines: 5,
        sourceIds: [],
      })),
    ];
    return { memberId: 'acme/core!207', manifestComplete: true, files };
  }

  it('names every never-readable file and its reason, so the model can stop drawing them out of the hat', () => {
    const map = renderInvestigationMap([memberWith(7, 200)], []);
    expect(map).toContain('7 file(s) can never be read (1 oversized, 6 binary)');
    expect(map).toContain('    assets/blob0.png (oversized)');
    expect(map).toContain('    assets/blob6.png (binary)');
    // The point of naming them at all: the model is told not to ask, in the same breath.
    expect(map).toContain('never ask for them');
  });

  it('bounds the naming and states the exact number it hides, for a change that is mostly assets', () => {
    const map = renderInvestigationMap([memberWith(60, 100)], []);
    expect(map).toContain('60 file(s) can never be read (1 oversized, 59 binary)');
    expect(map).toContain('    assets/blob15.png (binary)');
    expect(map).not.toContain('assets/blob16.png');
    expect(map).toContain('… 44 more that can never be read, not named.');
  });

  it('keeps the arithmetic reconciling with the head line now that the unreadable files have lines of their own', () => {
    const map = renderInvestigationMap([memberWith(7, 200)], []);
    expect(map).toContain('207 changed file(s), manifest complete, 0 read, 207 not read');
    const lines = map.split('\n');
    // The named-unreadable lines are indented four spaces deliberately: the reconcile count below
    // keys on the `  not read` / `  read    ` prefixes, and a collision there would silently
    // double-count the very files this block exists to name.
    const namedUnread = lines.filter((line) => line.startsWith('  not read')).length;
    const namedRead = lines.filter((line) => line.startsWith('  read    ')).length;
    const namedUnreadable = lines.filter((line) => line.startsWith('    assets/')).length;
    expect(namedUnread).toBe(32);
    expect(namedRead).toBe(0);
    expect(namedUnreadable).toBe(7);
    expect(map).toContain('… 168 more not read');
    expect(namedUnread + 168 + 7 + namedRead).toBe(207);
  });
});

describe('the investigation map — paths the model invented are remembered and refused once', () => {
  function memberWith(files: number, offManifestPaths: readonly string[], offManifestRequests: number): InvestigationMapMember {
    return {
      memberId: 'acme/core!207',
      manifestComplete: true,
      files: Array.from({ length: files }, (_, i) => ({ path: `src/dir${i}/file${i}.ts`, inspected: false, addedLines: 3, removedLines: 1, sourceIds: [] })),
      ...(offManifestPaths.length > 0 ? { offManifestPaths, offManifestRequests } : {}),
    };
  }

  it('names the paths that are not in the change, in both the full and the bounded form', () => {
    const invented = ['src/app/harnessDispatcher.ts', 'src/app/harnessTools.ts'];
    for (const size of [3, 207]) {
      const map = renderInvestigationMap([memberWith(size, invented, 11)], []);
      expect(map).toContain('These paths are not in this change');
      expect(map).toContain('never request them again');
      expect(map).toContain('    src/app/harnessDispatcher.ts');
      expect(map).toContain('    src/app/harnessTools.ts');
    }
  });

  it('bounds the list and states the exact request total rather than a count of paths it does not keep', () => {
    const invented = Array.from({ length: 12 }, (_, i) => `src/app/invented${i}.ts`);
    const map = renderInvestigationMap([memberWith(207, [...invented, 'src/app/overflow.ts'], 57)], []);
    expect(map).toContain('    src/app/invented11.ts');
    expect(map).not.toContain('src/app/overflow.ts');
    expect(map).toContain('(57 request(s) for paths outside this change so far; only the 12 most recent paths are named.)');
  });

  it('does not invent a withheld remainder when the list is short — a repeated guess is stated as a repeat', () => {
    const map = renderInvestigationMap([memberWith(207, ['src/app/harnessDispatcher.ts', 'src/app/harnessTools.ts'], 9)], []);
    expect(map).toContain('(9 request(s) for paths outside this change so far; every one of them is named above.)');
    expect(map).not.toContain('most recent paths are named');
  });

  it('says nothing about totals at all when every refused request is one distinct path', () => {
    const map = renderInvestigationMap([memberWith(207, ['src/app/harnessDispatcher.ts'], 1)], []);
    expect(map).toContain('    src/app/harnessDispatcher.ts');
    expect(map).not.toContain('request(s) for paths outside this change');
  });

  it('says nothing at all — not one byte — for a member that never guessed a path', () => {
    const withList = renderInvestigationMap([memberWith(3, ['src/app/invented0.ts'], 1)], []);
    const without = renderInvestigationMap([memberWith(3, [], 0)], []);
    expect(without).not.toContain('not in this change');
    expect(withList.length).toBeGreaterThan(without.length);
    // A member with no invented paths renders exactly as it did before this list existed.
    expect(without.split('\n').every((line) => !line.startsWith('    '))).toBe(true);
  });

  it('does not count the invented paths as changed files — the head-line arithmetic is about the change, not the guessing', () => {
    const map = renderInvestigationMap([memberWith(3, ['src/app/invented0.ts', 'src/app/invented1.ts'], 9)], []);
    expect(map).toContain('These paths are not in this change');
    expect(map).toContain('3 changed file(s), manifest complete, 0 read, 3 not read');
  });
});

/**
 * Cause 3 of that review, and the one that explains the other two. The unread head was manifest
 * order, which is alphabetical: the 32 files it named were `.gitignore`, `README.md`, docs pages, a
 * lockfile and fifteen `*.test.ts` files, while all 143 source files sat behind "… 143 more not
 * read". The model was pointed at the files with nothing to review in them and shown none of the
 * source it was there to review — which is also the likeliest reason it started inventing source
 * paths.
 */
describe('the investigation map — the next files to read are the riskiest, not the alphabetically earliest', () => {
  /** Deliberately alphabetical-first for the low-risk noise, exactly as the live manifest was. */
  function member(): InvestigationMapMember {
    const files = [
      { path: '.gitignore', inspected: false, risk: 'low' as const, sourceIds: [] },
      { path: 'README.md', inspected: false, risk: 'low' as const, sourceIds: [] },
      ...Array.from({ length: 30 }, (_, i) => ({ path: `docs/page${i}.md`, inspected: false, risk: 'low' as const, sourceIds: [] })),
      ...Array.from({ length: 30 }, (_, i) => ({ path: `src/mid${i}.ts`, inspected: false, risk: 'medium' as const, sourceIds: [] })),
      { path: 'src/unclassified-a.ts', inspected: false, sourceIds: [] },
      { path: 'src/unclassified-b.ts', inspected: false, sourceIds: [] },
      ...Array.from({ length: 12 }, (_, i) => ({ path: `src/risky${i}.ts`, inspected: false, risk: 'high' as const, sourceIds: [] })),
    ];
    return { memberId: 'acme/core!207', manifestComplete: true, files };
  }

  it('names every high-risk file before any lower-risk one, and elides the alphabetical noise instead', () => {
    const map = renderInvestigationMap([member()], []);
    const named = map.split('\n').filter((line) => line.startsWith('  not read')).map((line) => line.slice('  not read '.length).split(' ')[0]);
    expect(named).toHaveLength(32);
    expect(named.slice(0, 12)).toEqual(Array.from({ length: 12 }, (_, i) => `src/risky${i}.ts`));
    expect(named).not.toContain('.gitignore');
    expect(named).not.toContain('README.md');
    expect(named).not.toContain('docs/page0.md');
  });

  it('sorts an unclassified file above medium and below high — host ignorance never buries a file, and never displaces a judged one', () => {
    const map = renderInvestigationMap([member()], []);
    const named = map.split('\n').filter((line) => line.startsWith('  not read')).map((line) => line.slice('  not read '.length).split(' ')[0]);
    expect(named.slice(12, 14)).toEqual(['src/unclassified-a.ts', 'src/unclassified-b.ts']);
    expect(named.slice(14)).toEqual(Array.from({ length: 18 }, (_, i) => `src/mid${i}.ts`));
  });

  it('keeps manifest order within a risk level, so the window still slides forward as files are read', () => {
    const first = member();
    const map = renderInvestigationMap([first], []);
    const named = map.split('\n').filter((line) => line.startsWith('  not read')).map((line) => line.slice('  not read '.length).split(' ')[0]);
    // risky0..risky11 in the order the manifest gave them, not reversed or shuffled by the sort:
    // the head is sorted on risk rank alone, and `Array.prototype.sort` is stable.
    expect(named.slice(0, 12)).toEqual(Array.from({ length: 12 }, (_, i) => `src/risky${i}.ts`));

    // And once the high-risk files are read, the next tier pages in with no cursor state carried:
    // the unclassified pair and then the medium files, still in manifest order among themselves.
    const readHigh = { ...first, files: first.files.map((file) => (file.risk === 'high' ? { ...file, inspected: true, lastFetchOrder: 1 } : file)) };
    const afterHigh = renderInvestigationMap([readHigh], []);
    expect(afterHigh).not.toContain('not read src/risky0.ts');
    expect(afterHigh).toContain('not read src/unclassified-a.ts');
    expect(afterHigh).toContain('not read src/mid0.ts');

    // Only when the medium tier is spent do the docs and dotfiles at the top of the alphabet — the
    // files the old manifest-ordered head recommended first — finally surface.
    const readMost = { ...first, files: first.files.map((file) => (file.risk === 'low' ? file : { ...file, inspected: true, lastFetchOrder: 1 })) };
    expect(renderInvestigationMap([readMost], [])).toContain('not read docs/page0.md');
  });

  it('prints the risk it sorted on, because an ordered list is indistinguishable from an arbitrary one', () => {
    const map = renderInvestigationMap([member()], []);
    expect(map).toContain('not read src/risky0.ts [high]');
    expect(map).toContain('not read src/mid0.ts [medium]');
    // No marker for a file the host has not judged; the preamble says what unmarked means.
    expect(map).toContain('not read src/unclassified-a.ts\n');
    expect(map).toContain('unmarked means not yet assessed');
  });

  it('leaves the full listing alone: a member at or below the threshold renders byte-identically, risk or no risk', () => {
    const files = Array.from({ length: 40 }, (_, i) => ({ path: `src/file${i}.ts`, inspected: false, addedLines: 3, removedLines: 1, sourceIds: [] }));
    const plain: InvestigationMapMember = { memberId: 'acme/core!1', manifestComplete: true, files };
    const classified: InvestigationMapMember = { memberId: 'acme/core!1', manifestComplete: true, files: files.map((file, i) => ({ ...file, risk: (['high', 'medium', 'low'] as const)[i % 3] })) };
    expect(renderInvestigationMap([classified], [])).toBe(renderInvestigationMap([plain], []));
    expect(renderInvestigationMap([plain], [])).not.toContain('[high]');
  });

  it('renders a member whose files carry no risk at all exactly as it did before risk existed', () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ path: `src/file${i}.ts`, inspected: false, addedLines: 3, removedLines: 1, sourceIds: [] }));
    const map = renderInvestigationMap([{ memberId: 'acme/core!1', manifestComplete: true, files }], []);
    const named = map.split('\n').filter((line) => line.startsWith('  not read')).map((line) => line.slice('  not read '.length).split(' ')[0]);
    expect(named).toEqual(Array.from({ length: 32 }, (_, i) => `src/file${i}.ts`));
    // No file line carries a marker — the only brackets in the block are the preamble's legend.
    expect(map).not.toMatch(/^ {2}not read .*\[/m);
  });

  it('stays bounded with all three fixes present at the live review\'s size', () => {
    const files = [
      ...Array.from({ length: 49 }, (_, i) => ({ path: `src/read${i}.ts`, inspected: true, addedLines: 20, removedLines: 3, risk: 'high' as const, sourceIds: [`ev_${String(i).padStart(32, 'a')}`], lastFetchOrder: i + 1 })),
      ...Array.from({ length: 6 }, (_, i) => ({ path: `assets/img${i}.png`, inspected: false, note: 'binary', sourceIds: [] })),
      { path: 'package-lock.json', inspected: false, note: 'oversized', sourceIds: [] },
      ...Array.from({ length: 151 }, (_, i) => ({ path: `src/todo${i}.ts`, inspected: false, addedLines: 30, removedLines: 8, risk: (['high', 'medium', 'low'] as const)[i % 3], sourceIds: [] })),
    ];
    const map = renderInvestigationMap([{
      memberId: 'acme/core!207',
      manifestComplete: true,
      files,
      offManifestPaths: Array.from({ length: 12 }, (_, i) => `src/app/invented${i}.ts`),
      offManifestRequests: 57,
    }], []);
    // Measured 3,241 bytes before these three fixes and 4,383 after, on this exact shape: +1,142
    // bytes per turn against 146 wasted tool calls, roughly 18 turns at the 8-call per-turn cap.
    // The bound is what matters — still constant in the diff size, still an index and not content.
    expect(Buffer.byteLength(map, 'utf8')).toBeLessThan(5_000);
  });
});

/**
 * The criteria block used to print enum names only — "Severity floor: minor. Minimum confidence:
 * 70." — with no severity defined anywhere in the model-facing text. Measured across this
 * product's own pull requests, that bought: 12 findings, every one submitted as `major`, none
 * correctly severitied, including a body that reasoned to "the logic is sound" and shipped as
 * `major` anyway. These tests hold the fix in place, in this suite's own round-trip style: every
 * severity the definitions print must be one the real parser accepts, and every severity the
 * parser accepts must be defined — a typo or an added-but-undefined severity fails here rather
 * than reaching a live prompt as a silently undefined word.
 */
describe('review criteria carry meanings, not only enum names', () => {
  const prompt = () => renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: [], submissions: [], phase: 'investigating', repairInstruction: undefined, toolResults: [], envelope: envelope() });

  function candidateTurn(severity: string): string {
    return JSON.stringify({
      messages: [{
        kind: 'candidateSubmission',
        candidate: {
          candidateId: 'cand-sev',
          memberId: 'm1',
          file: 'src/a.ts',
          line: 1,
          severity,
          category: 'craftsmanship',
          confidence: 80,
          title: 'A finding',
          body: 'A body.',
          citations: { primary: { sourceId: 'ev_1', digest: 'd1', path: 'src/a.ts', range: { startLine: 1, endLine: 1 } } },
        },
      }],
    });
  }

  it('defines every severity the parser accepts, and prints no severity the parser rejects', () => {
    const line = prompt().split('\n').find((candidate) => candidate.startsWith('Severity: '));
    expect(line, 'the criteria block no longer defines severities').toBeDefined();
    const printed = [...line!.matchAll(/(?:: |; )(\w+) = /g)].map((match) => match[1]!);
    expect([...printed].sort(), 'the printed severities are not exactly the ones the product knows').toEqual([...SEVERITY_ORDER].sort());
    for (const severity of printed) {
      expect(parseModelTurn(candidateTurn(severity), { phase: 'investigating' }).ok, `the prompt defines severity "${severity}" but the parser rejects it`).toBe(true);
    }
  });

  it('ties confidence to the defect being real, and forbids submitting a finding whose own body refutes it', () => {
    const text = prompt();
    expect(text).toContain('Confidence is the probability the defect is real');
    expect(text).toContain('concludes the code is correct describes no defect — do not submit it');
  });
});

/**
 * The intent instruction is the one piece of the prompt that is phase-conditional: it shapes plan
 * items, so it renders on the planning turn and nowhere else — every other turn would pay its
 * bytes for nothing (`harnessSmallReviewCost.assurance.test.ts` is the budget). Both halves are
 * asserted: planning gets it, and the phases that do not need it never see it.
 */
describe('the planning turn asks for the author\'s declared intent', () => {
  const at = (phase: RunPhase) => renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: [], submissions: [], phase, repairInstruction: undefined, toolResults: [], envelope: envelope() });

  it('tells the planning turn to plan around intent and success criteria, verified against the diff', () => {
    const planning = at('planning');
    expect(planning).toContain('## Planning');
    expect(planning).toContain("author's declared intent and success criteria");
    expect(planning).toContain('verifying the diff against them');
    // The description is where intent lives, and it stays untrusted and non-citable — the
    // instruction restates the boundary rather than quietly loosening it.
    expect(planning).toContain('cite code, never the description');
  });

  it('costs its bytes on the planning turn only', () => {
    for (const phase of ['investigating', 'verifying'] as const) {
      expect(at(phase), `the intent instruction leaked into "${phase}"`).not.toContain("author's declared intent");
    }
  });
});

// ---- The per-turn prompt budget ------------------------------------------------------

/**
 * The ceiling and the content allowance, at the one place the assembled prompt exists.
 *
 * These exercise the renderer directly; the end-to-end half — a review that over-asks, gets told
 * what was deferred, and eventually reads everything — is `harnessPromptBudget.assurance.test.ts`.
 */
function budgetPolicy(maxPromptBytesPerTurn: number) {
  return { ...DEFAULT_HARNESS_POLICY, maxPromptBytesPerTurn };
}

type MapFile = InvestigationMapMember['files'][number];

function mapFile(path: string, patchBytes: number, overrides: Partial<MapFile> = {}): MapFile {
  return { path, inspected: false, addedLines: 40, removedLines: 2, patchBytes, sourceIds: [], ...overrides };
}

function mapMember(files: readonly MapFile[]): InvestigationMapMember {
  return { memberId: 'm1', manifestComplete: true, files };
}

/** A patch of exactly `bytes` UTF-8 bytes, so a test can say "this result costs 40 KB" and mean it. */
function sizedResult(requestId: string, path: string, bytes: number): HostToolResult {
  return contentResult({ requestId, sourceId: `ev_${requestId}`, digest: `digest-${requestId}`, content: { tool: 'readDiff', patch: 'x'.repeat(bytes) } });
}

describe('the per-turn prompt budget — the two numbers, stated to the model', () => {
  it('says nothing at all when the whole unread change already fits one turn, so a small review is byte-identical', () => {
    // The condition that gates the announcement and the size column alike. A review that can never
    // be refused anything is told nothing, costs nothing, and renders exactly as it did before the
    // budget existed — which is what `harnessSmallReviewCost.assurance.test.ts`'s byte ceilings
    // are protecting.
    const small = mapMember([mapFile('src/a.ts', 2_000), mapFile('src/b.ts', 3_000)]);
    const withSizes = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation: [small], submissions: [], phase: 'investigating', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    const withoutSizes = renderModelPrompt({
      policy: DEFAULT_HARNESS_POLICY,
      investigation: [mapMember(small.files.map((file) => ({ ...file, patchBytes: undefined })))],
      submissions: [],
      phase: 'investigating',
      repairInstruction: undefined,
      toolResults: [],
      envelope: envelope(),
    });
    expect(withSizes).toBe(withoutSizes);
    expect(withSizes).not.toContain("This turn's size budget");
    expect(withSizes).not.toContain('KB');
  });

  it('states the cap, the framing cost and the allowance as three separate figures once the budget can bind', () => {
    const large = mapMember(Array.from({ length: 20 }, (_, index) => mapFile(`src/file${index}.ts`, 20_000)));
    const prompt = renderModelPrompt({ policy: budgetPolicy(120_000), investigation: [large], submissions: [], phase: 'investigating', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(prompt).toContain("## This turn's size budget");
    expect(prompt).toContain('120,000');
    expect(prompt).toContain('content allowance');
    // And the allowance it announces is the real remaining room, not the cap: the framing is
    // subtracted, so the two figures differ by exactly what this prompt already costs.
    const announced = /may total at most ([\d,]+) bytes/.exec(prompt);
    expect(announced).not.toBeNull();
    const allowance = Number(announced![1]!.replace(/,/g, ''));
    expect(allowance).toBeGreaterThan(0);
    expect(allowance).toBeLessThan(120_000 - 1_000);
    expect(120_000 - allowance).toBe(Buffer.byteLength(prompt, 'utf8'));
  });

  it('prints each unread file\'s diff size beside its churn, so a legal set of eight is pickable without asking', () => {
    const large = mapMember(Array.from({ length: 60 }, (_, index) => mapFile(`src/file${index}.ts`, 47_104)));
    const prompt = renderModelPrompt({ policy: budgetPolicy(120_000), investigation: [large], submissions: [], phase: 'investigating', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(prompt).toMatch(/not read src\/file\d+\.ts \+40\/-2 46KB/);
  });
});

describe('the per-turn prompt budget — the ceiling holds, whatever it is handed', () => {
  it('never assembles a prompt over the ceiling, and drops whole results rather than content inside one', () => {
    const results = [sizedResult('r1', 'src/a.ts', 30_000), sizedResult('r2', 'src/b.ts', 30_000), sizedResult('r3', 'src/c.ts', 30_000)];
    const overruns: Array<{ droppedResults: number }> = [];
    const prompt = renderModelPrompt({
      policy: budgetPolicy(60_000),
      investigation: [],
      submissions: [],
      phase: 'investigating',
      repairInstruction: undefined,
      toolResults: results,
      envelope: envelope(),
      onOverrun: (overrun) => overruns.push(overrun),
    });
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(60_000);
    expect(overruns).toHaveLength(1);
    expect(overruns[0]!.droppedResults).toBeGreaterThan(0);
    // The model is told, in the prompt, that results are missing and that the requests survive.
    expect(prompt).toContain('are not shown');
    expect(prompt).toContain('remain available');
    // Whole results only: a result that IS shown is shown complete, never cut mid-patch.
    expect(prompt).toContain('x'.repeat(30_000));
  });

  it('holds in every phase, with a protocol repair appended, and on a repair turn that pushes an already-fitting prompt over', () => {
    const phases: RunPhase[] = ['planning', 'investigating', 'verifying'];
    for (const phase of phases) {
      const prompt = renderModelPrompt({
        policy: budgetPolicy(60_000),
        investigation: [mapMember([mapFile('src/a.ts', 90_000)])],
        submissions: [],
        phase,
        repairInstruction: 'The previous reply was not valid JSON.',
        toolResults: [sizedResult('r1', 'src/a.ts', 50_000)],
        envelope: envelope(),
      });
      expect(Buffer.byteLength(prompt, 'utf8'), phase).toBeLessThanOrEqual(60_000);
      expect(prompt, phase).toContain('Protocol repair needed');
    }
  });

  it('reports — rather than silently accepting — a framing that alone exceeds the ceiling, because there is nothing left to drop', () => {
    const overruns: Array<{ framingOverrunBytes: number; droppedResults: number }> = [];
    const prompt = renderModelPrompt({
      policy: budgetPolicy(500),
      investigation: [],
      submissions: [],
      phase: 'planning',
      repairInstruction: undefined,
      toolResults: [],
      envelope: envelope(),
      onOverrun: (overrun) => overruns.push(overrun),
    });
    // The persona, the tool catalog and the protocol contract are not optional, so the prompt is
    // still produced — and the condition is reported instead of being absorbed.
    expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(500);
    expect(overruns).toHaveLength(1);
    expect(overruns[0]!.droppedResults).toBe(0);
    expect(overruns[0]!.framingOverrunBytes).toBeGreaterThan(0);
  });

  it('the measured shape fits the shipped default: eight files averaging 15 KB, on top of a real 55 KB framing', () => {
    // The two numbers the default was sized against, checked together. The framing is built up to
    // the measured floor — 55 KB of prompt carrying zero bytes of tool results, which is what the
    // real 40-call review's smallest turn actually cost — rather than a toy envelope, because 8 x
    // 15 KB fitting inside a 5 KB framing would prove nothing at all about the 192 KB default.
    const big = envelope({
      memberSections: [
        {
          memberId: 'm1',
          changeRequestDetails: buildBootstrapSection({
            kind: 'changeRequestDetails',
            sectionId: 'crd:m1',
            detail: { title: 'A very large change request', body: 'D'.repeat(45_000), labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] },
            digest: 'digest-cr-1',
            providerState: 'complete',
            maxInlineChars: 200_000,
          }),
          issueDetails: [],
          attachments: [],
        },
      ],
    });
    const investigation = [mapMember(Array.from({ length: 60 }, (_, index) => mapFile(`src/file${index}.ts`, 15_360)))];
    const framing = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation, submissions: [], phase: 'investigating', repairInstruction: undefined, toolResults: [], envelope: big });
    expect(Buffer.byteLength(framing, 'utf8'), 'the framing must actually reach the measured floor, or this test checks the wrong thing').toBeGreaterThan(55_000);

    const overruns: unknown[] = [];
    const results = Array.from({ length: 8 }, (_, index) => sizedResult(`r${index}`, `src/file${index}.ts`, 15_360));
    const prompt = renderModelPrompt({ policy: DEFAULT_HARNESS_POLICY, investigation, submissions: [], phase: 'investigating', repairInstruction: undefined, toolResults: results, envelope: big, onOverrun: (overrun) => overruns.push(overrun) });
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(DEFAULT_HARNESS_POLICY.maxPromptBytesPerTurn);
    expect(overruns, 'the measured shape must fit without the renderer having to drop anything').toEqual([]);
  });
});

describe('the per-turn prompt budget — the seam measures its own prompt', () => {
  it('answers the assembled size for a given set of results, and undefined when there is no envelope to render', () => {
    const seam = createLiveModelSeam({ modelId: 'lm:test/test', policy: DEFAULT_HARNESS_POLICY, runTurn: async () => '{"messages":[]}' });
    const withOne = seam.measurePromptBytes!({ phase: 'investigating', toolResults: [sizedResult('r1', 'src/a.ts', 10_000)], envelope: envelope(), investigation: [], submissions: [] });
    const withNone = seam.measurePromptBytes!({ phase: 'investigating', toolResults: [], envelope: envelope(), investigation: [], submissions: [] });
    expect(withOne!).toBeGreaterThan(withNone! + 9_900);
    expect(seam.measurePromptBytes!({ phase: 'investigating', toolResults: [], investigation: [], submissions: [] })).toBeUndefined();
  });

  it('answers what the results really cost, not what survived the emergency drop', async () => {
    // The live failure this closes. `measurePromptBytes` used to render the prompt — drop loop and
    // all — and return the size of what came out, which is at or under the cap by construction.
    // `harnessAttempt.ts` computes `remainingBytes = ceiling - that`, so the moment a turn
    // overshot, the measurement quietly removed a result, reported a figure under the cap, and the
    // turn carried on admitting more. Driven end to end that assembled 157,157 bytes against a
    // 120,000-byte cap and dropped a paid-for search.
    const seam = createLiveModelSeam({ modelId: 'lm:test/test', policy: budgetPolicy(60_000), runTurn: async () => '{"messages":[]}' });
    const results = [sizedResult('r1', 'src/a.ts', 30_000), sizedResult('r2', 'src/b.ts', 30_000), sizedResult('r3', 'src/c.ts', 30_000)];
    const measured = seam.measurePromptBytes!({ phase: 'investigating', toolResults: results, envelope: envelope(), investigation: [], submissions: [] });
    expect(measured, 'three 30 KB results against a 60 KB cap cost far more than the cap').toBeGreaterThan(90_000);
    // And the prompt that would actually be sent is still held to the cap. The two numbers differ
    // on purpose, and each caller reads the one it needs.
    expect(Buffer.byteLength(renderModelPrompt({ policy: budgetPolicy(60_000), investigation: [], submissions: [], phase: 'investigating', repairInstruction: undefined, toolResults: results, envelope: envelope() }), 'utf8')).toBeLessThanOrEqual(60_000);
  });

  it('refuses to send a prompt whose framing alone is over the cap, after reporting it', async () => {
    // The one condition nothing can compose around: none of what is over is optional. It used to
    // be reported and sent; a cap that is sometimes honoured is not a cap. `harnessAttempt.ts`
    // turns the report into the `promptBudgetNoRoom` limitation before this throw reaches it.
    const overruns: Array<{ framingOverrunBytes: number }> = [];
    let sent = 0;
    const seam = createLiveModelSeam({
      modelId: 'lm:test/test',
      policy: budgetPolicy(500),
      runTurn: async () => {
        sent += 1;
        return '{"messages":[]}';
      },
    });
    const ask = seam.askModel({
      phase: 'planning',
      repairInstruction: undefined,
      toolResults: [],
      envelope: envelope(),
      investigation: [],
      submissions: [],
      onPromptOverrun: (overrun) => overruns.push(overrun),
    });
    await expect(ask).rejects.toBeInstanceOf(PromptCeilingExceededError);
    expect(sent).toBe(0);
    expect(overruns[0]?.framingOverrunBytes).toBeGreaterThan(0);
  });

  it('refuses to send an over-cap contradiction directive, rather than reporting it and sending it anyway', async () => {
    // The adversarial finding this replaces: the contradiction pass assembles its own prompt text
    // and never comes through `renderModelPrompt`, so the ceiling was measured here, reported, and
    // then breached. A setting that is sometimes honoured is not a setting.
    const overruns: unknown[] = [];
    let sent = 0;
    const seam = createLiveModelSeam({
      modelId: 'lm:test/test',
      policy: budgetPolicy(500),
      runTurn: async () => {
        sent += 1;
        return '{"contradicted":false}';
      },
    });
    const ask = seam.askModel({
      phase: 'verifying',
      repairInstruction: `${CONTRADICTION_CHECK_MARKER}\n${'e'.repeat(2_000)}`,
      toolResults: [],
      onPromptOverrun: (overrun) => overruns.push(overrun),
    });
    await expect(ask).rejects.toBeInstanceOf(PromptCeilingExceededError);
    expect(sent, 'nothing over the cap may reach the model').toBe(0);
    expect(overruns, 'and the condition is still reported — refusing is not the same as hiding').toHaveLength(1);
  });

  it('sends a contradiction directive that fits, unchanged', async () => {
    const prompts: string[] = [];
    const seam = createLiveModelSeam({
      modelId: 'lm:test/test',
      policy: budgetPolicy(10_000),
      runTurn: async (prompt) => {
        prompts.push(prompt);
        return '{"contradicted":false}';
      },
    });
    const directive = `${CONTRADICTION_CHECK_MARKER}\n${'e'.repeat(2_000)}`;
    await seam.askModel({ phase: 'verifying', repairInstruction: directive, toolResults: [] });
    expect(prompts).toEqual([directive]);
  });
});

describe('the per-turn prompt budget — enforcement is a type, not a convention', () => {
  it('will not let a prompt reach a model without going through the one gate that measures it', () => {
    // Structural, and the point of the whole shape: `runTurn` accepts only an `EnforcedPrompt`,
    // and `sealPrompt` is the only thing that mints one. A future path that assembles
    // model-facing text and tries to send it fails to compile here rather than being caught by a
    // reviewer who remembered the rule. If `runTurn` is ever widened back to `string`, the
    // `@ts-expect-error` below becomes unused and `tsc --noEmit` fails on that instead — so this
    // test cannot quietly stop testing anything.
    const send: LiveModelSeamOptions['runTurn'] = async (prompt) => prompt;
    // @ts-expect-error — a raw string has not been measured against maxPromptBytesPerTurn.
    void send('a prompt some future path assembled on its own');
    void send(sealPrompt('within the cap', { phase: 'verifying', ceilingBytes: 1_000 }));
  });

  it('measures the real bytes of the real string, and says which phase and which numbers when it refuses', () => {
    expect(sealPrompt('12345', { phase: 'planning', ceilingBytes: 5 })).toBe('12345');
    // Multi-byte content is measured in bytes, not characters: five code points, ten bytes.
    expect(() => sealPrompt('\u00e9\u00e9\u00e9\u00e9\u00e9', { phase: 'planning', ceilingBytes: 5 })).toThrow(PromptCeilingExceededError);
    try {
      sealPrompt('x'.repeat(100), { phase: 'investigating', ceilingBytes: 10 });
      throw new Error('unreachable');
    } catch (error) {
      expect((error as PromptCeilingExceededError).assembledBytes).toBe(100);
      expect((error as PromptCeilingExceededError).ceilingBytes).toBe(10);
      expect((error as Error).message).toContain('investigating');
    }
  });
});
