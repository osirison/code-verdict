import { describe, expect, it } from 'vitest';
import { GitLabEmulator } from './engine';
import type { EmRequest } from './engine';

const AUTH = { authorization: 'Bearer glpat-emulator' };

function get(em: GitLabEmulator, url: string, headers: Record<string, string> = AUTH) {
  return em.handle({ method: 'GET', url, headers });
}

function post(em: GitLabEmulator, url: string, body?: unknown, headers: Record<string, string> = AUTH) {
  const req: EmRequest = {
    method: 'POST',
    url,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  return em.handle(req);
}

describe('world generation', () => {
  it('is deterministic per seed — including timestamps and token expiry', () => {
    const a = new GitLabEmulator({ seed: 7 });
    const b = new GitLabEmulator({ seed: 7 });
    const c = new GitLabEmulator({ seed: 8 });
    const shas = (em: GitLabEmulator) => em.world.mergeRequests.map((m) => m.head_sha);
    expect(shas(a)).toEqual(shas(b));
    expect(shas(a)).not.toEqual(shas(c));

    const stamps = (em: GitLabEmulator) => em.world.mergeRequests.map((m) => m.updated_at);
    expect(stamps(a)).toEqual(stamps(b));
    expect(get(a, '/api/v4/personal_access_tokens/self').body).toEqual(
      get(b, '/api/v4/personal_access_tokens/self').body,
    );

    // The live server anchors to the wall clock instead — same content,
    // shifted timestamps.
    const fresh = new GitLabEmulator({ seed: 7, now: '2027-01-01T09:00:00.000Z' });
    expect(shas(fresh)).toEqual(shas(a));
    expect(stamps(fresh)).not.toEqual(stamps(a));
  });

  it('covers the spec surfaces: flagship MR, changeset trailer, every thread status, empty projects', () => {
    const em = new GitLabEmulator({ seed: 1 });
    const w = em.world;
    expect(w.mergeRequests.find((m) => m.iid === 2841)?.files[0]?.new_path).toBe('src/auth/token.ts');
    const trailered = w.mergeRequests.filter((m) => m.description.includes('Part-of: #1180'));
    expect(trailered.length).toBeGreaterThanOrEqual(4);
    const statuses = w.discussions
      .filter((d) => d.mr_iid === 2833)
      .map((d) => {
        const notes = d.notes;
        if (notes.some((n) => n.position === null)) return 'stale';
        if (notes.every((n) => !n.resolvable || n.resolved)) return 'resolved';
        return notes[notes.length - 1]?.author.username === 'you' ? 'awaiting' : 'replied';
      });
    expect(new Set(statuses)).toEqual(new Set(['awaiting', 'replied', 'resolved', 'stale']));
    const openByProject = (id: number) => w.mergeRequests.filter((m) => m.project_id === id).length;
    expect(openByProject(9104)).toBe(0);
    expect(openByProject(9105)).toBe(0);
  });
});

describe('auth and scenarios', () => {
  it('branches per token: missing 401, expired 401, read-only 403 on writes only', () => {
    const em = new GitLabEmulator();
    expect(get(em, '/api/v4/user', {}).status).toBe(401);
    expect(get(em, '/api/v4/user', { authorization: 'Bearer glpat-expired' }).status).toBe(401);
    const ro = { 'private-token': 'glpat-readonly' };
    expect(get(em, '/api/v4/user', ro).status).toBe(200);
    expect(post(em, '/api/v4/projects/9101/merge_requests/2841/approve', undefined, ro).status).toBe(403);
    const scopes = get(em, '/api/v4/personal_access_tokens/self', ro);
    expect((scopes.body as { scopes: string[] }).scopes).toEqual(['read_user']);
  });

  it('rate-limited scenario answers 429 with Retry-After', () => {
    const em = new GitLabEmulator({ scenario: 'rate-limited' });
    const res = get(em, '/api/v4/user');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('38');
  });
});

describe('REST fidelity', () => {
  it('paginates with x-next-page', () => {
    const em = new GitLabEmulator();
    const page1 = get(em, '/api/v4/groups/4821/projects?per_page=2&page=1');
    expect((page1.body as unknown[]).length).toBe(2);
    expect(page1.headers['x-next-page']).toBe('2');
    const page3 = get(em, '/api/v4/groups/4821/projects?per_page=2&page=3');
    expect((page3.body as unknown[]).length).toBe(1);
    expect(page3.headers['x-next-page']).toBe('');
  });

  it('resolves %2F-encoded project paths', () => {
    const em = new GitLabEmulator();
    const res = get(em, '/api/v4/projects/hve%2Fplatform%2Fcore');
    expect(res.status).toBe(200);
    expect((res.body as { id: number }).id).toBe(9101);
  });

  it('serves the honest list shape and the rich single shape', () => {
    const em = new GitLabEmulator();
    const list = get(em, '/api/v4/projects/9101/merge_requests?state=opened&per_page=100');
    const flagship = (list.body as Array<Record<string, unknown>>).find((m) => m.iid === 2841);
    expect(flagship).toBeDefined();
    expect(flagship).not.toHaveProperty('head_pipeline');
    expect(flagship).not.toHaveProperty('changes_count');
    expect(flagship).not.toHaveProperty('diff_refs');

    const single = get(em, '/api/v4/projects/9101/merge_requests/2841');
    const body = single.body as Record<string, unknown>;
    expect(body.changes_count).toBe('5');
    expect(body.diff_refs).toBeDefined();
    expect(body.head_pipeline).toMatchObject({ status: 'success' });
  });

  it('validates discussion positions against the current head', () => {
    const em = new GitLabEmulator();
    const mr = em.world.mergeRequests.find((m) => m.iid === 2841);
    const position = (headSha: string) => ({
      body: 'Emulator test comment',
      position: {
        position_type: 'text',
        base_sha: mr?.base_sha,
        start_sha: mr?.start_sha,
        head_sha: headSha,
        old_path: 'src/auth/token.ts',
        new_path: 'src/auth/token.ts',
        new_line: 63,
      },
    });

    const stale = post(em, '/api/v4/projects/9101/merge_requests/2841/discussions', position('f'.repeat(40)));
    expect(stale.status).toBe(400);
    expect((stale.body as { message: string }).message).toContain('Note position is invalid');

    const ok = post(em, '/api/v4/projects/9101/merge_requests/2841/discussions', position(mr?.head_sha as string));
    expect(ok.status).toBe(201);
    const listed = get(em, '/api/v4/projects/9101/merge_requests/2841/discussions?per_page=100');
    expect((listed.body as unknown[]).length).toBe(1);
  });
});

describe('control plane', () => {
  it('push moves the head; force-push drops posted anchors', () => {
    const em = new GitLabEmulator();
    const before = em.world.mergeRequests.find((m) => m.iid === 2833)?.head_sha;
    post(em, '/_emulator/mrs/9101/2833/push', {}, {});
    const after = em.world.mergeRequests.find((m) => m.iid === 2833)?.head_sha;
    expect(after).not.toBe(before);

    post(em, '/_emulator/mrs/9101/2833/push', { force: true }, {});
    const positions = em.world.discussions
      .filter((d) => d.mr_iid === 2833)
      .flatMap((d) => d.notes)
      .filter((n) => n.position !== undefined)
      .map((n) => n.position);
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.every((p) => p === null)).toBe(true);
  });

  it('reply appends an author note to the newest open thread', () => {
    const em = new GitLabEmulator();
    const res = post(em, '/_emulator/mrs/9101/2833/reply', { body: 'On it.' }, {});
    expect(res.status).toBe(200);
    const { discussionId } = res.body as { discussionId: string };
    const d = em.world.discussions.find((x) => x.id === discussionId);
    const last = d?.notes.at(-1);
    expect(last?.body).toBe('On it.');
    expect(last?.author.username).not.toBe('you');
  });

  it('fail-submit fails exactly the Nth discussion POST with the chosen status', () => {
    const em = new GitLabEmulator();
    post(em, '/_emulator/fail-submit', { failAt: 2, status: 401 }, {});
    const mr = em.world.mergeRequests.find((m) => m.iid === 2841);
    const good = {
      body: 'x',
      position: {
        position_type: 'text',
        base_sha: mr?.base_sha,
        start_sha: mr?.start_sha,
        head_sha: mr?.head_sha,
        old_path: 'src/auth/token.ts',
        new_path: 'src/auth/token.ts',
        new_line: 63,
      },
    };
    expect(post(em, '/api/v4/projects/9101/merge_requests/2841/discussions', good).status).toBe(201);
    expect(post(em, '/api/v4/projects/9101/merge_requests/2841/discussions', good).status).toBe(401);
    expect(post(em, '/api/v4/projects/9101/merge_requests/2841/discussions', good).status).toBe(201);
  });

  it('reset regenerates the world with a new seed or scenario', () => {
    const em = new GitLabEmulator({ seed: 1 });
    const res = post(em, '/_emulator/reset', { scenario: 'empty-pod' }, {});
    expect(res.status).toBe(200);
    expect(em.world.scenario).toBe('empty-pod');
    expect(em.world.mergeRequests).toHaveLength(0);
    expect(post(em, '/_emulator/reset', { scenario: 'nonsense' }, {}).status).toBe(400);
  });
});
