/**
 * The emulator core: a stateful request handler implementing the slice of
 * GitLab (REST v4 + the reviewer-state GraphQL mutation) the extension
 * uses, plus a `/_emulator/*` control plane for driving scenarios while
 * debugging. Shared by the HTTP server (`main.ts`) and the in-process
 * fetch adapter (`fetch.ts`).
 */
import type {
  EmDiscussion,
  EmGroup,
  EmMergeRequest,
  EmNote,
  EmPosition,
  EmProject,
  ScenarioName,
  World,
} from './world';
import { SCENARIOS, generateWorld } from './world';

export interface EmRequest {
  method: string;
  /** Full URL or path; only pathname + query are read. */
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface EmResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function json(status: number, body: unknown, headers: Record<string, string> = {}): EmResponse {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body };
}

function message(status: number, text: string): EmResponse {
  return json(status, { message: text });
}

export class GitLabEmulator {
  world: World;
  /** Request log tail, visible via GET /_emulator/state. */
  private readonly log: string[] = [];
  private discussionPosts = 0;

  constructor(
    opts: { seed?: number; scenario?: ScenarioName; baseUrl?: string; now?: string } = {},
  ) {
    this.world = generateWorld(
      opts.seed ?? 1,
      opts.scenario ?? 'happy',
      opts.baseUrl ?? 'https://gitlab.emulator.local',
      opts.now,
    );
  }

  reset(seed?: number, scenario?: ScenarioName): void {
    this.world = generateWorld(
      seed ?? this.world.seed,
      scenario ?? this.world.scenario,
      this.world.baseUrl,
      this.world.now,
    );
    this.discussionPosts = 0;
  }

  handle(req: EmRequest): EmResponse {
    const url = new URL(req.url, 'http://emulator.invalid');
    // Matching happens on the RAW path so that %2F-encoded project paths
    // stay one segment; captured ids are decoded individually.
    const rawPath = url.pathname.replace(/\/+$/, '') || '/';
    this.log.push(`${req.method} ${rawPath}${url.search}`);
    if (this.log.length > 200) this.log.shift();

    if (rawPath === '/_emulator' || rawPath.startsWith('/_emulator/')) {
      return this.control(req.method, rawPath, req.body);
    }

    this.currentToken = this.tokenOf(req);
    const authFailure = this.checkAuth(req);
    if (authFailure) return authFailure;

    if (this.world.rateLimited) {
      return json(429, { message: '429 Too Many Requests' }, { 'retry-after': '38' });
    }

    if (req.method === 'POST' && rawPath === '/api/graphql') {
      return this.graphql(req.body);
    }

    return this.rest(req.method, rawPath, url.searchParams, req.body);
  }

  private currentToken: string | undefined;

  // --- auth ------------------------------------------------------------------

  private tokenOf(req: EmRequest): string | undefined {
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const bearer = headers['authorization']?.match(/^Bearer\s+(.+)$/i)?.[1];
    return bearer ?? headers['private-token'];
  }

  private checkAuth(req: EmRequest): EmResponse | null {
    const token = this.tokenOf(req);
    if (!token) return message(401, '401 Unauthorized');

    const state =
      this.world.tokens[token] ?? (token.startsWith('glpat-') ? 'valid' : undefined);
    if (state === undefined || state === 'expired' || this.world.scenario === 'token-expired') {
      return message(401, '401 Unauthorized');
    }
    const readOnly = state === 'readOnly' || this.world.scenario === 'insufficient-scope';
    if (readOnly && req.method !== 'GET') {
      return message(403, '403 Forbidden — insufficient_scope');
    }
    return null;
  }

  private tokenScopes(): string[] {
    const state = this.world.tokens[this.currentToken ?? ''];
    if (state === 'readOnly' || this.world.scenario === 'insufficient-scope') return ['read_user'];
    return ['api'];
  }

  // --- REST v4 -----------------------------------------------------------------

