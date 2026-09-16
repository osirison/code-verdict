import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { NormalizedDetail } from '../platform/types';
import { buildBootstrapEnvelope, buildBootstrapSection, type BootstrapEnvelope, type BootstrapMemberSections } from '../domain/harnessBootstrap';
import { fitBootstrapToModel } from './harnessBootstrapBudget';

function detail(bodyLength = 200): NormalizedDetail {
  return {
    title: 'Rotate refresh tokens on use',
    body: 'x'.repeat(bodyLength),
    labels: ['security'],
    commits: [{ sha: 'c1', message: 'rotate on use', author: 'a' }],
    discussion: [],
    checkSummaries: [],
    relationships: [],
    unavailableSections: [],
  };
}

function envelope(bodyLength = 200): BootstrapEnvelope {
  const memberSections: BootstrapMemberSections = {
    memberId: 'm1',
    changeRequestDetails: buildBootstrapSection({
      kind: 'changeRequestDetails',
      sectionId: 'cr:1',
      detail: detail(bodyLength),
      digest: 'd1',
      providerState: 'complete',
      maxInlineChars: 1_000_000, // section-level inline budget is generous; the model-token gate is what this module tests
    }),
    issueDetails: [],
  };
  return buildBootstrapEnvelope({
    members: [{ memberId: 'm1', repoId: 'repo-1', baseSha: 'base-1', headSha: 'head-1' }],
    personaLabel: 'Default review',
    agentInstructions: 'You are a code review agent. Review ONLY the diffs below.',
    criteria: DEFAULT_CRITERIA,
    effort: 'medium',
    effortInstruction: 'Review effort instruction: reason through the diff before reporting.',
    contextDeclaration: 'Auto-context: title, description. No explicit attachments.',
    rootPolicies: [{ memberId: 'm1', source: { present: false } }],
    toolContractVersion: '1',
    harnessPolicyVersion: '1',
    memberSections: [memberSections],
  });
}

/** A trivial deterministic counter: token count == rendered character length / 4, rounded up — realistic enough to exercise shrink ordering. */
function charBasedCounter() {
  return vi.fn(async (text: string) => Math.ceil(text.length / 4));
}

describe('fitBootstrapToModel (task 6.6)', () => {
  it('always fits, and never counts tokens, when there is no model (the demo agent)', async () => {
    const countTokens = vi.fn(async () => 10);
    const result = await fitBootstrapToModel({ envelope: envelope(), maxInputTokens: undefined, countTokens });
    expect(result.ok).toBe(true);
    expect(countTokens).not.toHaveBeenCalled();
  });

  it('fits on the first attempt when the full envelope is already within budget', async () => {
    const countTokens = charBasedCounter();
    const full = envelope(200);
    const result = await fitBootstrapToModel({ envelope: full, maxInputTokens: 1_000_000, countTokens });
    expect(result.ok).toBe(true);
    expect(result.ok && result.envelope).toBe(full);
    expect(countTokens).toHaveBeenCalledTimes(1);
  });

  it('replaces reopenable sections with summaries before shortening tool descriptions', async () => {
    const countTokens = charBasedCounter();
    const big = envelope(50_000);
    const fullTokens = await charBasedCounter()(JSON.stringify(big));
    // A budget between the full envelope's size and the summarized envelope's size forces exactly one shrink step.
    const result = await fitBootstrapToModel({ envelope: big, maxInputTokens: Math.floor(fullTokens / 4), countTokens });
    expect(result.ok).toBe(true);
    expect(result.ok && typeof result.envelope.untrusted[0]!.changeRequestDetails.content).toBe('string');
    // Tool descriptions survive the first shrink step — only the sections were summarized, not the catalog.
    expect(result.ok && result.envelope.authoritative.toolCatalog.every((t) => t.description !== '')).toBe(true);
    expect(countTokens).toHaveBeenCalledTimes(2);
  });

  it('fails closed with a bootstrapOverflow limitation when even the minimal envelope cannot fit, and never invokes a model', async () => {
    const countTokens = charBasedCounter();
    const huge = envelope(200_000);
    const result = await fitBootstrapToModel({ envelope: huge, maxInputTokens: 1, countTokens });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.completeness).toBe('none');
    expect(!result.ok && result.limitation.code).toBe('bootstrapOverflow');
    expect(!result.ok && result.limitation.message).toContain('bootstrap envelope');
    // Every shrink tactic was tried (4 attempts: full, summarized, minimal, policy-text-omitted) before giving up.
    expect(countTokens).toHaveBeenCalledTimes(4);
  });

  it('fails closed rather than guessing a fit when the model cannot be asked to count at all', async () => {
    const countTokens = vi.fn(async () => undefined);
    const result = await fitBootstrapToModel({ envelope: envelope(), maxInputTokens: 1_000, countTokens });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.completeness).toBe('none');
    expect(!result.ok && result.limitation.message).toContain('Could not determine');
  });

  it('drops root-policy text (down to identity plus a stated reason) as the last shrink tactic, after summarizing sections and shortening tool descriptions', async () => {
    const countTokens = charBasedCounter();
    // A small envelope apart from one member's oversized root-policy text: the first two shrink
    // tactics (section summaries, tool descriptions) cannot help here at all, so this proves the
    // *third* tactic is what actually gets this envelope to fit, not merely present in the loop.
    const withBigPolicy = buildBootstrapEnvelope({
      members: [{ memberId: 'm1', repoId: 'repo-1', baseSha: 'base-1', headSha: 'head-1' }],
      personaLabel: 'Default review',
      agentInstructions: 'You are a code review agent. Review ONLY the diffs below.',
      criteria: DEFAULT_CRITERIA,
      effort: 'medium',
      effortInstruction: 'Review effort instruction: reason through the diff before reporting.',
      contextDeclaration: 'Auto-context: title, description. No explicit attachments.',
      rootPolicies: [{ memberId: 'm1', source: { present: true, sourceId: 'agents-policy:base-1:.', digest: 'digest-1', text: 'x'.repeat(50_000), files: ['agentsMd'] } }],
      toolContractVersion: '1',
      harnessPolicyVersion: '1',
      memberSections: [{ memberId: 'm1', changeRequestDetails: buildBootstrapSection({ kind: 'changeRequestDetails', sectionId: 'cr:1', detail: detail(50), digest: 'd1', providerState: 'complete', maxInlineChars: 1_000_000 }), issueDetails: [] }],
    });
    const fullTokens = await charBasedCounter()(JSON.stringify(withBigPolicy));
    const minimalTokens = await charBasedCounter()(JSON.stringify(withBigPolicy)); // sections/tool descriptions do not shrink this envelope at all
    const result = await fitBootstrapToModel({ envelope: withBigPolicy, maxInputTokens: Math.floor(minimalTokens / 4), countTokens });
    expect(fullTokens).toBe(minimalTokens); // confirms the first two tactics really do nothing here
    expect(result.ok).toBe(true);
    expect(countTokens).toHaveBeenCalledTimes(4);
    const source = result.ok ? result.envelope.authoritative.rootPolicies[0]!.source : undefined;
    expect(source?.text).toBeUndefined();
    expect(source?.sourceId).toBe('agents-policy:base-1:.');
    expect(source?.digest).toBe('digest-1');
    expect(source?.textOmittedReason).toContain("did not fit the model's input limit");
  });
});
