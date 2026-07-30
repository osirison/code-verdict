/**
 * The emulator's world: GitLab-shaped records (this module *is* the fake
 * GitLab, so GitLab shapes are correct here) generated deterministically
 * from a seed. The flagship data mirrors the spec fixtures so every screen
 * in `spec/` has something real to render; procedural filler adds bulk.
 */
import { Prng } from './prng';

export type ScenarioName =
  | 'happy'
  | 'empty-pod'
  | 'token-expired'
  | 'insufficient-scope'
  | 'rate-limited'
  | 'stale-anchor';

export const SCENARIOS: readonly ScenarioName[] = [
  'happy',
  'empty-pod',
  'token-expired',
  'insufficient-scope',
  'rate-limited',
  'stale-anchor',
];

export interface EmUser {
  username: string;
  name: string;
}

export interface EmGroup {
  id: number;
  full_path: string;
  name: string;
}

export interface EmProject {
  id: number;
  path_with_namespace: string;
  name: string;
  web_url: string;
  group_id?: number;
}

export interface EmFile {
  old_path: string;
  new_path: string;
  diff: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
}

export interface EmPipeline {
  id: number;
  project_id: number;
  sha: string;
  ref: string;
  status: 'success' | 'failed' | 'running' | 'pending' | 'canceled';
  web_url: string;
  created_at: string;
}

export interface EmMergeRequest {
  project_id: number;
  iid: number;
  title: string;
  description: string;
  state: 'opened' | 'merged' | 'closed';
  source_branch: string;
  target_branch: string;
  author: EmUser;
  reviewers: EmUser[];
  web_url: string;
  updated_at: string;
  base_sha: string;
  start_sha: string;
  head_sha: string;
  files: EmFile[];
  /** Set by the GraphQL reviewer-state mutation. */
  reviewer_state?: 'requested_changes';
  /**
   * Scenario override: every discussion POST on this MR fails with the
   * stale-anchor 400 regardless of the refs sent — as if the branch moves
   * the instant before every submit.
   */
  anchors_invalid?: boolean;
  /** Usernames that POSTed /approve. */
  approved_by: string[];
  /** Plain MR notes (e.g. the posted summary comment). */
  notes: EmNote[];
}

export interface EmPosition {
  position_type: 'text';
  base_sha: string;
  start_sha: string;
  head_sha: string;
  old_path: string;
  new_path: string;
  new_line?: number;
  old_line?: number;
}

export interface EmNote {
  id: number;
  author: EmUser;
  body: string;
  created_at: string;
  resolvable?: boolean;
  resolved?: boolean;
  resolved_by?: EmUser;
  resolved_at?: string;
  /** null = anchor dropped by a force-push; undefined = not a diff note. */
  position?: EmPosition | null;
}

export interface EmDiscussion {
  id: string;
  project_id: number;
  mr_iid: number;
  individual_note: boolean;
  notes: EmNote[];
}

export interface EmIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  state: 'opened' | 'closed';
  assignees: EmUser[];
  milestone: { title: string } | null;
  updated_at: string;
  web_url: string;
}

export type TokenState = 'valid' | 'expired' | 'readOnly';

export interface FailureInjection {
  /** 1-based index of the discussion POST that fails (per engine lifetime). */
  discussionPostFailAt?: number;
  /** HTTP status for that failure (default 400 stale-anchor). */
  discussionPostFailStatus?: number;
}

export interface World {
  seed: number;
  scenario: ScenarioName;
  baseUrl: string;
  users: EmUser[];
  you: EmUser;
  groups: EmGroup[];
  projects: EmProject[];
  mergeRequests: EmMergeRequest[];
  pipelines: EmPipeline[];
  issues: EmIssue[];
  discussions: EmDiscussion[];
  /** Named tokens; any other `glpat-*` token is accepted as valid. */
  tokens: Record<string, TokenState>;
  rateLimited: boolean;
  failures: FailureInjection;
  counters: { note: number; discussion: number; pipeline: number };
}

// ---------------------------------------------------------------------------

const MR_TITLES = [
  'Harden webhook signature checks',
  'Cache group lookups per request',
  'Migrate audit log to partitioned table',
  'Debounce search-as-you-type',
  'Drop legacy v3 payload support',
  'Extract retry policy into middleware',
  'Tighten CSP for embedded views',
  'Batch email digests per project',
];

const ISSUE_TITLES = [
  'Flaky e2e: session expiry banner',
  'Slow cold start on review tab',
  'Audit log misses approval events',
  'Digest email renders raw markdown',
  'Search ranking ignores recency',
];

