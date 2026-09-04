import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { buildBootstrapEnvelope, buildBootstrapSection, type BootstrapEnvelope, type BuildBootstrapEnvelopeInput } from '../domain/harnessBootstrap';
import { HARNESS_TOOL_CONTRACT_VERSION } from '../domain/harnessTools';
import { createLiveModelSeam, renderModelPrompt } from './harnessModelSeam';
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
    const prompt = renderModelPrompt({ phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(prompt).toContain('readDiff');
    expect(prompt).toContain('Exact changed evidence and inline anchors.');
    expect(prompt).toContain('Built-in reviewer');
    expect(prompt).toContain('You are a code review agent. Review ONLY the diffs below.');
    expect(prompt).toContain('Severity floor');
    expect(prompt).toContain(DEFAULT_CRITERIA.severityFloor);
  });

  it('marks a registered attachment CITABLE with its exact sourceId and digest, and an unregistered one not citable', () => {
    const prompt = renderModelPrompt({ phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() });
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
    const prompt = renderModelPrompt({ phase: 'investigating', repairInstruction: undefined, toolResults: results, envelope: envelope() });
    expect(prompt).toContain('ev_readdiff1');
    expect(prompt).toContain('digest-diff-1');
    expect(prompt).toContain('CITABLE');
    expect(prompt).toContain('@@ -1 +1 @@');
    expect(prompt).toContain('The provider could not return this file.');
  });

  it('reports no prior tool results honestly on a phase\'s first turn', () => {
    const prompt = renderModelPrompt({ phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(prompt).toContain('this is the first turn of this phase');
  });

  it('names only the current phase\'s legal message kinds', () => {
    const planning = renderModelPrompt({ phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(planning).toContain('planCreated');
    expect(planning).not.toMatch(/legal message kinds.*candidateSubmission/);

    const investigating = renderModelPrompt({ phase: 'investigating', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(investigating).toContain('candidateSubmission');
    expect(investigating).not.toMatch(/legal message kinds.*planCreated/);
  });

  it('appends the repair instruction verbatim when one is present', () => {
    const prompt = renderModelPrompt({
      phase: 'planning',
      repairInstruction: 'Your last reply was not valid JSON. Resend as {"messages": [...]}.',
      toolResults: [],
      envelope: envelope(),
    });
    expect(prompt).toContain('Protocol repair needed');
    expect(prompt).toContain('Your last reply was not valid JSON.');
  });

  it('marks untrusted bootstrap content as untrusted and non-citable, distinct from the citable attachment', () => {
    const prompt = renderModelPrompt({ phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() });
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
    const seam = createLiveModelSeam({ modelId: 'test-model', runTurn });
    const reply = await seam.askModel({ phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() });
    expect(reply).toBe('{"messages":[{"kind":"publicRationale","rationale":"ok"}]}');
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it('fails closed rather than sending a promptless request when no envelope is attached', async () => {
    const runTurn = vi.fn(async () => 'unused');
    const seam = createLiveModelSeam({ modelId: 'test-model', runTurn });
    await expect(seam.askModel({ phase: 'planning', repairInstruction: undefined, toolResults: [] })).rejects.toThrow(/no bootstrap envelope/);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it('propagates a missing/refusing model\'s rejection without any fallback', async () => {
    const failure = new Error('Model test-model is no longer available');
    const runTurn = vi.fn(async () => {
      throw failure;
    });
    const seam = createLiveModelSeam({ modelId: 'test-model', runTurn });
    await expect(seam.askModel({ phase: 'planning', repairInstruction: undefined, toolResults: [], envelope: envelope() })).rejects.toBe(failure);
  });

  it('sends a contradiction-check directive as-is, with no envelope required', async () => {
    const directive = `${CONTRADICTION_CHECK_MARKER}\ncandidateId: c1\nReply with exactly one JSON object...`;
    const runTurn = vi.fn(async (prompt: string) => {
      expect(prompt).toBe(directive);
      return '{"candidateId":"c1","contradicted":false}';
    });
    const seam = createLiveModelSeam({ modelId: 'test-model', runTurn });
    const reply = await seam.askModel({ phase: 'verifying', repairInstruction: directive, toolResults: [] });
    expect(reply).toBe('{"candidateId":"c1","contradicted":false}');
    expect(runTurn).toHaveBeenCalledWith(directive);
  });

  it('still fails closed on an envelope-less call whose repair instruction is not a contradiction check', async () => {
    const runTurn = vi.fn(async () => 'unused');
    const seam = createLiveModelSeam({ modelId: 'test-model', runTurn });
    await expect(
      seam.askModel({ phase: 'planning', repairInstruction: 'Your last reply was not valid JSON.', toolResults: [] }),
    ).rejects.toThrow(/no bootstrap envelope/);
    expect(runTurn).not.toHaveBeenCalled();
  });
});