  private rest(
    method: string,
    rawPath: string,
    query: URLSearchParams,
    body?: string,
  ): EmResponse {
    const w = this.world;
    // Invalid percent-sequences must not throw — a typo'd curl would
    // otherwise kill the whole server. Undecodable ids fail lookup → 404.
    const dec = (s: string | undefined): string => {
      try {
        return decodeURIComponent(s ?? '');
      } catch {
        return s ?? '';
      }
    };

    if (method === 'GET' && rawPath === '/api/v4/user') {
      return json(200, { username: w.you.username, name: w.you.name });
    }
    if (method === 'GET' && rawPath === '/api/v4/personal_access_tokens/self') {
      // Anchored to the world's time base, not the wall clock — same seed,
      // same response.
      const expires = new Date(w.now);
      expires.setUTCDate(expires.getUTCDate() + 42);
      return json(200, {
        scopes: this.tokenScopes(),
        active: true,
        expires_at: expires.toISOString().slice(0, 10),
      });
    }

    let m = rawPath.match(/^\/api\/v4\/groups\/([^/]+)\/projects$/);
    if (method === 'GET' && m) {
      const group = this.findGroup(dec(m[1]));
      if (!group) return message(404, '404 Group Not Found');
      const items = w.projects
        .filter((p) => p.group_id === group.id)
        .map((p) => this.projectJson(p));
      return this.paginated(items, query);
    }

    m = rawPath.match(/^\/api\/v4\/groups\/([^/]+)\/merge_requests$/);
    if (method === 'GET' && m) {
      const group = this.findGroup(dec(m[1]));
      if (!group) return message(404, '404 Group Not Found');
      const memberIds = new Set(w.projects.filter((p) => p.group_id === group.id).map((p) => p.id));
      const items = w.mergeRequests
        .filter((mr) => memberIds.has(mr.project_id) && this.mrMatchesState(mr, query))
        .map((mr) => this.mrListJson(mr));
      return this.paginated(items, query);
    }

    m = rawPath.match(/^\/api\/v4\/groups\/([^/]+)$/);
    if (method === 'GET' && m) {
      const group = this.findGroup(dec(m[1]));
      return group
        ? json(200, { id: group.id, full_path: group.full_path, name: group.name })
        : message(404, '404 Group Not Found');
    }

    // Merge-request subresources go before the plain project routes.
    m = rawPath.match(/^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)(\/.*)?$/);
    if (m) {
      const project = this.findProject(dec(m[1]));
      if (!project) return message(404, '404 Project Not Found');
      const mr = w.mergeRequests.find(
        (x) => x.project_id === project.id && x.iid === Number(m?.[2]),
      );
      if (!mr) return message(404, '404 Merge Request Not Found');
      return this.mrSubresource(method, m[3] ?? '', mr, query, body);
    }

    m = rawPath.match(/^\/api\/v4\/projects\/([^/]+)\/merge_requests$/);
    if (method === 'GET' && m) {
      const project = this.findProject(dec(m[1]));
      if (!project) return message(404, '404 Project Not Found');
      const items = w.mergeRequests
        .filter((mr) => mr.project_id === project.id && this.mrMatchesState(mr, query))
        .map((mr) => this.mrListJson(mr));
      return this.paginated(items, query);
    }

    m = rawPath.match(/^\/api\/v4\/projects\/([^/]+)\/issues$/);
    if (method === 'GET' && m) {
      const project = this.findProject(dec(m[1]));
      if (!project) return message(404, '404 Project Not Found');
      const state = query.get('state');
      const items = w.issues
        .filter((i) => i.project_id === project.id && (!state || i.state === state))
        .map((i) => ({ ...i }));
      return this.paginated(items, query);
    }

    m = rawPath.match(/^\/api\/v4\/projects\/([^/]+)\/pipelines$/);
    if (method === 'GET' && m) {
      const project = this.findProject(dec(m[1]));
      if (!project) return message(404, '404 Project Not Found');
      const items = w.pipelines
        .filter((p) => p.project_id === project.id)
        .sort((a, b) => b.id - a.id)
        .map((p) => ({ ...p }));
      return this.paginated(items, query);
    }

    m = rawPath.match(/^\/api\/v4\/projects\/([^/]+)$/);
    if (method === 'GET' && m) {
      const project = this.findProject(dec(m[1]));
      return project ? json(200, this.projectJson(project)) : message(404, '404 Project Not Found');
    }