const BRANCH_WORDS = ['fix', 'feat', 'chore', 'perf'];
const FILE_STEMS = ['api/client', 'auth/session', 'jobs/digest', 'ui/banner', 'core/retry', 'db/audit'];

function isoDaysAgo(days: number, hour = 9): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hour, 12, 0, 0);
  return d.toISOString();
}

function makeDiff(rng: Prng, stem: string): string {
  const start = rng.int(8, 120);
  const name = stem.split('/')[1] ?? 'value';
  return [
    `@@ -${start},7 +${start},9 @@ export function ${name}() {`,
    `   const options = normalize(input)`,
    `-  return run(options)`,
    `+  if (!options.valid) {`,
    `+    throw new InputError('invalid ${name} options')`,
    `+  }`,
    `+  return run(options, { retries: ${rng.int(1, 3)} })`,
    ``,
  ].join('\n');
}

/** The flagship diff mirrors the spec fixture anchors (token.ts:63 and :88). */
const TOKEN_TS_DIFF = [
  '@@ -58,12 +58,14 @@ export class TokenStore {',
  '   async refresh(): Promise<void> {',
  "     const res = await this.client.post('/oauth/token', this.grant)",
  '     if (!res.ok) {',
  "-      logger.error('refresh failed')",
  '+      logger.error(`refresh failed ${this.refreshToken}`)',
  '       throw new RefreshError(res.status)',
  '     }',
  '@@ -84,8 +86,9 @@ export class TokenStore {',
  '-    if (this.refreshing) return this.pending',
  '-    this.refreshing = true',
  '+    if (this.refreshing) return this.pending',
  '+    this.refreshing = true',
  '+    this.pending = this.doRefresh()',
  '',
].join('\n');

