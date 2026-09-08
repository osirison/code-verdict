/**
 * The provider contract: a reusable conformance suite every `ScmProvider`
 * implementation must pass (fixture today, GitLab next, any future provider
 * after). Adding a provider means making this suite green — see
 * docs/ARCHITECTURE.md "Adding a provider".
 */
import { describe, expect, it } from 'vitest';
import type { Connection, ProviderCapabilities } from '../provider';
import { investigationResultValue, isFetchableObjectSourceUrl } from '../types';
import type { ChangeRequestRef, ObjectSourceDescriptor, ReviewCommentDraft } from '../types';

/**
 * Every key `ObjectSourceDescriptor` has, as data, so the conformance case can
 * refuse a provider that returns a sixth one. `satisfies Record<keyof …>`
 * fails to compile in both directions: a field added to the descriptor and not
 * listed here leaves a required key missing, and a name listed here that is
 * not a field is an excess property.
 */
const OBJECT_SOURCE_DESCRIPTOR_KEYS: ReadonlySet<string> = new Set(
  Object.keys({
    fetchUrl: true,
    authorizationHeaderValue: true,
    refHint: true,
    mergeTargetRef: true,
  } satisfies Record<keyof ObjectSourceDescriptor, true>),
);

/** One connection plus a way to land a commit on its change request's target branch mid-review. */
export interface MovingTargetBranchHarness {
  conn: Connection;
  /**
   * Advances the target branch and returns the commit it now points at. The
   * change request itself is untouched — nothing is rebased, no commit is
   * pushed to its source branch — so its merge base cannot have moved.
   */
  advanceTargetBranch(): string;
}

export interface ProviderContractHarness {
  capabilities: ProviderCapabilities;
  makeConnection(): Connection | Promise<Connection>;
  /**
   * A connection whose SECOND line-comment write fails with a `staleAnchor`
   * error while the first succeeds — exercises partial-failure reporting.
   */
  makeFailingConnection?(): Connection | Promise<Connection>;
  /**
   * One connection whose target branch can move between two calls
   * (`add-local-git-investigation` task 5.5). Omit to skip the base-revision
   * case — it needs a double that can change what the platform answers, which
   * a wholly static response table cannot do.
   */
  makeMovingTargetBranchConnection?(): MovingTargetBranchHarness | Promise<MovingTargetBranchHarness>;
  /**
   * Whether THIS HARNESS's backing store actually remembers a
   * replyToThread/resolveThread write and plays it back on the next
   * listThreads — never a statement about the provider. Every provider must
   * implement both calls correctly; this only says whether the double behind
   * a given harness can observe that. A harness backed by a real emulator or
   * an in-memory fake can say true; one backed by a fixed, static response
   * table (as GitHub's and GitLab's REST fakes are today — see
   * fakeGitHub.ts's `graphqlResponse()` and fakeGitLab.ts's discussions
   * route, both of which hand back the same canned payload no matter what
   * was just posted) must leave it unset, or the case would fail for a
   * reason that has nothing to do with the provider under test.
   */
  threadMutationsPersist?: boolean;
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
  /**
   * A connection whose *detail* reads always fail with a `rateLimited`
   * `ScmError` — exercises retryability without a real 429.
   *
   * It was `makeRateLimitedInvestigationConnection` and it read a file, back
   * when a provider served investigation. The five pinned operations came off
   * `Connection` and the case was deleted with them, which lost the guarantee
   * rather than retiring it: the two detail reads that are left are still
   * network calls to a forge, still the calls a rate limit lands on, and the
   * host still has to see a neutral retryable error rather than a platform's
   * own. So it is restored against what a connection still answers.
   *
   * Optional: a harness that omits it skips the case.
   */
  makeRateLimitedDetailConnection?(): Connection | Promise<Connection>;
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

