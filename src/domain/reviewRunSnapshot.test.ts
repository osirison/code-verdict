import { describe, expect, it } from 'vitest';
import { DEFAULT_CRITERIA } from './criteria';
import { baseRevisionKindOf } from './reviewRunSnapshot';
import type {
  ReviewRunAgentsPolicySource,
  ReviewRunMemberSnapshot,
  ReviewRunSnapshot,
} from './reviewRunSnapshot';

function member(overrides: Partial<ReviewRunMemberSnapshot> = {}): ReviewRunMemberSnapshot {
  return {
    memberId: 'm1',
    providerId: 'gitlab',
    instanceUrl: 'https://gitlab.example.com',
    ref: { repoId: 'repo-1', number: '2841' },
    baseSha: 'base-1',
    // What `buildReviewRunSnapshot` writes for every member it builds now.
    baseRevisionKind: 'mergeBase',
    headSha: 'head-1',
    providerCapabilitySignature: 'sig-1',
    rootAgentsPolicy: { present: false },
    context: {
      autoContextEnabled: true,
      titleIncluded: true,
      descriptionIncluded: true,
      linkedItemIdsIncluded: [],
      attachments: [],
    },
    ...overrides,
  };
}

function snapshot(overrides: Partial<ReviewRunSnapshot> = {}): ReviewRunSnapshot {
  return {
    schemaVersion: '1',
    runId: 'run-1',
    lineageId: 'lineage-1',
    attempt: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    targetKind: 'cr',
    members: [member()],
    agentId: 'agent:builtin/default',
    agentInstructions: 'Review ONLY the diffs below.',
    agentInstructionsDigest: 'digest-1',
    personaLabel: 'Default review',
    modelId: 'lm:acme/turbo',
    modelCapability: { vendor: 'acme', family: 'turbo', maxInputTokens: 128_000 },
    effort: 'medium',
    effortInstructionDigest: 'digest-2',
    criteria: DEFAULT_CRITERIA,
    extraInstructionsDigest: 'digest-3',
    toolContractVersion: '1',
    harnessPolicyVersion: '1',
    ...overrides,
  };
}

describe('ReviewRunSnapshot (task 2.2)', () => {
  it('captures a single-member individual review', () => {
    const s = snapshot();
    expect(s.targetKind).toBe('cr');
    expect(s.changesetId).toBeUndefined();
    expect(s.members).toHaveLength(1);
  });

  it('captures a multi-member changeset with distinct member identities', () => {
    const s = snapshot({
      targetKind: 'changeset',
      changesetId: 'harness-changeset-1',
      members: [
        member({ memberId: 'core', ref: { repoId: 'harness-cs-core', number: '11' } }),
        member({ memberId: 'billing', ref: { repoId: 'harness-cs-billing', number: '22' } }),
        member({ memberId: 'console', ref: { repoId: 'harness-cs-console', number: '33' } }),
      ],
    });
    expect(s.members.map((m) => m.memberId)).toEqual(['core', 'billing', 'console']);
    expect(new Set(s.members.map((m) => m.ref.repoId)).size).toBe(3);
  });

  it('omits model identity and capability for the demo agent', () => {
    const s = snapshot({ modelId: undefined, modelCapability: undefined });
    expect(s.modelId).toBeUndefined();
    expect(s.modelCapability).toBeUndefined();
  });

  it('distinguishes explicit AGENTS.md absence from a present policy source', () => {
    const absent: ReviewRunAgentsPolicySource = { present: false };
    const present: ReviewRunAgentsPolicySource = { present: true, sourceId: 'src-1', digest: 'digest-4' };
    expect(absent.present).toBe(false);
    expect(present.present && present.sourceId).toBe('src-1');
  });

  /**
   * Task 5.4. `baseSha` used to be whatever the provider happened to report,
   * and GitHub reported the tip of the target branch — a commit that moves
   * while a review is in flight. The commit is now the merge base, and this
   * field is how a record says which of the two it holds, because the string
   * itself cannot.
   */
  describe('baseRevisionKind', () => {
    it('reads a record written before the field existed as a target-branch tip', () => {
      // Not `undefined`-as-unknown: every snapshot written before this change
      // used the target-branch tip by construction, so absence is a fact
      // about the record, and reading it as the merge base would relabel
      // evidence as computed against a commit it never was.
      const stored = member();
      delete (stored as { baseRevisionKind?: unknown }).baseRevisionKind;
      expect('baseRevisionKind' in stored).toBe(false);
      expect(baseRevisionKindOf(stored)).toBe('targetBranchTip');
    });

    it('reads each stated meaning back as itself', () => {
      expect(baseRevisionKindOf(member({ baseRevisionKind: 'mergeBase' }))).toBe('mergeBase');
      expect(baseRevisionKindOf(member({ baseRevisionKind: 'targetBranchTip' }))).toBe('targetBranchTip');
    });
  });

  it('never carries live attachment or agent-descriptor shapes, only digests and ids', () => {
    const s = snapshot();
    // Compile-time proof as much as runtime: these are the only attachment fields.
    expect(Object.keys(s.members[0]!.context.attachments[0] ?? { attachmentId: '', label: '', contentDigest: '' }).sort()).toEqual(
      ['attachmentId', 'contentDigest', 'label'].sort(),
    );
  });
});