    return message(404, `404 Not Found — no emulator route for ${method} ${rawPath}`);
  }

  private mrSubresource(
    method: string,
    sub: string,
    mr: EmMergeRequest,
    query: URLSearchParams,
    body?: string,
  ): EmResponse {
    const w = this.world;

    if (method === 'GET' && sub === '') return json(200, this.mrSingleJson(mr));

    if (method === 'GET' && sub === '/changes') {
      return json(200, {
        ...this.mrSingleJson(mr),
        changes: mr.files.map((f) => ({ ...f })),
      });
    }

    if (method === 'POST' && sub === '/discussions') {
      return this.postDiscussion(mr, body);
    }

    if (method === 'GET' && sub === '/discussions') {
      const items = w.discussions
        .filter((d) => d.project_id === mr.project_id && d.mr_iid === mr.iid)
        .map((d) => this.discussionJson(d));
      return this.paginated(items, query);
    }

    let m = sub.match(/^\/discussions\/([^/]+)\/notes$/);
    if (method === 'POST' && m) {
      const discussion = this.findDiscussion(mr, m[1] as string);
      if (!discussion) return message(404, '404 Discussion Not Found');
      const parsed = this.parseBody(body);
      const note: EmNote = {
        id: ++w.counters.note,
        author: w.you,
        body: String(parsed.body ?? ''),
        created_at: new Date().toISOString(),
        resolvable: true,
        resolved: false,
      };
      discussion.notes.push(note);
      return json(201, { ...note });
    }

    m = sub.match(/^\/discussions\/([^/]+)$/);
    if (method === 'PUT' && m) {
      const discussion = this.findDiscussion(mr, m[1] as string);
      if (!discussion) return message(404, '404 Discussion Not Found');
      const resolved = query.get('resolved') === 'true';
      for (const note of discussion.notes) {
        if (note.resolvable) {
          note.resolved = resolved;
          note.resolved_by = resolved ? w.you : undefined;
          note.resolved_at = resolved ? new Date().toISOString() : undefined;
        }
      }
      return json(200, this.discussionJson(discussion));
    }

    if (method === 'POST' && sub === '/notes') {
      const parsed = this.parseBody(body);
      const note: EmNote = {
        id: ++w.counters.note,
        author: w.you,
        body: String(parsed.body ?? ''),
        created_at: new Date().toISOString(),
      };
      mr.notes.push(note);
      return json(201, { ...note });
    }

    if (method === 'POST' && sub === '/approve') {
      if (!mr.approved_by.includes(w.you.username)) mr.approved_by.push(w.you.username);
      return json(201, { user: { username: w.you.username } });
    }

    return message(404, `404 Not Found — no emulator route for MR subresource ${method} ${sub}`);
  }

  private postDiscussion(mr: EmMergeRequest, body?: string): EmResponse {
    const w = this.world;
    this.discussionPosts += 1;
    if (
      w.failures.discussionPostFailAt !== undefined &&
      this.discussionPosts === w.failures.discussionPostFailAt
    ) {
      const status = w.failures.discussionPostFailStatus ?? 400;
      return status === 400
        ? message(400, '400 (Bad request) "Note position is invalid"')
        : message(status, `${status} injected failure`);
    }

    const parsed = this.parseBody(body);
    const position = parsed.position as EmPosition | undefined;
    if (!position || !position.head_sha) {
      return message(400, '400 (Bad request) "Position is missing"');
    }
    if (mr.anchors_invalid || position.head_sha !== mr.head_sha) {
      // The branch moved since these refs were read — GitLab's exact branch.
      return message(400, '400 (Bad request) "Note position is invalid"');
    }
    if (!this.positionResolves(mr, position)) {
      // Real GitLab also rejects positions that do not land on a line of
      // the MR diff — the anchor-computation bug class spec §14 warns about
      // must fail here too, not only in production.
      return message(400, '400 (Bad request) "Note position is invalid"');
    }

    const discussion: EmDiscussion = {
      id: `em${(++w.counters.discussion).toString().padStart(4, '0')}${mr.head_sha.slice(0, 24)}`,
      project_id: mr.project_id,
      mr_iid: mr.iid,
      individual_note: false,
      notes: [
        {
          id: ++w.counters.note,
          author: w.you,
          body: String(parsed.body ?? ''),
          created_at: new Date().toISOString(),
          resolvable: true,
          resolved: false,
          position: { ...position },
        },
      ],
    };
    w.discussions.push(discussion);
    return json(201, this.discussionJson(discussion));
  }

  // --- GraphQL -----------------------------------------------------------------

  private graphql(body?: string): EmResponse {
    const parsed = this.parseBody(body);
    const queryText = String(parsed.query ?? '');
    const variables = (parsed.variables ?? {}) as Record<string, unknown>;

    if (queryText.includes('mergeRequestUpdateReviewerState')) {
      const project = this.world.projects.find(
        (p) => p.path_with_namespace === String(variables.projectPath ?? ''),
      );
      const mr =
        project &&
        this.world.mergeRequests.find(
          (x) => x.project_id === project.id && String(x.iid) === String(variables.iid ?? ''),
        );
      if (!mr) {
        return json(200, {
          data: { mergeRequestUpdateReviewerState: { errors: ['Merge request not found'] } },
        });
      }
      mr.reviewer_state = 'requested_changes';
      return json(200, { data: { mergeRequestUpdateReviewerState: { errors: [] } } });
    }

    return json(200, { errors: [{ message: 'Unsupported GraphQL operation in emulator' }] });
  }

  // --- control plane -------------------------------------------------------------

  private control(method: string, path: string, body?: string): EmResponse {
    const parsed = this.parseBody(body);

    if (method === 'GET' && path === '/_emulator/state') {
      return json(200, {
        seed: this.world.seed,
        scenario: this.world.scenario,
        rateLimited: this.world.rateLimited,
        failures: this.world.failures,
        projects: this.world.projects.length,
        openMergeRequests: this.world.mergeRequests.filter((m) => m.state === 'opened').length,
        discussions: this.world.discussions.length,
        requestLog: this.log.slice(-25),
        mergeRequests: this.world.mergeRequests.map((mr) => ({
          ref: `${mr.project_id}!${mr.iid}`,
          title: mr.title,
          head_sha: mr.head_sha,
          reviewer_state: mr.reviewer_state,
          approved_by: mr.approved_by,
          notes: mr.notes.length,
        })),
      });
    }

    if (method === 'POST' && path === '/_emulator/reset') {
      const scenario = parsed.scenario as ScenarioName | undefined;
      if (scenario && !SCENARIOS.includes(scenario)) {
        return message(400, `Unknown scenario: ${String(scenario)}. Known: ${SCENARIOS.join(', ')}`);
      }
      this.reset(
        parsed.seed === undefined ? undefined : Number(parsed.seed),
        scenario,
      );
      return json(200, { seed: this.world.seed, scenario: this.world.scenario });
    }

    if (method === 'POST' && path === '/_emulator/rate-limit') {
      this.world.rateLimited = Boolean(parsed.enabled);
      return json(200, { rateLimited: this.world.rateLimited });
    }

    if (method === 'POST' && path === '/_emulator/fail-submit') {
      this.world.failures = {
        discussionPostFailAt: parsed.failAt === undefined ? 1 : Number(parsed.failAt),
        discussionPostFailStatus:
          parsed.status === undefined ? 400 : Number(parsed.status),
      };
      this.discussionPosts = 0;
      return json(200, this.world.failures);
    }

    const m = path.match(/^\/_emulator\/mrs\/(\d+)\/(\d+)\/(push|reply)$/);
    if (method === 'POST' && m) {
      const mr = this.world.mergeRequests.find(
        (x) => x.project_id === Number(m[1]) && x.iid === Number(m[2]),
      );
      if (!mr) return message(404, 'No such merge request');

      if (m[3] === 'push') {
        // New commits: previously read diff_refs stop validating. A force
        // push additionally drops the anchors of posted discussions.
        mr.head_sha = randomSha();
        mr.updated_at = new Date().toISOString();
        if (parsed.force === true) {
          for (const d of this.world.discussions) {
            if (d.project_id === mr.project_id && d.mr_iid === mr.iid) {
              for (const note of d.notes) {
                if (note.position) note.position = null;
              }
            }
          }
        }
        return json(200, { head_sha: mr.head_sha, forced: parsed.force === true });
      }

      // reply: the MR author answers the newest unresolved discussion (or the
      // one named by discussionId).
      const candidates = this.world.discussions.filter(
        (d) => d.project_id === mr.project_id && d.mr_iid === mr.iid,
      );
      const target = parsed.discussionId
        ? candidates.find((d) => d.id === String(parsed.discussionId))
        : [...candidates].reverse().find((d) => !d.notes.some((n) => n.resolved));
      if (!target) return message(404, 'No discussion to reply to');
      target.notes.push({
        id: ++this.world.counters.note,
        author: mr.author.username === this.world.you.username ? { username: 'kai', name: 'Kai Tanaka' } : mr.author,
        body: String(parsed.body ?? 'Pushed a fix — can you re-check?'),
        created_at: new Date().toISOString(),
        resolvable: true,
        resolved: false,
      });
      return json(200, { discussionId: target.id, notes: target.notes.length });
    }

    return message(404, `Unknown control route ${method} ${path}`);
  }

  // --- helpers ---------------------------------------------------------------

  private parseBody(body?: string): Record<string, unknown> {
    if (!body) return {};
    try {
      const parsed = JSON.parse(body) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private findProject(idOrPath: string): EmProject | undefined {
    return this.world.projects.find(
      (p) => String(p.id) === idOrPath || p.path_with_namespace === idOrPath,
    );
  }

  private findGroup(idOrPath: string): EmGroup | undefined {
    return this.world.groups.find(
      (g) => String(g.id) === idOrPath || g.full_path === idOrPath,
    );
  }

  /** Does the position land on a line the MR diff actually contains? */
  private positionResolves(mr: EmMergeRequest, position: EmPosition): boolean {
    const file = mr.files.find(
      (f) => f.new_path === position.new_path || f.old_path === position.old_path,
    );
    if (!file) return false;
    const hunks = [...file.diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(
      (m) => ({
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
      }),
    );
    const newLine = position.new_line;
    if (typeof newLine === 'number') {
      return hunks.some((h) => newLine >= h.newStart && newLine < h.newStart + h.newCount);
    }
    const oldLine = position.old_line;
    if (typeof oldLine === 'number') {
      return hunks.some((h) => oldLine >= h.oldStart && oldLine < h.oldStart + h.oldCount);
    }
    return false;
  }

  private findDiscussion(mr: EmMergeRequest, id: string): EmDiscussion | undefined {
    return this.world.discussions.find(
      (d) => d.project_id === mr.project_id && d.mr_iid === mr.iid && d.id === id,
    );
  }

  private mrMatchesState(mr: EmMergeRequest, query: URLSearchParams): boolean {
    const state = query.get('state');
    return !state || mr.state === state;
  }

  private projectJson(p: EmProject): Record<string, unknown> {
    return {
      id: p.id,
      path_with_namespace: p.path_with_namespace,
      name: p.name,
      web_url: p.web_url,
    };
  }

  private mrCommon(mr: EmMergeRequest): Record<string, unknown> {
    return {
      id: mr.project_id * 1000 + mr.iid,
      iid: mr.iid,
      project_id: mr.project_id,
      title: mr.title,
      description: mr.description,
      state: mr.state,
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
      author: { ...mr.author },
      reviewers: mr.reviewers.map((r) => ({ ...r })),
      web_url: mr.web_url,
      updated_at: mr.updated_at,
      sha: mr.head_sha,
    };
  }

  /** The honest list shape: no head_pipeline / changes_count / diff_refs. */
  private mrListJson(mr: EmMergeRequest): Record<string, unknown> {
    return this.mrCommon(mr);
  }

  private mrSingleJson(mr: EmMergeRequest): Record<string, unknown> {
    const pipeline = this.world.pipelines
      .filter((p) => p.project_id === mr.project_id && p.sha === mr.head_sha)
      .sort((a, b) => b.id - a.id)[0];
    return {
      ...this.mrCommon(mr),
      changes_count: String(mr.files.length),
      diff_refs: { base_sha: mr.base_sha, start_sha: mr.start_sha, head_sha: mr.head_sha },
      head_pipeline: pipeline
        ? { id: pipeline.id, status: pipeline.status, web_url: pipeline.web_url }
        : null,
    };
  }

  private discussionJson(d: EmDiscussion): Record<string, unknown> {
    return {
      id: d.id,
      individual_note: d.individual_note,
      notes: d.notes.map((n) => ({ ...n, position: n.position === null ? null : n.position })),
    };
  }

  private paginated(items: unknown[], query: URLSearchParams): EmResponse {
    const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '20')));
    const page = Math.max(1, Number(query.get('page') ?? '1'));
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {
      'x-total': String(items.length),
      'x-page': String(page),
      'x-per-page': String(perPage),
      'x-total-pages': String(totalPages),
    };
    if (page < totalPages) headers['x-next-page'] = String(page + 1);
    else headers['x-next-page'] = '';
    return json(200, slice, headers);
  }
}

function randomSha(): string {
  let out = '';
  for (let i = 0; i < 40; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}
