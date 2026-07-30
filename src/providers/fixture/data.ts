/**
 * Demo pod data, matching `spec/specs/Code Verdict - API fixtures.json` and
 * the prototype's demo data. Powers onboarding's "Skip and use a demo pod"
 * and keeps the provider contract suite honest offline.
 */
import type {
  ChangeRequest,
  ChangeRequestDiff,
  CiRun,
  RepoGroup,
  Repository,
  ReviewThread,
  WorkItem,
} from '../../platform/types';

export const GROUP: RepoGroup = { id: '4821', path: 'hve/platform', name: 'Platform' };

export const REPOSITORIES: Repository[] = [
  { id: '9101', path: 'hve/platform/core', name: 'core', webUrl: 'https://gitlab.example/hve/platform/core', openChangeRequestCount: 1 },
  { id: '9102', path: 'hve/platform/auth-service', name: 'auth-service', webUrl: 'https://gitlab.example/hve/platform/auth-service', openChangeRequestCount: 1 },
  { id: '9103', path: 'hve/platform/api-gateway', name: 'api-gateway', webUrl: 'https://gitlab.example/hve/platform/api-gateway', openChangeRequestCount: 1 },
  { id: '9104', path: 'hve/platform/billing', name: 'billing', webUrl: 'https://gitlab.example/hve/platform/billing', openChangeRequestCount: 0 },
  { id: '9105', path: 'hve/platform/notifications', name: 'notifications', webUrl: 'https://gitlab.example/hve/platform/notifications', openChangeRequestCount: 0 },
  { id: '9210', path: 'hve/web/console', name: 'console', webUrl: 'https://gitlab.example/hve/web/console', openChangeRequestCount: 1 },
];

export const GROUP_REPO_IDS = ['9101', '9102', '9103', '9104', '9105'];

export const DIFF_REFS = {
  base_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  head_sha: '4f19c2a7b1d3e9f0c5a8b2d4e6f7a9c1b3d5e7f9',
  start_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
};

export const CHANGE_REQUESTS: ChangeRequest[] = [
  {
    ref: { repoId: '9101', number: '2841' },
    title: 'Refactor token refresh',
    state: 'open',
    sourceBranch: 'feat/auth-refresh',
    targetBranch: 'main',
    author: { username: 'you', name: 'You' },
    reviewers: [{ username: 'rina' }],
    webUrl: 'https://gitlab.example/hve/platform/core/-/merge_requests/2841',
    updatedAt: '2026-07-28T09:41:12.000Z',
    headSha: DIFF_REFS.head_sha,
    changedFileCount: 9,
    ci: { runId: '90412', status: 'success', webUrl: 'https://gitlab.example/hve/platform/core/-/pipelines/90412' },
  },
  {
    ref: { repoId: '9102', number: '812' },
    title: 'Rotate signing keys on schedule',
    state: 'open',
    sourceBranch: 'feat/key-rotation',
    targetBranch: 'main',
    author: { username: 'kai', name: 'Kai' },
    reviewers: [{ username: 'you' }],
    webUrl: 'https://gitlab.example/hve/platform/auth-service/-/merge_requests/812',
    updatedAt: '2026-07-28T08:12:00.000Z',
    headSha: 'b2c3d4e5f60718293a4b5c6d7e8f9012345678a1',
    changedFileCount: 4,
    ci: { runId: '90398', status: 'running' },
  },
  {
    ref: { repoId: '9103', number: '381' },
    title: 'Propagate rotated key ids',
    state: 'open',
    sourceBranch: 'feat/key-rotation',
    targetBranch: 'main',
    author: { username: 'mira', name: 'Mira' },
    reviewers: [],
    webUrl: 'https://gitlab.example/hve/platform/api-gateway/-/merge_requests/381',
    updatedAt: '2026-07-27T16:40:00.000Z',
    headSha: 'c3d4e5f60718293a4b5c6d7e8f9012345678a1b2',
    changedFileCount: 6,
    ci: { runId: '90371', status: 'failed' },
  },
  {
    ref: { repoId: '9210', number: '1509' },
    title: 'Show key expiry banner',
    state: 'open',
    sourceBranch: 'feat/key-rotation',
    targetBranch: 'main',
    author: { username: 'kai', name: 'Kai' },
    reviewers: [{ username: 'you' }],
    webUrl: 'https://gitlab.example/hve/web/console/-/merge_requests/1509',
    updatedAt: '2026-07-27T11:02:00.000Z',
    headSha: 'd4e5f60718293a4b5c6d7e8f9012345678a1b2c3',
    changedFileCount: 3,
    ci: { runId: '90344', status: 'success' },
  },
];