    if (harness.makeMovingTargetBranchConnection) {
      /**
       * `baseSha` is the merge base (`src/platform/types.ts`), and the merge
       * base does not move when the target branch does. This is the case that
       * separates the two: a commit lands on the target branch between two
       * calls on ONE connection, and the reported base revision has to be the
       * same commit both times.
       *
       * Before `add-local-git-investigation` task 5.1 the GitHub provider
       * failed this outright — it reported `pull.base.sha`, so the second call
       * returned the commit that had just landed, and every attempt resumed
       * after it compared its evidence against a different pair of commits
       * than the one that evidence was computed over.
       *
       * Both halves are asserted: the same value twice, and that the value is
       * not the commit the branch moved to. Equality alone would also be
       * satisfied by a provider that answered from a stale cache.
       */
      it('reports a base revision that does not move when the target branch does', async () => {
        const { conn, advanceTargetBranch } = await harness.makeMovingTargetBranchConnection!();
        const before = await conn.getChangeRequestDiff(harness.crRef);
        const movedTo = advanceTargetBranch();
        const after = await conn.getChangeRequestDiff(harness.crRef);

        expect(after.baseSha).toBe(before.baseSha);
        expect(after.baseSha).not.toBe(movedTo);
        // The change request itself did not move either.
        expect(after.headSha).toBe(before.headSha);
      });
    }