export function generateWorld(seed: number, scenario: ScenarioName, baseUrl: string): World {
  const rng = new Prng(seed);

  const you: EmUser = { username: 'you', name: 'You' };
  const users: EmUser[] = [
    you,
    { username: 'kai', name: 'Kai Tanaka' },
    { username: 'mira', name: 'Mira Osei' },
    { username: 'rina', name: 'Rina Volkov' },
  ];
  const others = users.slice(1);

  const groups: EmGroup[] = [{ id: 4821, full_path: 'hve/platform', name: 'Platform' }];

  const projectDefs: Array<[number, string, number | undefined]> = [
    [9101, 'hve/platform/core', 4821],
    [9102, 'hve/platform/auth-service', 4821],
    [9103, 'hve/platform/api-gateway', 4821],
    [9104, 'hve/platform/billing', 4821],
    [9105, 'hve/platform/notifications', 4821],
    [9210, 'hve/web/console', undefined],
  ];
  const projects: EmProject[] = projectDefs.map(([id, path, group_id]) => ({
    id,
    path_with_namespace: path,
    name: path.split('/').pop() as string,
    web_url: `${baseUrl}/${path}`,
    group_id,
  }));

  const world: World = {
    seed,
    scenario,
    baseUrl,
    users,
    you,
    groups,
    projects,
    mergeRequests: [],
    pipelines: [],
    issues: [],
    discussions: [],
    tokens: {
      'glpat-emulator': 'valid',
      'glpat-expired': 'expired',
      'glpat-readonly': 'readOnly',
    },
    rateLimited: scenario === 'rate-limited',
    failures: {},
    counters: { note: 771000, discussion: 0, pipeline: 90400 },
  };

  const addPipeline = (
    projectId: number,
    sha: string,
    ref: string,
    status: EmPipeline['status'],
    daysAgo: number,
  ): EmPipeline => {
    const id = ++world.counters.pipeline;
    const project = projects.find((p) => p.id === projectId) as EmProject;
    const pipeline: EmPipeline = {
      id,
      project_id: projectId,
      sha,
      ref,
      status,
      web_url: `${project.web_url}/-/pipelines/${id}`,
      created_at: isoDaysAgo(daysAgo, 11),
    };
    world.pipelines.push(pipeline);
    return pipeline;
  };

  const addMr = (mr: Omit<EmMergeRequest, 'web_url' | 'approved_by' | 'notes'>): EmMergeRequest => {
    const project = projects.find((p) => p.id === mr.project_id) as EmProject;
    const full: EmMergeRequest = {
      ...mr,
      web_url: `${project.web_url}/-/merge_requests/${mr.iid}`,
      approved_by: [],
      notes: [],
    };
    world.mergeRequests.push(full);
    return full;
  };

  // In the empty-pod scenario the world has projects but nothing open.
  if (scenario === 'empty-pod') {
    return world;
  }

  // --- flagship MR !2841, mirroring the spec fixtures ------------------------
  const flagshipHead = '4f19c2a7b1d3e9f0c5a8b2d4e6f7a9c1b3d5e7f9';
  const flagshipBase = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  addMr({
    project_id: 9101,
    iid: 2841,
    title: 'Refactor token refresh',
    description: 'Part-of: #1180\n\nMoves refresh into TokenStore and adds the retry envelope.',
    state: 'opened',
    source_branch: 'feat/auth-refresh',
    target_branch: 'main',
    author: you,
    reviewers: [users[3] as EmUser],
    updated_at: isoDaysAgo(2),
    base_sha: flagshipBase,
    start_sha: flagshipBase,
    head_sha: flagshipHead,
    files: [
      { old_path: 'src/auth/token.ts', new_path: 'src/auth/token.ts', diff: TOKEN_TS_DIFF },
      {
        old_path: 'test/auth.spec.ts',
        new_path: 'test/auth.spec.ts',
        diff: "@@ -10,4 +10,6 @@\n describe('token', () => { /* happy path only */ })\n+  it.todo('401 -> refresh path')\n",
      },
      ...FILE_STEMS.slice(0, 3).map((stem) => ({
        old_path: `src/${stem}.ts`,
        new_path: `src/${stem}.ts`,
        diff: makeDiff(rng, stem),
      })),
    ],
  });
  addPipeline(9101, flagshipHead, 'feat/auth-refresh', 'success', 2);

  // --- the changeset: 4 MRs across projects, Part-of: #1180 ------------------
  const changesetMembers: Array<[number, number, string, EmUser, string]> = [
    [9102, 812, 'Rotate signing keys on schedule', users[1] as EmUser, 'declares the new TTL and key ids'],
    [9103, 381, 'Propagate rotated key ids', users[2] as EmUser, 'renames the response field'],
    [9210, 1509, 'Show key expiry banner', users[1] as EmUser, 'reads the renamed field'],
  ];
  for (const [projectId, iid, title, author, note] of changesetMembers) {
    const head = rng.hex(40);
    const base = rng.hex(40);
    addMr({
      project_id: projectId,
      iid,
      title,
      description: `Part-of: #1180\n\n${note}.`,
      state: 'opened',
      source_branch: 'feat/key-rotation',
      target_branch: 'main',
      author,
      reviewers: [you],
      updated_at: isoDaysAgo(rng.int(1, 4)),
      base_sha: base,
      start_sha: base,
      head_sha: head,
      files: FILE_STEMS.slice(0, rng.int(2, 4)).map((stem) => ({
        old_path: `src/${stem}.ts`,
        new_path: `src/${stem}.ts`,
        diff: makeDiff(rng, stem),
      })),
    });
    addPipeline(
      projectId,
      head,
      'feat/key-rotation',
      projectId === 9103 ? 'failed' : rng.chance(0.7) ? 'success' : 'running',
      rng.int(1, 3),
    );
  }

  // --- !2833: a review you already submitted — one thread per status ---------
  const submittedHead = rng.hex(40);
  const submittedBase = rng.hex(40);
  addMr({
    project_id: 9101,
    iid: 2833,
    title: 'Gate debug banner on environment',
    description: 'Removes the query-param backdoor.',
    state: 'opened',
    source_branch: 'fix/debug-banner',
    target_branch: 'main',
    author: users[1] as EmUser,
    reviewers: [you],
    updated_at: isoDaysAgo(1),
    base_sha: submittedBase,
    start_sha: submittedBase,
    head_sha: submittedHead,
    files: [
      { old_path: 'src/ui/banner.ts', new_path: 'src/ui/banner.ts', diff: makeDiff(rng, 'ui/banner') },
    ],
  });
  addPipeline(9101, submittedHead, 'fix/debug-banner', 'success', 1);

  const position = (line: number): EmPosition => ({
    position_type: 'text',
    base_sha: submittedBase,
    start_sha: submittedBase,
    head_sha: submittedHead,
    old_path: 'src/ui/banner.ts',
    new_path: 'src/ui/banner.ts',
    new_line: line,
  });
  const threadSeed: Array<{ status: string; notes: EmNote[] }> = [
    {
      status: 'awaiting',
      notes: [
        {
          id: ++world.counters.note,
          author: you,
          body: 'Banner text is user-controlled — escape it before render.',
          created_at: isoDaysAgo(1, 10),
          resolvable: true,
          resolved: false,
          position: position(14),
        },
      ],
    },
    {
      status: 'replied',
      notes: [
        {
          id: ++world.counters.note,
          author: you,
          body: 'Gate the banner on NODE_ENV, not a query param.',
          created_at: isoDaysAgo(1, 10),
          resolvable: true,
          resolved: false,
          position: position(31),
        },
        {
          id: ++world.counters.note,
          author: users[1] as EmUser,
          body: 'The param is handy for support sessions — can we keep it behind a role check instead?',
          created_at: isoDaysAgo(0, 8),
          resolvable: true,
          resolved: false,
        },
      ],
    },
    {
      status: 'resolved',
      notes: [
        {
          id: ++world.counters.note,
          author: you,
          body: 'Cache the environment lookup — it runs per render.',
          created_at: isoDaysAgo(1, 10),
          resolvable: true,
          resolved: true,
          resolved_by: users[1] as EmUser,
          resolved_at: isoDaysAgo(0, 12),
          position: position(52),
        },
      ],
    },
    {
      status: 'stale',
      notes: [
        {
          id: ++world.counters.note,
          author: you,
          body: 'This branch still logs the session id.',
          created_at: isoDaysAgo(1, 10),
          resolvable: true,
          resolved: false,
          position: null,
        },
      ],
    },
  ];
  for (const t of threadSeed) {
    world.discussions.push({
      id: `em${(++world.counters.discussion).toString().padStart(4, '0')}${rng.hex(24)}`,
      project_id: 9101,
      mr_iid: 2833,
      individual_note: false,
      notes: t.notes,
    });
  }

  // --- procedural filler: MRs, issues, pipelines ------------------------------
  let fillerIid = 100;
  for (const project of projects) {
    const fillerCount = project.id === 9104 || project.id === 9105 ? 0 : rng.int(1, 3);
    for (let i = 0; i < fillerCount; i++) {
      const author = rng.pick(others);
      const head = rng.hex(40);
      const base = rng.hex(40);
      const branch = `${rng.pick(BRANCH_WORDS)}/${rng.pick(FILE_STEMS).split('/')[1]}-${rng.int(2, 99)}`;
      addMr({
        project_id: project.id,
        iid: ++fillerIid,
        title: rng.pick(MR_TITLES),
        description: 'Filler change for emulator testing.',
        state: 'opened',
        source_branch: branch,
        target_branch: 'main',
        author,
        reviewers: rng.chance(0.5) ? [you] : [],
        updated_at: isoDaysAgo(rng.int(0, 9)),
        base_sha: base,
        start_sha: base,
        head_sha: head,
        files: FILE_STEMS.slice(0, rng.int(1, 4)).map((stem) => ({
          old_path: `src/${stem}.ts`,
          new_path: `src/${stem}.ts`,
          diff: makeDiff(rng, stem),
        })),
      });
      addPipeline(
        project.id,
        head,
        branch,
        rng.pick(['success', 'failed', 'running', 'success', 'success'] as const),
        rng.int(0, 5),
      );
    }

    const issueCount = rng.int(0, 2);
    for (let i = 0; i < issueCount; i++) {
      world.issues.push({
        id: 50000 + world.issues.length,
        iid: 1100 + world.issues.length,
        project_id: project.id,
        title: rng.pick(ISSUE_TITLES),
        state: 'opened',
        assignees: rng.chance(0.7) ? [rng.pick(users)] : [],
        milestone: rng.chance(0.5) ? { title: '26.08' } : null,
        updated_at: isoDaysAgo(rng.int(0, 12)),
        web_url: `${project.web_url}/-/issues/${1100 + world.issues.length}`,
      });
    }
  }

  // The changeset's linked issue always exists.
  world.issues.push({
    id: 49999,
    iid: 1180,
    project_id: 9102,
    title: 'Key rotation, end to end',
    state: 'opened',
    assignees: [users[1] as EmUser],
    milestone: { title: '26.08' },
    updated_at: isoDaysAgo(6),
    web_url: `${baseUrl}/hve/platform/auth-service/-/issues/1180`,
  });

  if (scenario === 'stale-anchor') {
    // Submits always hit the mid-triage-push branch. (For the realistic
    // read-then-move flow, use the /_emulator push control instead.)
    for (const mr of world.mergeRequests) {
      mr.anchors_invalid = true;
    }
  }

  return world;
}