const TOKEN_TS_DIFF = `@@ -60,6 +60,6 @@ export class TokenStore {
   async refresh(): Promise<void> {
     const res = await this.client.post('/oauth/token', this.grant)
     if (!res.ok) {
-      logger.error('refresh failed')
+      logger.error(\`refresh failed \${this.refreshToken}\`)
       throw new RefreshError(res.status)
     }
@@ -86,2 +86,3 @@ export class TokenStore {
-    if (this.refreshing) return this.pending
-    this.refreshing = true
+    if (this.refreshing) return this.pending
+    this.refreshing = true
+    this.pending = this.doRefresh()
`;

export const DIFFS: ChangeRequestDiff[] = [
  {
    ref: { repoId: '9101', number: '2841' },
    headSha: DIFF_REFS.head_sha,
    files: [
      { oldPath: 'src/auth/token.ts', newPath: 'src/auth/token.ts', diff: TOKEN_TS_DIFF },
      {
        oldPath: 'test/auth.spec.ts',
        newPath: 'test/auth.spec.ts',
        diff: `@@ -10,1 +10,2 @@\n describe('token', () => { /* happy path only */ })\n+  it.todo('401 -> refresh path')\n`,
      },
    ],
    anchorRefs: DIFF_REFS,
  },
];

export const THREADS: ReviewThread[] = [
  {
    id: 'd41d8cd98f00b204e9800998ecf8427e',
    crRef: { repoId: '9101', number: '2841' },
    resolved: false,
    anchorPresent: true,
    filePath: 'src/auth/token.ts',
    line: 63,
    notes: [
      {
        id: '771001',
        author: { username: 'you' },
        body: '**Refresh token logged in error path** · blocker · security · CWE-532 …',
        createdAt: '2026-07-28T09:52:00.000Z',
        resolvable: true,
        resolved: false,
      },
      {
        id: '771044',
        author: { username: 'kai' },
        body: "The shipper scrubs secrets in prod, doesn't it? I'd rather keep the full token for local debugging.",
        createdAt: '2026-07-28T11:58:00.000Z',
        resolvable: true,
        resolved: false,
      },
    ],
  },
  {
    id: 'b1946ac92492d2347c6235b4d2611184',
    crRef: { repoId: '9101', number: '2841' },
    resolved: true,
    anchorPresent: true,
    filePath: 'src/auth/token.ts',
    line: 88,
    notes: [
      {
        id: '771002',
        author: { username: 'you' },
        body: 'Store the in-flight promise and return it for subsequent callers.',
        createdAt: '2026-07-28T09:52:01.000Z',
        resolvable: true,
        resolved: true,
        resolvedBy: { username: 'kai' },
        resolvedAt: '2026-07-28T12:31:00.000Z',
      },
    ],
  },
  {
    id: 'c3fcd3d76192e4007dfb496cca67e13b',
    crRef: { repoId: '9101', number: '2841' },
    resolved: false,
    anchorPresent: false,
    notes: [
      {
        id: '771006',
        author: { username: 'you' },
        body: 'Gate the debug banner on NODE_ENV, not a query param.',
        createdAt: '2026-07-28T09:52:05.000Z',
        resolvable: true,
        resolved: false,
      },
    ],
  },
];

export const WORK_ITEMS: WorkItem[] = [
  {
    id: 'wi_1180',
    repoId: '9102',
    number: '1180',
    title: 'Key rotation, end to end',
    state: 'open',
    assignee: { username: 'kai' },
    milestone: '26.08',
    updatedAt: '2026-07-26T10:00:00.000Z',
    webUrl: 'https://gitlab.example/hve/platform/auth-service/-/issues/1180',
  },
];

export const CI_RUNS: CiRun[] = [
  { id: '90412', repoId: '9101', status: 'success', ref: 'feat/auth-refresh', createdAt: '2026-07-28T09:30:00.000Z' },
  { id: '90398', repoId: '9102', status: 'running', ref: 'feat/key-rotation', createdAt: '2026-07-28T08:10:00.000Z' },
  { id: '90371', repoId: '9103', status: 'failed', failedJobName: 'e2e:chrome', ref: 'feat/key-rotation', createdAt: '2026-07-27T16:35:00.000Z' },
];
