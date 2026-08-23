/**
 * LIVE WRITE-PATH check for task 6.4. Drives the real GitHub provider against
 * a throwaway repo. Everything goes through createGitHubProvider() — the only
 * raw API calls are the independent before/after verification reads.
 */
import { createGitHubProvider } from '../../src/providers/github/githubProvider';
import type { Credential } from '../../src/platform/provider';
import type { ReviewCommentDraft } from '../../src/platform/types';

const TOKEN = process.env.GH_TOKEN ?? '';
// Deliberately required, with no default: this script POSTS reviews, and a
// default would eventually point at a repository someone cares about.
const REPO = process.env.GH_REPO ?? '';
const PR = process.env.GH_PR ?? '';
if (TOKEN === '' || REPO === '' || PR === '') {
  console.error('Set GH_TOKEN, GH_REPO (owner/repo) and GH_PR. Use a THROWAWAY pull request.');
  process.exit(2);
}
const ref = { repoId: REPO, number: PR };

const provider = createGitHubProvider();
const connFor = (credential: Credential) =>
  provider.connect({ instanceUrl: 'https://github.com', credential });

let failures = 0;
function check(label: string, pass: boolean, detail?: unknown): void {
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}

/** Independent read, deliberately NOT through the provider. */
async function api(path: string): Promise<any> {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}
const reviewIds = async (): Promise<number[]> => (await api(`repos/${REPO}/pulls/${PR}/reviews?per_page=100`)).map((r: any) => r.id);

