/**
 * The provider contract: a reusable conformance suite every `ScmProvider`
 * implementation must pass (fixture today, GitLab next, any future provider
 * after). Adding a provider means making this suite green — see
 * docs/ARCHITECTURE.md "Adding a provider".
 */
import { describe, expect, it } from 'vitest';
import type { Connection, ProviderCapabilities } from '../provider';
import type { ChangeRequestRef, ReviewCommentDraft } from '../types';

export interface ProviderContractHarness {
  capabilities: ProviderCapabilities;
  makeConnection(): Connection | Promise<Connection>;
  /**
   * A connection whose SECOND line-comment write fails with a `staleAnchor`
   * error while the first succeeds — exercises partial-failure reporting.
   */
  makeFailingConnection?(): Connection | Promise<Connection>;
  inputs: {
    /** Resolves to a repository (URL or path form). */
    repository: string;
    /** Resolves to a group; required when capabilities.groupHierarchy. */
    group?: string;
    /** A syntactically valid numeric id the token cannot see. */
    notVisible: string;
    /** Garbage that must resolve to noMatch, never silently added. */
    noMatch: string;
  };
  expected: {
    repoId: string;
    repoPath: string;
    groupId?: string;
  };
  /** An open change request that has a diff. */
  crRef: ChangeRequestRef;
  /** A file/line pair inside that diff a comment can anchor to. */
  anchor: { filePath: string; line: number };
}

export function describeProviderContract(label: string, harness: ProviderContractHarness): void {
  const { inputs, expected } = harness;

  describe(`provider contract: ${label}`, () => {
    it('testConnection reports the signed-in user', async () => {
      const conn = await harness.makeConnection();
      const status = await conn.testConnection();
      expect(status.ok).toBe(true);
      expect(status.username).toBeTruthy();
    });

    it('resolves a repository input', async () => {
      const conn = await harness.makeConnection();
      const res = await conn.resolveSource(inputs.repository);
      expect(res.kind).toBe('repository');
      if (res.kind === 'repository') {
        expect(res.repo.id).toBe(expected.repoId);
        expect(res.repo.path).toBe(expected.repoPath);
      }
    });

    if (harness.capabilities.groupHierarchy) {
      it('resolves a group input to a repository chooser', async () => {
        const conn = await harness.makeConnection();
        const res = await conn.resolveSource(inputs.group as string);
        expect(res.kind).toBe('group');
        if (res.kind === 'group') {
          expect(res.group.id).toBe(expected.groupId);
          expect(res.repositories.length).toBeGreaterThan(0);
        }
      });
    }

    it('reports an unseen numeric id as notVisible, never adding it', async () => {
      const conn = await harness.makeConnection();
      const res = await conn.resolveSource(inputs.notVisible);
      expect(res.kind).toBe('notVisible');
    });

    it('reports garbage input as noMatch', async () => {
      const conn = await harness.makeConnection();
      const res = await conn.resolveSource(inputs.noMatch);
      expect(res.kind).toBe('noMatch');
    });

    it('lists open change requests batched per repository', async () => {
      const conn = await harness.makeConnection();
      const crs = await conn.listOpenChangeRequests([expected.repoId]);
      expect(crs.length).toBeGreaterThan(0);
      for (const cr of crs) {
        expect(cr.ref.repoId).toBe(expected.repoId);
        expect(cr.state).toBe('open');
        expect(cr.headSha).toBeTruthy();
        expect(cr.webUrl).toBeTruthy();
      }
    });

    it('returns a diff whose anchors round-trip into a successful submit', async () => {
      const conn = await harness.makeConnection();
      const diff = await conn.getChangeRequestDiff(harness.crRef);
      expect(diff.headSha).toBeTruthy();
      expect(diff.files.length).toBeGreaterThan(0);

      const comments: ReviewCommentDraft[] = [
        {
          key: 'c1',
          body: 'Contract test comment one.',
          anchor: { filePath: harness.anchor.filePath, line: harness.anchor.line, refs: diff.anchorRefs },
        },
        {
          key: 'c2',
          body: 'Contract test comment two.',
          anchor: { filePath: harness.anchor.filePath, line: harness.anchor.line, refs: diff.anchorRefs },
          suggestion: { old: 'const a = 1', new: 'const a = 2' },
        },
      ];
      const result = await conn.submitReview(harness.crRef, {
        comments,
        summary: 'Contract test summary.',
      });

      expect(result.comments.map((c) => c.key)).toEqual(['c1', 'c2']);
      expect(result.comments.every((c) => c.ok)).toBe(true);
      expect(result.summaryPosted).toBe(true);
    });

    it('lists threads with notes and anchor presence', async () => {
      const conn = await harness.makeConnection();
      const threads = await conn.listThreads(harness.crRef);
      expect(threads.length).toBeGreaterThan(0);
      for (const t of threads) {
        expect(t.id).toBeTruthy();
        expect(t.notes.length).toBeGreaterThan(0);
        expect(typeof t.anchorPresent).toBe('boolean');
      }
    });

    if (harness.makeFailingConnection) {
      it('reports per-comment outcomes on partial failure and withholds the summary', async () => {
        const conn = await harness.makeFailingConnection!();
        const diff = await conn.getChangeRequestDiff(harness.crRef);
        const result = await conn.submitReview(harness.crRef, {
          comments: [
            {
              key: 'ok',
              body: 'Lands.',
              anchor: { filePath: harness.anchor.filePath, line: harness.anchor.line, refs: diff.anchorRefs },
            },
            {
              key: 'fails',
              body: 'Does not land.',
              anchor: { filePath: harness.anchor.filePath, line: harness.anchor.line, refs: diff.anchorRefs },
            },
          ],
          summary: 'Must not be posted.',
        });

        const [first, second] = result.comments;
        expect(first?.ok).toBe(true);
        expect(second?.ok).toBe(false);
        expect(second?.error?.kind).toBe('staleAnchor');
        expect(result.summaryPosted).toBe(false);
      });
    }
  });
}
