/**
 * The GitLab provider driven end-to-end against the emulator — the same
 * engine `npm run emulator` serves over HTTP, consumed in-process. The
 * contract suite passing here is the emulator's fidelity gate.
 */
import { describe, expect, it } from 'vitest';
import { GitLabEmulator } from '../../../emulator/engine';
import { emulatorFetch } from '../../../emulator/fetch';
import { describeProviderContract } from '../../platform/contract/providerContract';
import { isScmError } from '../../platform/errors';
import { createGitLabProvider } from './gitlabProvider';

const CONFIG = { instanceUrl: 'https://gitlab.emulator.local', token: 'glpat-emulator' };

function connect(emulator: GitLabEmulator, token = CONFIG.token) {
  return createGitLabProvider(emulatorFetch(emulator)).connect({ ...CONFIG, token });
}

describeProviderContract('gitlab provider against the emulator', {
  capabilities: createGitLabProvider().capabilities,
  makeConnection: () => connect(new GitLabEmulator({ seed: 1 })),
  makeFailingConnection: () => {
    const emulator = new GitLabEmulator({ seed: 1 });
    emulator.world.failures = { discussionPostFailAt: 2, discussionPostFailStatus: 400 };
    return connect(emulator);
  },
  inputs: {
    repository: 'https://gitlab.com/hve/platform/core',
    group: 'group 4821',
    notVisible: '7777',
    noMatch: 'this is not a source',
  },
  expected: {
    repoId: '9101',
    repoPath: 'hve/platform/core',
    groupId: '4821',
  },
  crRef: { repoId: '9101', number: '2833' },
  anchor: { filePath: 'src/ui/banner.ts', line: 14 },
});

describe('end-to-end flows against the emulator', () => {
  it('runs the whole submit pipeline: diff → comments with suggestion → summary → request changes', async () => {
    const emulator = new GitLabEmulator({ seed: 3 });
    const conn = connect(emulator);
    const ref = { repoId: '9101', number: '2841' };

    const diff = await conn.getChangeRequestDiff(ref);
    expect(diff.files.map((f) => f.newPath)).toContain('src/auth/token.ts');

    const result = await conn.submitReview(ref, {
      comments: [
        {
          key: 'itm_1',
          body: '**Refresh token logged in error path** · blocker · security',
          anchor: { filePath: 'src/auth/token.ts', line: 63, refs: diff.anchorRefs },
          suggestion: { old: 'logger.error(`refresh failed ${this.refreshToken}`)', new: "logger.error('refresh failed')" },
          footer: '<sub>via Code Verdict</sub>',
        },
        {
          key: 'itm_2',
          body: 'Race on concurrent refresh calls.',
          anchor: { filePath: 'src/auth/token.ts', line: 88, refs: diff.anchorRefs },
        },
      ],
      summary: 'Reviewed with the emulator.',
      requestChanges: true,
    });

    expect(result.comments.every((c) => c.ok)).toBe(true);
    expect(result.summaryPosted).toBe(true);
    expect(result.requestChangesApplied).toBe(true);

    // Observable server state: threads listable, suggestion block rendered,
    // summary note and reviewer state recorded.
    const threads = await conn.listThreads(ref);
    expect(threads).toHaveLength(2);
    const withSuggestion = threads.find((t) => t.notes[0]?.body.includes('```suggestion:-0+0'));
    expect(withSuggestion).toBeDefined();
    const mr = emulator.world.mergeRequests.find((m) => m.iid === 2841);
    expect(mr?.notes.map((n) => n.body)).toContain('Reviewed with the emulator.');
    expect(mr?.reviewer_state).toBe('requested_changes');

    const threadId = threads[0]?.id as string;
    await conn.resolveThread(ref, threadId, true);
    const resolved = (await conn.listThreads(ref)).find((t) => t.id === threadId);
    expect(resolved?.resolved).toBe(true);
  });

  it('turns a mid-triage push into per-comment staleAnchor outcomes', async () => {
    const emulator = new GitLabEmulator({ seed: 4 });
    const conn = connect(emulator);
    const ref = { repoId: '9101', number: '2841' };

    const diff = await conn.getChangeRequestDiff(ref);
    emulator.handle({
      method: 'POST',
      url: '/_emulator/mrs/9101/2841/push',
      headers: {},
      body: '{}',
    });

    const result = await conn.submitReview(ref, {
      comments: [
        { key: 'a', body: 'x', anchor: { filePath: 'src/auth/token.ts', line: 63, refs: diff.anchorRefs } },
      ],
      summary: 'never posted',
    });
    expect(result.comments[0]?.ok).toBe(false);
    expect(result.comments[0]?.error?.kind).toBe('staleAnchor');
    expect(result.summaryPosted).toBe(false);
  });

  it('surfaces force-pushed threads as dropped anchors', async () => {
    const emulator = new GitLabEmulator({ seed: 5 });
    const conn = connect(emulator);
    emulator.handle({
      method: 'POST',
      url: '/_emulator/mrs/9101/2833/push',
      headers: {},
      body: '{"force": true}',
    });
    const threads = await conn.listThreads({ repoId: '9101', number: '2833' });
    expect(threads.length).toBeGreaterThan(0);
    expect(threads.every((t) => !t.anchorPresent)).toBe(true);
  });

  it('maps the emulator token states onto the error taxonomy', async () => {
    const expired = await connect(new GitLabEmulator(), 'glpat-expired').testConnection();
    expect(expired.ok).toBe(false);
    expect(expired.error?.kind).toBe('auth');

    const readonly = connect(new GitLabEmulator(), 'glpat-readonly');
    const status = await readonly.testConnection();
    expect(status.ok).toBe(true);
    expect(status.scopes).toEqual(['read_user']);
    await expect(readonly.approve({ repoId: '9101', number: '2841' })).rejects.toMatchObject({
      kind: 'insufficientScope',
    });

    const limited = connect(new GitLabEmulator({ scenario: 'rate-limited' }));
    try {
      await limited.listOpenChangeRequests(['9101']);
      expect.unreachable('rate limit should throw');
    } catch (e) {
      expect(isScmError(e) && e.kind === 'rateLimited').toBe(true);
      expect(isScmError(e) ? e.retryAfterSeconds : undefined).toBe(38);
    }
  });
});
