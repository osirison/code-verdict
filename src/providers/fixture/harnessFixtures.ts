/**
 * Fixture data for the agentic review harness (task 1.3 of
 * `add-agentic-review-harness`). Pagination, manifests, and the unavailable /
 * binary / too-large result states these fixtures exercise do not exist yet
 * (sections 2-4) — this module is content only, not wired into
 * `fixtureProvider.ts` or the demo-pod dataset in `./data.ts`.
 */
import type {
  ChangeRequestDiff,
  ChangeRequestRef,
  FileDiff,
  ReviewThread,
  ThreadNote,
  WorkItem,
} from '../../platform/types';

// ---- A small review ---------------------------------------------------------

export const SMALL_REVIEW_REF: ChangeRequestRef = { repoId: 'harness-small', number: '1' };

export const SMALL_REVIEW_DIFF: ChangeRequestDiff = {
  ref: SMALL_REVIEW_REF,
  baseSha: 'small-base-1',
  headSha: 'small-head-1',
  files: [
    {
      oldPath: 'src/util/parse.ts',
      newPath: 'src/util/parse.ts',
      diff: '@@ -1,3 +1,4 @@\n export function parse(input: string) {\n-  return input.trim()\n+  return input.trim().toLowerCase()\n }\n',
    },
  ],
  anchorRefs: { base_sha: 'small-base-1', head_sha: 'small-head-1' },
};

// ---- A paginated huge review -------------------------------------------------

/** The design's default manifest page size — the fixture spans more than two of these. */
export const HUGE_REVIEW_PAGE_SIZE = 100;
export const HUGE_REVIEW_FILE_COUNT = 250;

export const HUGE_REVIEW_REF: ChangeRequestRef = { repoId: 'harness-huge', number: '1' };

/** Generated rather than hand-listed — 250 literal entries would bury the fixture's intent. */
export function hugeReviewFiles(count = HUGE_REVIEW_FILE_COUNT): FileDiff[] {
  return Array.from({ length: count }, (_, index) => {
    const path = `src/generated/module${String(index).padStart(4, '0')}.ts`;
    return {
      oldPath: path,
      newPath: path,
      diff: `@@ -1,1 +1,2 @@\n export const value${index} = ${index}\n+export const doubled${index} = ${index * 2}\n`,
    };
  });
}

export const HUGE_REVIEW_DIFF: ChangeRequestDiff = {
  ref: HUGE_REVIEW_REF,
  baseSha: 'huge-base-1',
  headSha: 'huge-head-1',
  files: hugeReviewFiles(),
  anchorRefs: { base_sha: 'huge-base-1', head_sha: 'huge-head-1' },
};

// ---- Binary and renamed files ------------------------------------------------

export const BINARY_FILE: FileDiff = {
  oldPath: 'assets/logo.png',
  newPath: 'assets/logo.png',
  // Git's own placeholder for binary content — no hunk is expected here.
  diff: 'Binary files a/assets/logo.png and b/assets/logo.png differ',
};

export const RENAMED_FILE: FileDiff = {
  oldPath: 'src/legacy/tokenStore.ts',
  newPath: 'src/auth/tokenStore.ts',
  isRenamed: true,
  diff: '@@ -1,2 +1,2 @@\n-export class LegacyTokenStore {\n+export class TokenStore {\n   constructor() {}\n',
};

export const BINARY_AND_RENAMED_REF: ChangeRequestRef = { repoId: 'harness-mixed', number: '1' };

export const BINARY_AND_RENAMED_DIFF: ChangeRequestDiff = {
  ref: BINARY_AND_RENAMED_REF,
  baseSha: 'mixed-base-1',
  headSha: 'mixed-head-1',
  files: [BINARY_FILE, RENAMED_FILE],
  anchorRefs: { base_sha: 'mixed-base-1', head_sha: 'mixed-head-1' },
};

// ---- An unavailable oversized diff -------------------------------------------

/** One byte past the design's default single-tool-result ceiling (64 KiB). */
export const OVERSIZED_DIFF_BYTE_LENGTH = 64 * 1024 + 1;
export const OVERSIZED_FILE_PATH = 'package-lock.json';