    /**
     * The object-source descriptor is neutral or it is nothing
     * (`add-local-git-investigation` task 2.5).
     *
     * Two legal answers and no third: a descriptor whose fetch location is an
     * ordinary `http`/`https` URL a consumer can use exactly as given, or an
     * explicit unavailable with a reason someone can read. What this case
     * exists to forbid is the shape in between — a value the caller has to
     * interpret before it can use it. A bare repository id, a template with a
     * placeholder in it, an `ssh://` or `ext::` location, a URL with the
     * credential stuffed into its userinfo: each of those pushes a decision
     * back across the provider boundary, and the whole point of the descriptor
     * is that the consumer makes no decisions about it at all.
     *
     * The key whitelist is the part that catches a provider smuggling its own
     * shape through. A platform-specific extra field would be invisible to
     * every other assertion here and would be exactly how forge knowledge
     * leaks above the boundary.
     *
     * Not implementing the operation is also legal, and is what a provider
     * with no remote to name does. It is not a fallback: nothing serves
     * investigation in a provider's place any more, so a connection with no
     * descriptor leaves a review of that repository with nothing to read, and
     * the attempt refuses with that as its reason.
     */
    it('answers the object-source descriptor with an http(s) location or an explicit unavailable reason, never something a caller must interpret', async () => {
      const conn = await harness.makeConnection();
      if (!conn.getObjectSource) return;

      const result = await conn.getObjectSource(harness.crRef);
      if (result.state === 'unavailable') {
        expect(result.reason.trim()).not.toBe('');
        return;
      }

      const { descriptor } = result;
      expect(Object.keys(descriptor).every((key) => OBJECT_SOURCE_DESCRIPTOR_KEYS.has(key))).toBe(true);
      expect(isFetchableObjectSourceUrl(descriptor.fetchUrl)).toBe(true);
      const url = new URL(descriptor.fetchUrl);
      expect(['http:', 'https:']).toContain(url.protocol);
      // A credential belongs in the header value, never in the location.
      expect(url.username).toBe('');
      expect(url.password).toBe('');
      // A location, not a template the caller has to fill in.
      expect(descriptor.fetchUrl).not.toMatch(/[{}]/);
      if (descriptor.authorizationHeaderValue !== undefined) {
        expect(descriptor.authorizationHeaderValue.trim()).not.toBe('');
      }
      if (descriptor.refHint !== undefined) expect(descriptor.refHint.trim()).not.toBe('');
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

    // Closes the gap named in issue #33: every provider declares
    // replyToThread/resolveThread, and until now nothing in the shared suite
    // called either one. Gated on threadMutationsPersist — see that field's
    // comment for why a harness may legitimately sit this out.
    if (harness.threadMutationsPersist) {
      it('replyToThread posts a note that a subsequent listThreads returns on the same thread', async () => {
        const conn = await harness.makeConnection();
        const before = await conn.listThreads(harness.crRef);
        const target = before[0];
        expect(target).toBeDefined();
        // Captured as a number, not read off `target` afterwards: a provider
        // backed by an in-memory store may hand out live references, so the
        // object in `before` is the very one the reply mutates and comparing
        // against it compares a value with itself.
        const notesBefore = target?.notes.length ?? 0;
        const marker = 'Contract test reply — round trip check.';

        await conn.replyToThread(harness.crRef, target?.id as string, marker);

        const after = await conn.listThreads(harness.crRef);
        const updated = after.find((t) => t.id === target?.id);
        expect(updated?.notes.some((n) => n.body === marker)).toBe(true);
        expect(updated?.notes.length).toBe(notesBefore + 1);
      });

      it('resolveThread(true) marks a thread resolved, and resolveThread(false) reverses it', async () => {
        const conn = await harness.makeConnection();
        const threads = await conn.listThreads(harness.crRef);
        // Not threads[0]: a seeded fixture can start with its first thread
        // already resolved, which would make the "marks resolved" half of
        // this case pass trivially — it never toggled anything.
        const target = threads.find((t) => !t.resolved) ?? threads[0];
        expect(target).toBeDefined();

        await conn.resolveThread(harness.crRef, target?.id as string, true);
        const resolved = (await conn.listThreads(harness.crRef)).find((t) => t.id === target?.id);
        expect(resolved?.resolved).toBe(true);

        await conn.resolveThread(harness.crRef, target?.id as string, false);
        const reopened = (await conn.listThreads(harness.crRef)).find((t) => t.id === target?.id);
        expect(reopened?.resolved).toBe(false);
      });
    }

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

    /**
     * The two structured detail reads (design.md D7), and the three facts about
     * them that survived the provider ceasing to be an investigation source.
     *
     * Five of the eight cases that stood here read a diff, a file or a search at
     * a pinned pair, and they went when `Connection` stopped carrying those
     * operations — there is nothing left on a connection for them to ask. These
     * three ask only what a forge still answers, so deleting them deleted a
     * guarantee that was still true, which is a different thing from retiring
     * one that no longer applies.
     *
     * The pinned pair comes from `getChangeRequestDiff` rather than from a
     * declared fixture value: the harness no longer states a base sha, and the
     * connection's own answer is the pair a host would pin anyway.
     */
    if (harness.capabilities.detailRetrieval) {
      const detail = harness.capabilities.detailRetrieval;
      const snapshotFor = async (conn: Connection) => {
        const diff = await conn.getChangeRequestDiff(harness.crRef);
        return { repoId: expected.repoId, baseSha: diff.baseSha, headSha: diff.headSha };
      };

      if (detail.changeRequestDetails.supported) {
        it('normalizes change-request details with explicit unavailable sections, never a raw payload', async () => {
          const conn = await harness.makeConnection();
          const result = await conn.getChangeRequestDetails!({ snapshot: await snapshotFor(conn), number: harness.crRef.number });
          const value = investigationResultValue(result);
          if (!value) return;
          expect(typeof value.title).toBe('string');
          // A section this platform could not answer is *named* as unavailable.
          // A provider that drops it instead leaves the host unable to tell "no
          // description" from "the description was not read".
          expect(Array.isArray(value.unavailableSections)).toBe(true);
        });
      }

      it('withholds or reports unavailable for every detail operation the provider does not declare supported', async () => {
        const conn = await harness.makeConnection();
        const snapshot = await snapshotFor(conn);

        function assertNotComplete(result: { state: string } | undefined): void {
          if (result) expect(result.state).not.toBe('complete');
        }

        if (!detail.changeRequestDetails.supported) {
          assertNotComplete(await conn.getChangeRequestDetails?.({ snapshot, number: harness.crRef.number }));
        }
        if (!detail.issueDetails.supported) {
          assertNotComplete(
            await conn.getIssueDetails?.({ snapshot, issueRepoId: expected.repoId, issueNumber: harness.crRef.number }),
          );
        }
      });

      const makeRateLimited = harness.makeRateLimitedDetailConnection?.bind(harness);
      if (makeRateLimited && detail.changeRequestDetails.supported) {
        it('surfaces a rate-limited detail read as the neutral retryable error', async () => {
          const limited = await makeRateLimited();
          // The pair is resolved through an ordinary connection on purpose: this
          // case is about a rate-limited *read*, so the snapshot it reads at has
          // to come from somewhere that answers.
          const snapshot = await snapshotFor(await harness.makeConnection());
          await expect(limited.getChangeRequestDetails!({ snapshot, number: harness.crRef.number })).rejects.toMatchObject({ kind: 'rateLimited' });
        });
      }
    }
  });
}
