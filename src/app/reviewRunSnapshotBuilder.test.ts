import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENT_DESCRIPTOR, DEMO_AGENT_DESCRIPTOR, type AgentDescriptor } from './agents';
import type { Attachment, ReviewContext } from './reviewContext';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import {
  buildReviewRunSnapshot,
  providerCapabilitySignature,
  type ReviewRunSnapshotInput,
  type ReviewRunSnapshotMemberInput,
} from './reviewRunSnapshotBuilder';
import type { ProviderCapabilities } from '../platform/provider';

const CAPABILITIES: ProviderCapabilities = {
  suggestions: true,
  approvals: true,
  requestChanges: true,
  threadResolution: true,
  groupHierarchy: false,
  batchedReview: false,
};

function member(overrides: Partial<ReviewRunSnapshotMemberInput> = {}): ReviewRunSnapshotMemberInput {
  return {
    memberId: 'm1',
    providerId: 'gitlab',
    instanceUrl: 'https://gitlab.example.com',
    ref: { repoId: 'repo-1', number: '2841' },
    baseSha: 'base-1',
    headSha: 'head-1',
    capabilities: CAPABILITIES,
    rootAgentsPolicy: { present: false },
    ...overrides,
  };
}

function baseInput(overrides: Partial<ReviewRunSnapshotInput> = {}): ReviewRunSnapshotInput {
  return {
    runId: 'run-1',
    lineageId: 'lineage-1',
    attempt: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    targetKind: 'cr',
    members: [member()],
    agent: BUILTIN_AGENT_DESCRIPTOR,
    model: { id: 'lm:acme/turbo', label: 'Turbo', description: 'acme · turbo', vendor: 'acme', family: 'turbo', maxInputTokens: 128_000 },
    effort: 'medium',
    criteria: DEFAULT_CRITERIA,
    ...overrides,
  };
}