/** Generated filler; only its byte length matters for a too-large/unavailable path. */
export function oversizedDiffBody(byteLength = OVERSIZED_DIFF_BYTE_LENGTH): string {
  const header = `@@ -1,1 +1,${byteLength} @@\n`;
  return header + '+'.repeat(Math.max(0, byteLength - header.length));
}

export const OVERSIZED_REVIEW_REF: ChangeRequestRef = { repoId: 'harness-oversized', number: '1' };

export const OVERSIZED_REVIEW_DIFF: ChangeRequestDiff = {
  ref: OVERSIZED_REVIEW_REF,
  baseSha: 'oversized-base-1',
  headSha: 'oversized-head-1',
  files: [{ oldPath: OVERSIZED_FILE_PATH, newPath: OVERSIZED_FILE_PATH, diff: oversizedDiffBody() }],
  anchorRefs: { base_sha: 'oversized-base-1', head_sha: 'oversized-head-1' },
};

// ---- Nested AGENTS.md ---------------------------------------------------------

export interface FixtureRepoFile {
  path: string;
  content: string;
}

export const NESTED_AGENTS_MD_REF: ChangeRequestRef = { repoId: 'harness-policy', number: '1' };
export const NESTED_AGENTS_MD_CHANGED_PATH = 'src/payments/charge.ts';

/** Root-to-leaf chain for the changed path above; no `readFile` tool exists yet to serve these (sections 3/4/6). */
export const NESTED_AGENTS_MD: FixtureRepoFile[] = [
  { path: 'AGENTS.md', content: '# Repository policy\n\nNever log secrets. Prefer explicit error types.\n' },
  { path: 'src/AGENTS.md', content: '# src policy\n\nPublic exports require a doc comment.\n' },
  { path: 'src/payments/AGENTS.md', content: '# Payments policy\n\nAmounts are integer minor units. Never use floating point for money.\n' },
];

export const NESTED_AGENTS_MD_DIFF: ChangeRequestDiff = {
  ref: NESTED_AGENTS_MD_REF,
  baseSha: 'policy-base-1',
  headSha: 'policy-head-1',
  files: [
    {
      oldPath: NESTED_AGENTS_MD_CHANGED_PATH,
      newPath: NESTED_AGENTS_MD_CHANGED_PATH,
      diff: '@@ -10,2 +10,2 @@\n function charge(amountMinorUnits: number) {\n-  const fee = amountMinorUnits * 0.029\n+  const fee = Math.round(amountMinorUnits * 0.029)\n',
    },
  ],
  anchorRefs: { base_sha: 'policy-base-1', head_sha: 'policy-head-1' },
};

// ---- A changed head -----------------------------------------------------------

export const CHANGED_HEAD_REF: ChangeRequestRef = { repoId: 'harness-stale', number: '1' };
/** The head the harness snapshotted at run start. */
export const CHANGED_HEAD_SNAPSHOT_SHA = 'stale-head-snapshot-1';
/** What the provider reports later — a push landed mid-run. */
export const CHANGED_HEAD_LATER_SHA = 'stale-head-later-2';

const CHANGED_HEAD_FILE: FileDiff = {
  oldPath: 'src/order/total.ts',
  newPath: 'src/order/total.ts',
  diff: '@@ -5,1 +5,1 @@\n-  return items.reduce((sum, i) => sum + i.price, 0)\n+  return items.reduce((sum, i) => sum + i.price * i.qty, 0)\n',
};

export const CHANGED_HEAD_SNAPSHOT_DIFF: ChangeRequestDiff = {
  ref: CHANGED_HEAD_REF,
  baseSha: 'stale-base-1',
  headSha: CHANGED_HEAD_SNAPSHOT_SHA,
  files: [CHANGED_HEAD_FILE],
  anchorRefs: { base_sha: 'stale-base-1', head_sha: CHANGED_HEAD_SNAPSHOT_SHA },
};

/** Same ref, later head — evidence bound to the snapshot must not be reused against this one. */
export const CHANGED_HEAD_LATER_DIFF: ChangeRequestDiff = {
  ref: CHANGED_HEAD_REF,
  baseSha: 'stale-base-1',
  headSha: CHANGED_HEAD_LATER_SHA,
  files: [
    CHANGED_HEAD_FILE,
    {
      oldPath: 'src/order/discount.ts',
      newPath: 'src/order/discount.ts',
      diff: '@@ -1,1 +1,2 @@\n export function discount(total: number) {\n+  if (total < 0) throw new RangeError(\'negative total\')\n',
    },
  ],
  anchorRefs: { base_sha: 'stale-base-1', head_sha: CHANGED_HEAD_LATER_SHA },
};