async function main(): Promise<void> {
  const conn = connFor({ kind: 'token', token: TOKEN });

  console.log('\n[0] diff + anchorRefs from the provider');
  const diff = await conn.getChangeRequestDiff(ref);
  console.log(`  files=${diff.files.length} headSha=${diff.headSha.slice(0, 8)} anchorRefs=${JSON.stringify(diff.anchorRefs)}`);
  const refs = diff.anchorRefs;

  const valid = (filePath: string, line: number, key: string, body: string): ReviewCommentDraft =>
    ({ key, body, anchor: { filePath, line, side: 'new', refs } });

  // ---------------------------------------------------------------- case 1
  console.log('\n[1] CLEAN, token credential — summary + 2 valid inline comments');
  const before1 = await reviewIds();
  const r1 = await conn.submitReview(ref, {
    comments: [
      valid('src/alpha.ts', 20, 'k-alpha', 'Case 1: anchored at alpha.ts line 20.'),
      valid('src/beta.ts', 10, 'k-beta', 'Case 1: anchored at beta.ts line 10.'),
    ],
    summary: 'Case 1 summary — batched review, token credential.',
    asSingleThread: true,
  });
  const after1 = await reviewIds();
  const new1 = after1.filter((id) => !before1.includes(id));
  check('exactly one new review created', new1.length === 1, { new: new1.length });
  check('both comments ok', r1.comments.every((c) => c.ok), r1.comments.map((c) => ({ key: c.key, ok: c.ok, err: c.error?.kind })));
  check('summaryPosted', r1.summaryPosted === true);
  check('postedAsSingleReview is true', r1.postedAsSingleReview === true);
  check('every outcome carries a threadId', r1.comments.every((c) => !!c.threadId), r1.comments.map((c) => c.threadId));

  // NB: /reviews/{id}/comments returns the legacy `position` shape with no
  // `line`. /pulls/{n}/comments is the endpoint that reports the resolved line.
  const posted = (await api(`repos/${REPO}/pulls/${PR}/comments?per_page=100`))
    .filter((c: any) => c.pull_request_review_id === new1[0]);
  check('review carries 2 comments', posted.length === 2, posted.length);
  const anchored = posted.map((c: any) => `${c.path}:${c.line}`).sort();
  check('comments anchored where submitted', JSON.stringify(anchored) === JSON.stringify(['src/alpha.ts:20', 'src/beta.ts:10']), anchored);

  const threads1 = await conn.listThreads(ref);
  const ids1 = new Set(threads1.map((t) => t.id));
  check('threadIds resolve against listThreads (round-3 fix #1)',
    r1.comments.every((c) => c.threadId !== undefined && ids1.has(c.threadId)),
    { outcomes: r1.comments.map((c) => c.threadId), listThreads: [...ids1] });

  // ---------------------------------------------------------------- case 2
  console.log('\n[2] CLEAN, session credential — same OAuth token, session arm');
  const sConn = connFor({ kind: 'session', accessToken: TOKEN });
  const status = await sConn.testConnection();
  check('testConnection ok via session credential', status.ok === true, status.username);
  const before2 = await reviewIds();
  const r2 = await sConn.submitReview(ref, {
    comments: [valid('src/alpha.ts', 21, 'k-session', 'Case 2: posted through the session credential arm.')],
    summary: 'Case 2 summary — session credential.',
    asSingleThread: true,
  });
  const after2 = await reviewIds();
  const new2 = after2.filter((id) => !before2.includes(id));
  check('exactly one new review created', new2.length === 1, { new: new2.length });
  check('comment ok', r2.comments.every((c) => c.ok), r2.comments.map((c) => ({ ok: c.ok, err: c.error?.message })));
  const threads2 = await sConn.listThreads(ref);
  const ids2 = new Set(threads2.map((t) => t.id));
  check('threadId resolves against listThreads', r2.comments.every((c) => c.threadId && ids2.has(c.threadId)));

  // ---------------------------------------------------------------- case 3
  console.log('\n[3] FALLBACK — one valid anchor + one line outside the diff');
  const before3 = await reviewIds();
  const r3 = await conn.submitReview(ref, {
    comments: [
      valid('src/alpha.ts', 22, 'k-good', 'Case 3: valid anchor, should land.'),
      valid('src/alpha.ts', 1, 'k-bad', 'Case 3: line 1 is outside the diff, should be rejected.'),
    ],
    summary: 'Case 3 summary — expecting the per-comment fallback.',
    asSingleThread: true,
  });
  console.log('  outcomes:', JSON.stringify(r3.comments.map((c) => ({ key: c.key, ok: c.ok, kind: c.error?.kind, threadId: c.threadId })), null, 0));
  const good = r3.comments.find((c) => c.key === 'k-good');
  const bad = r3.comments.find((c) => c.key === 'k-bad');
  check('valid comment landed', good?.ok === true);
  check('invalid comment reported as failed', bad?.ok === false, bad?.error?.kind);
  check('invalid comment classified staleAnchor', bad?.error?.kind === 'staleAnchor', bad?.error?.message);
  // Withholding the summary over an incomplete review is deliberate
  // (githubProvider.ts: "The summary is withheld over an incomplete review,
  // but the verdict is not"), so that the app's retry does not double-post it.
  check('summary withheld over the incomplete review, as designed', r3.summaryPosted === false);
  check('postedAsSingleReview is false — it went comment-by-comment', r3.postedAsSingleReview === false);
  const threads3 = await conn.listThreads(ref);
  const ids3 = new Set(threads3.map((t) => t.id));
  check('fallback comment has a real GraphQL threadId (round-3 fix #1)',
    good?.threadId !== undefined && ids3.has(good.threadId), good?.threadId);
  const after3 = await reviewIds();
  console.log(`  reviews created by the fallback: ${after3.filter((id) => !before3.includes(id)).length}`);

  // ---------------------------------------------------------------- case 4
  console.log('\n[4] SELF-AUTHORED requestChanges — GitHub must refuse');
  const r4 = await conn.submitReview(ref, {
    comments: [valid('src/alpha.ts', 23, 'k-rc', 'Case 4: comment carried by a refused request-for-changes.')],
    summary: 'Case 4 summary — requesting changes on my own pull request.',
    requestChanges: true,
    asSingleThread: true,
  });
  check('requestChangesApplied is false', r4.requestChangesApplied === false, r4.requestChangesApplied);
  check('surfaced as requestChangesError (task 5.7)', r4.requestChangesError !== undefined, r4.requestChangesError?.message);
  // Terminal: a caller that retries this gets the identical refusal forever.
  check('classified verdictRefused, not a generic 422', r4.requestChangesError?.kind === 'verdictRefused', r4.requestChangesError?.kind);
  check('the summary still landed despite the refusal', r4.summaryPosted === true);
  check('not reported as a comment failure', r4.comments.every((c) => c.ok), r4.comments.map((c) => c.ok));

  // ---------------------------------------------------------------- case 5
  console.log('\n[5] SELF-AUTHORED approve, WITH inline comments — nothing may be lost');
  const before5 = await reviewIds();
  const r5 = await conn.submitReview(ref, {
    comments: [valid('src/beta.ts', 11, 'k-approve', 'Case 5: comment carried by a refused approval.')],
    summary: 'Case 5 summary — approving my own pull request.',
    approve: true,
    asSingleThread: true,
  });
  const new5 = (await reviewIds()).filter((id) => !before5.includes(id));
  check('the review was still posted', new5.length === 1, { new: new5.length });
  check('the inline comment landed', r5.comments.every((c) => c.ok), r5.comments.map((c) => ({ ok: c.ok, err: c.error?.message })));
  check('the summary landed', r5.summaryPosted === true);
  // This submission has a summary, so the downgrade re-sends it as one
  // COMMENT review — still one review, hence true. (Without a summary the
  // downgrade posts standalone comments and reports false; covered in the
  // emulator suite, since a bodiless COMMENT review is itself a 422.)
  check('postedAsSingleReview is true — the downgrade is still one review', r5.postedAsSingleReview === true);
  check('approvalApplied is false', r5.approvalApplied === false);
  check('surfaced as approvalError (task 5.7)', r5.approvalError !== undefined, r5.approvalError?.message);
  check('classified verdictRefused', r5.approvalError?.kind === 'verdictRefused', r5.approvalError?.kind);
  const threads5 = await conn.listThreads(ref);
  const ids5 = new Set(threads5.map((t) => t.id));
  check('threadId still resolves on the downgraded review',
    r5.comments.every((c) => c.threadId && ids5.has(c.threadId)), r5.comments.map((c) => c.threadId));

  console.log(`\n${failures === 0 ? 'LIVE WRITE CHECK PASSED' : `LIVE WRITE CHECK: ${failures} FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error('\nERROR:', e); process.exit(1); });