describe('buildReviewRunSnapshot (task 6.1)', () => {
  it('captures a single-member individual review with every resolved and digested field', () => {
    const snapshot = buildReviewRunSnapshot(baseInput());
    expect(snapshot.schemaVersion).toBe('1');
    expect(snapshot.targetKind).toBe('cr');
    expect(snapshot.agentId).toBe(BUILTIN_AGENT_DESCRIPTOR.id);
    expect(snapshot.agentInstructions).toBe(BUILTIN_AGENT_DESCRIPTOR.instructions);
    expect(snapshot.agentInstructionsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.personaLabel).toBe(BUILTIN_AGENT_DESCRIPTOR.label);
    expect(snapshot.modelId).toBe('lm:acme/turbo');
    expect(snapshot.modelCapability).toEqual({ vendor: 'acme', family: 'turbo', maxInputTokens: 128_000 });
    expect(snapshot.effort).toBe('medium');
    expect(snapshot.effortInstructionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.criteria).toEqual(DEFAULT_CRITERIA);
    expect(snapshot.extraInstructionsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.toolContractVersion).toBe('1');
    expect(snapshot.harnessPolicyVersion).toBe('1');
    expect(snapshot.members).toHaveLength(1);
    expect(snapshot.members[0]!.providerCapabilitySignature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('omits model identity and capability for the demo agent', () => {
    const snapshot = buildReviewRunSnapshot(baseInput({ agent: DEMO_AGENT_DESCRIPTOR, model: undefined }));
    expect(snapshot.modelId).toBeUndefined();
    expect(snapshot.modelCapability).toBeUndefined();
  });

  it('captures a multi-member changeset with distinct member identities', () => {
    const snapshot = buildReviewRunSnapshot(baseInput({
      targetKind: 'changeset',
      changesetId: 'harness-changeset-1',
      members: [
        member({ memberId: 'core', ref: { repoId: 'harness-cs-core', number: '11' } }),
        member({ memberId: 'billing', ref: { repoId: 'harness-cs-billing', number: '22' } }),
      ],
    }));
    expect(snapshot.changesetId).toBe('harness-changeset-1');
    expect(snapshot.members.map((m) => m.memberId)).toEqual(['core', 'billing']);
    expect(new Set(snapshot.members.map((m) => m.ref.repoId)).size).toBe(2);
  });

  it('keeps each changeset member\'s explicit attachments to itself: one member\'s attachment never appears in another member\'s context (task 13.1)', () => {
    const coreAttachment: Attachment = { id: 'att-core', kind: 'file', label: 'schema.ts', path: 'schema.ts', content: 'export const coreSchema = 1;', truncated: false };
    const billingAttachment: Attachment = { id: 'att-billing', kind: 'file', label: 'invoice.ts', path: 'invoice.ts', content: 'export const invoiceSchema = 2;', truncated: false };
    const snapshot = buildReviewRunSnapshot(baseInput({
      targetKind: 'changeset',
      changesetId: 'harness-changeset-2',
      members: [
        member({ memberId: 'core', ref: { repoId: 'harness-cs-core', number: '11' }, attachments: [coreAttachment] }),
        member({ memberId: 'billing', ref: { repoId: 'harness-cs-billing', number: '22' }, attachments: [billingAttachment] }),
      ],
    }));
    const core = snapshot.members.find((m) => m.memberId === 'core')!;
    const billing = snapshot.members.find((m) => m.memberId === 'billing')!;
    expect(core.context.attachments.map((a) => a.attachmentId)).toEqual(['att-core']);
    expect(billing.context.attachments.map((a) => a.attachmentId)).toEqual(['att-billing']);
  });

  it('leaves a member with no attachments empty, even when a sibling member carries one (task 13.1)', () => {
    const attachment: Attachment = { id: 'att-core', kind: 'file', label: 'schema.ts', path: 'schema.ts', content: 'export const coreSchema = 1;', truncated: false };
    const snapshot = buildReviewRunSnapshot(baseInput({
      targetKind: 'changeset',
      changesetId: 'harness-changeset-3',
      members: [
        member({ memberId: 'core', ref: { repoId: 'harness-cs-core', number: '11' }, attachments: [attachment] }),
        member({ memberId: 'billing', ref: { repoId: 'harness-cs-billing', number: '22' } }),
      ],
    }));
    expect(snapshot.members.find((m) => m.memberId === 'billing')!.context.attachments).toEqual([]);
  });

  it('rejects an empty member list', () => {
    expect(() => buildReviewRunSnapshot(baseInput({ members: [] }))).toThrow();
  });

  it('produces the same agent-instructions digest for identical instructions and a different one for different instructions', () => {
    const a: AgentDescriptor = { ...BUILTIN_AGENT_DESCRIPTOR, id: 'agent:a' };
    const b: AgentDescriptor = { ...BUILTIN_AGENT_DESCRIPTOR, id: 'agent:b', instructions: `${BUILTIN_AGENT_DESCRIPTOR.instructions} extra` };
    const first = buildReviewRunSnapshot(baseInput({ agent: a }));
    const same = buildReviewRunSnapshot(baseInput({ agent: { ...a, id: 'agent:a-again' } }));
    const different = buildReviewRunSnapshot(baseInput({ agent: b }));
    expect(first.agentInstructionsDigest).toBe(same.agentInstructionsDigest);
    expect(first.agentInstructionsDigest).not.toBe(different.agentInstructionsDigest);
  });

  it('produces a different effort digest for a different effort level', () => {
    const low = buildReviewRunSnapshot(baseInput({ effort: 'low' }));
    const high = buildReviewRunSnapshot(baseInput({ effort: 'high' }));
    expect(low.effortInstructionDigest).not.toBe(high.effortInstructionDigest);
  });

  it('produces a different extra-instructions digest for different criteria text', () => {
    const withExtra = buildReviewRunSnapshot(baseInput({ criteria: { ...DEFAULT_CRITERIA, extraInstructions: 'focus on auth' } }));
    const withoutExtra = buildReviewRunSnapshot(baseInput());
    expect(withExtra.extraInstructionsDigest).not.toBe(withoutExtra.extraInstructionsDigest);
  });

  it('signs a capability object identically regardless of key order, and differently for a real difference', () => {
    const reordered: ProviderCapabilities = {
      batchedReview: CAPABILITIES.batchedReview,
      groupHierarchy: CAPABILITIES.groupHierarchy,
      threadResolution: CAPABILITIES.threadResolution,
      requestChanges: CAPABILITIES.requestChanges,
      approvals: CAPABILITIES.approvals,
      suggestions: CAPABILITIES.suggestions,
    };
    expect(providerCapabilitySignature(CAPABILITIES)).toBe(providerCapabilitySignature(reordered));
    expect(providerCapabilitySignature(CAPABILITIES)).not.toBe(
      providerCapabilitySignature({ ...CAPABILITIES, groupHierarchy: true }),
    );
  });

  it('captures context selections: per-source inclusion, included linked-item ids, and attachment content digests', () => {
    const context: ReviewContext = {
      title: 'Add refresh token rotation',
      description: 'Rotates refresh tokens on use.',
      linkedItems: [{ number: '42', resolved: true, title: 'Rotate tokens' }],
      includeTitle: true,
      includeDescription: false,
    };
    const attachments: Attachment[] = [
      { id: 'att-1', kind: 'file', label: 'auth.ts', path: 'src/auth.ts', content: 'export const x = 1;', truncated: false },
    ];
    const snapshot = buildReviewRunSnapshot(baseInput({ members: [member({ context, attachments })] }));
    const captured = snapshot.members[0]!.context;
    expect(captured.autoContextEnabled).toBe(true);
    expect(captured.titleIncluded).toBe(true);
    expect(captured.descriptionIncluded).toBe(false);
    expect(captured.linkedItemIdsIncluded).toEqual(['42']);
    expect(captured.attachments).toHaveLength(1);
    expect(captured.attachments[0]!.attachmentId).toBe('att-1');
    expect(captured.attachments[0]!.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports no auto-context at all for a member with no ReviewContext', () => {
    const snapshot = buildReviewRunSnapshot(baseInput());
    const captured = snapshot.members[0]!.context;
    expect(captured.autoContextEnabled).toBe(false);
    expect(captured.titleIncluded).toBe(false);
    expect(captured.descriptionIncluded).toBe(false);
    expect(captured.linkedItemIdsIncluded).toEqual([]);
  });

  it('passes explicit AGENTS.md presence and absence through unchanged', () => {
    const absent = buildReviewRunSnapshot(baseInput());
    expect(absent.members[0]!.rootAgentsPolicy).toEqual({ present: false });

    const present = buildReviewRunSnapshot(baseInput({
      members: [member({ rootAgentsPolicy: { present: true, sourceId: 'src-1', digest: 'digest-1' } })],
    }));
    expect(present.members[0]!.rootAgentsPolicy).toEqual({ present: true, sourceId: 'src-1', digest: 'digest-1' });
  });
});