// ---- Long issue/discussion details ---------------------------------------------

export const LONG_ISSUE_REF: ChangeRequestRef = { repoId: 'harness-long-issue', number: '1' };

const LONG_ISSUE_PARAGRAPH =
  'This item accumulated scope across three planning cycles because the original migration touched every downstream consumer of the pricing API, and each consumer required its own compatibility window before the deprecated field could be removed safely without breaking billing reconciliation.';

export const LONG_ISSUE: WorkItem = {
  id: 'wi_harness_900',
  repoId: LONG_ISSUE_REF.repoId,
  number: '900',
  title: 'Deprecate the legacy pricing field end to end',
  description: Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1}. ${LONG_ISSUE_PARAGRAPH}`).join('\n\n'),
  state: 'open',
  assignee: { username: 'rina' },
  milestone: '26.09',
  updatedAt: '2026-08-20T10:00:00.000Z',
  webUrl: 'https://harness.invalid/issues/900',
};

export const LONG_DISCUSSION_NOTE_COUNT = 40;

/** Generated; a long discussion's defining property is its length, not each reply's wording. */
export function longDiscussionNotes(count = LONG_DISCUSSION_NOTE_COUNT): ThreadNote[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `harness_note_${index}`,
    author: { username: index % 2 === 0 ? 'rina' : 'kai' },
    body: `Reply ${index}: ${LONG_ISSUE_PARAGRAPH.slice(0, 80)}…`,
    createdAt: new Date(Date.UTC(2026, 7, 20, 10, index)).toISOString(),
    resolvable: true,
    resolved: false,
  }));
}

export const LONG_DISCUSSION: ReviewThread = {
  id: 'harness_thread_long',
  crRef: LONG_ISSUE_REF,
  resolved: false,
  anchorPresent: false,
  notes: longDiscussionNotes(),
};

// ---- A multi-member changeset ---------------------------------------------------

/** Shaped like `ChangesetAgentMember` (`src/app/combinedAgent.ts`) without importing it — providers stay below app. */
export interface FixtureChangesetMember {
  ref: ChangeRequestRef;
  projectPath: string;
  diff: ChangeRequestDiff;
}

export const CHANGESET_ID = 'harness-changeset-1';

export const CHANGESET_MEMBERS: FixtureChangesetMember[] = [
  {
    ref: { repoId: 'harness-cs-core', number: '11' },
    projectPath: 'harness/core',
    diff: {
      ref: { repoId: 'harness-cs-core', number: '11' },
      baseSha: 'cs-core-base',
      headSha: 'cs-core-head',
      anchorRefs: { head: 'cs-core' },
      files: [{ oldPath: 'src/schema/order.ts', newPath: 'src/schema/order.ts', diff: '@@ -3,1 +3,2 @@\n export interface Order {\n+  taxAmountMinorUnits: number\n' }],
    },
  },
  {
    ref: { repoId: 'harness-cs-billing', number: '22' },
    projectPath: 'harness/billing',
    diff: {
      ref: { repoId: 'harness-cs-billing', number: '22' },
      baseSha: 'cs-billing-base',
      headSha: 'cs-billing-head',
      anchorRefs: { head: 'cs-billing' },
      files: [{ oldPath: 'src/invoice/build.ts', newPath: 'src/invoice/build.ts', diff: '@@ -12,1 +12,2 @@\n const order = await orders.load(id)\n+const tax = order.taxAmountMinorUnits\n' }],
    },
  },
  {
    ref: { repoId: 'harness-cs-console', number: '33' },
    projectPath: 'harness/console',
    diff: {
      ref: { repoId: 'harness-cs-console', number: '33' },
      baseSha: 'cs-console-base',
      headSha: 'cs-console-head',
      anchorRefs: { head: 'cs-console' },
      files: [{ oldPath: 'src/views/OrderSummary.tsx', newPath: 'src/views/OrderSummary.tsx', diff: '@@ -20,1 +20,2 @@\n const total = order.total\n+const tax = order.taxAmountMinorUnits ?? 0\n' }],
    },
  },
];
