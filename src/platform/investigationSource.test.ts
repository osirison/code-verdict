/**
 * The investigation source's boundary — tasks 2.1 and 2.2 of
 * `add-local-git-investigation`, and the rule that superseded them.
 *
 * `InvestigationSource` names the operations that can be answered from two
 * commits and nothing else, which is what lets something that is not a forge
 * answer them. The boundary only holds if it is defended, and it is defended in
 * both directions now:
 *
 * - Nothing may join the five. The pressure to add "just the change request's
 *   title" or "just the current head" is exactly what would make a local git
 *   source impossible to write — a bare object store cannot answer either, and
 *   a commit id does not say which change request it belongs to.
 * - None of the five may go back onto a `Connection`. They were on it, as
 *   optional members, so a forge could serve a review's evidence when a local
 *   store could not. That fallback is gone, because a route that exists is a
 *   route that gets taken, and the whole point of reading from git is that the
 *   answer is exact. A provider that grows a `readDiff` again fails this file.
 *
 * Both are asserted as exact sets rather than as blacklists of names anyone
 * happened to think of, so an addition nobody predicted fails too. The second
 * half — the tripwire over the shipped connections themselves — lives in
 * `src/providers/investigationBoundary.test.ts`, because naming a concrete
 * provider is something only code under `src/providers` may do.
 */
import { describe, expect, it } from 'vitest';
import { INVESTIGATION_OPERATION_NAMES } from './types';

/** The five operations, and nothing else, in the order a reader would list them. */
const THE_FIVE = ['listChangedFiles', 'readDiff', 'readFile', 'searchDiff', 'searchRepository'];

/**
 * Everything a `Connection` answers that an object store cannot. Detail and
 * head questions are about the forge; the rest write to it.
 */
const FORGE_ONLY_OPERATIONS = [
  'getChangeRequestDetails',
  'getIssueDetails',
  'getCurrentHead',
  'getChangeRequestDiff',
  'submitReview',
  'approve',
  'listThreads',
  'resolveThread',
  'replyToThread',
  'getObjectSource',
];

describe('InvestigationSource carries exactly the five pinned operations (tasks 2.1, 2.2)', () => {
  it('names those five and no others', () => {
    expect([...INVESTIGATION_OPERATION_NAMES].sort()).toEqual([...THE_FIVE].sort());
  });

  it('keeps change-request details, issue details, current head, checks and posting off the source', () => {
    for (const operation of FORGE_ONLY_OPERATIONS) {
      expect(
        (INVESTIGATION_OPERATION_NAMES as readonly string[]).includes(operation),
        `${operation} is a question about the forge, not about two commits — it must not join InvestigationSource`,
      ).toBe(false);
    }
  });
});
