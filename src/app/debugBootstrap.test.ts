/**
 * The F5 path, end to end and over real HTTP: emulator server → debug
 * bootstrap (token + pod seeding) → pod query → rendered dashboard HTML.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitLabEmulator } from '../../emulator/engine';
import { registerBuiltInProviders } from '../registry';
import { renderDashboardHtml } from '../ui/dashboardHtml';
import { toViewState } from '../ui/dashboardState';
import { renderSidebarHtml } from '../ui/sidebarHtml';
import { toSidebarViewState } from '../ui/sidebarState';
import { parseAgentReviewResponse } from '../domain/agentResponse';
import { connectionForPod } from './connections';
import { fetchPodData, repoIdsOf, repoLabel } from './podQuery';
import { PodStore } from './pods';
import type { KeyValueStore, SecretStore } from './storage';
import { runDebugBootstrap } from './debugBootstrap';
import { runDemoAgent } from './demoAgent';
import { BUILTIN_AGENT_DESCRIPTOR } from './agents';
import { composeCommentDrafts, composeSummaryBody, performSubmit } from './submit';
import { composeSummary } from '../domain/summary';
import { addedLines } from '../domain/diffHunks';
import { allDecided, createReview, setVerdict } from '../domain/reviewState';

function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    update: async (key, value) => {
      map.set(key, value);
    },
  };
}

function memorySecrets(): SecretStore & { dump(): Map<string, string> } {
  const map = new Map<string, string>();
  return {
    dump: () => map,
    get: async (key) => map.get(key),
    store: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
  };
}

let server: http.Server;
let baseUrl: string;

interface EmulatorState {
  requestLog: string[];
  mergeRequests: Array<{ ref: string; notes: number }>;
}

async function readEmulatorState(): Promise<EmulatorState> {
  const response = await fetch(`${baseUrl}/_emulator/state`);
  if (!response.ok) throw new Error(`emulator state returned ${response.status}`);
  return response.json() as Promise<EmulatorState>;
}

beforeAll(async () => {
  registerBuiltInProviders();
  const emulator = new GitLabEmulator({ seed: 1 });
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      const result = emulator.handle({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers,
        body: chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined,
      });
      res.writeHead(result.status, result.headers);
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

describe('debug bootstrap against a live emulator', () => {
  it('seeds the token and a pod, then the pod query fills a dashboard', async () => {
    const podStore = new PodStore(memoryStore());
    const secrets = memorySecrets();

    const pod = await runDebugBootstrap(
      { enabled: true,
    providerId: 'gitlab', instanceUrl: baseUrl, token: 'glpat-emulator', reason: 'override' },
      podStore,
      secrets,
      {},
    );

    expect(pod.username).toBe('you');
    expect(repoIdsOf(pod)).toHaveLength(6);
    expect(pod.repos?.map((r) => r.path)).toContain('hve/platform/core');
    expect([...secrets.dump().values()]).toContain('glpat-emulator');
    expect(podStore.activePod?.id).toBe(pod.id);

    // Re-running is idempotent — the existing pod is reused.
    const again = await runDebugBootstrap(
      { enabled: true,
    providerId: 'gitlab', instanceUrl: baseUrl, token: 'glpat-emulator', reason: 'override' },
      podStore,
      secrets,
      {},
    );
    expect(again.id).toBe(pod.id);
    expect(podStore.list()).toHaveLength(1);

    const connection = await connectionForPod(pod, secrets);
    const data = await fetchPodData(connection, pod, Date.now());
    expect(data.changeRequests.length).toBeGreaterThan(5);

    const flagship = data.changeRequests.find((cr) => cr.ref.number === '2841');
    expect(flagship?.ci?.status).toBe('success');
    expect(repoLabel(pod, flagship?.ref.repoId ?? '')).toBe('core');

    const html = renderDashboardHtml(toViewState(data, Date.now(), new Set()), 'testnonce');
    expect(html).toContain('Refactor token refresh');
    expect(html).toContain('feat/auth-refresh');
    expect(html).toContain('Projects in pod');
    expect(html).toContain('Waiting on you ·');

    const sidebarHtml = renderSidebarHtml(
      toSidebarViewState(data, podStore.list()),
      'testnonce',
    );
    expect(sidebarHtml).toContain('Refactor token refresh');
    expect(sidebarHtml).toContain('Issues · in progress');
    expect(sidebarHtml).toContain('#1180');
  });

  it('drives the whole review loop: demo agent → triage → submit → threads', async () => {
    const podStore = new PodStore(memoryStore());
    const secrets = memorySecrets();
    const pod = await runDebugBootstrap(
      { enabled: true,
    providerId: 'gitlab', instanceUrl: baseUrl, token: 'glpat-emulator', reason: 'override' },
      podStore,
      secrets,
      {},
    );
    const connection = await connectionForPod(pod, secrets);
    const ref = { repoId: '9101', number: '2841' };
    const diff = await connection.getChangeRequestDiff(ref);

    // §5: the agent reads the diff and produces anchored items.
    const { response } = runDemoAgent(diff, pod.criteria);
    expect(response.items.length).toBeGreaterThan(0);

    // §6: triage every item — accept all, applying fixes where offered.
    let review = createReview({
      repoId: ref.repoId,
      crNumber: ref.number,
      agentId: response.agentId,
      criteria: pod.criteria,
      response,
    });
    for (const item of review.items) review = setVerdict(review, item.id, 'accepted', true);
    expect(allDecided(review)).toBe(true);

    // §7: compose and submit through the provider to the live emulator.
    const summary = composeSummary(review, response.agentLabel, 'terse');
    const { drafts, withheld } = composeCommentDrafts(
      review,
      response.agentLabel,
      'you',
      diff.anchorRefs,
      (file) => {
        const changed = diff.files.find((candidate) => candidate.newPath === file);
        return changed ? addedLines(changed.diff) : undefined;
      },
    );
    expect(withheld).toEqual([]);
    const result = await performSubmit(connection, ref, {
      drafts,
      summary,
      requestChanges: true,
      asSingleThread: false,
    });

    expect(result.comments.every((c) => c.ok)).toBe(true);
    expect(result.summaryPosted).toBe(true);
    expect(result.requestChangesApplied).toBe(true);

    // The emulator observed everything: threads exist at the right anchors.
    const threads = await connection.listThreads(ref);
    expect(threads.length).toBe(drafts.length);
    for (const draft of drafts) {
      expect(threads.some((t) => t.filePath === draft.anchor.filePath && t.line === draft.anchor.line)).toBe(true);
    }
  });

  it('submits an accepted attachment finding only in the summary', async () => {
    const podStore = new PodStore(memoryStore());
    const secrets = memorySecrets();
    const pod = await runDebugBootstrap(
      { enabled: true,
    providerId: 'gitlab', instanceUrl: baseUrl, token: 'glpat-emulator', reason: 'override' },
      podStore,
      secrets,
      {},
    );
    const connection = await connectionForPod(pod, secrets);
    const ref = { repoId: '9101', number: '2841' };
    const diff = await connection.getChangeRequestDiff(ref);

    const attachment = {
      id: 'evidence',
      kind: 'file' as const,
      label: 'evidence.md',
      path: 'docs/evidence.md',
      content: '# Evidence\nunsafe_mode=true',
      truncated: false,
      evidence: [{
        path: 'docs/evidence.md', range: { startLine: 1, endLine: 2 }, contentStart: 0, contentEnd: 27,
      }],
    };
    expect(diff.files.map((file) => file.newPath)).not.toContain(attachment.path);

    const { response, rejected } = parseAgentReviewResponse({
      schemaVersion: '1',
      agentId: BUILTIN_AGENT_DESCRIPTOR.id,
      agentLabel: BUILTIN_AGENT_DESCRIPTOR.label,
      headSha: diff.headSha,
      items: [{
        id: 'attachment-finding',
        file: attachment.path,
        line: 2,
        severity: 'major',
        category: 'security',
        confidence: 95,
        title: 'Unsafe mode remains enabled',
        body: 'Disable unsafe mode before deployment.',
        code: 'unsafe_mode=true',
      }],
      candidates: [],
    }, {
      diffPaths: diff.files.map((file) => file.newPath),
      attachmentManifest: [{ path: attachment.path, ranges: [{ startLine: 1, endLine: 2 }] }],
    });
    expect(rejected).toEqual([]);
    expect(response.items[0]?.anchored).toBe(false);

    let review = createReview({
      repoId: ref.repoId,
      crNumber: ref.number,
      agentId: response.agentId,
      criteria: pod.criteria,
      response,
    });
    review = setVerdict(review, 'attachment-finding', 'accepted', false);
    const { drafts, withheld } = composeCommentDrafts(
      review,
      response.agentLabel,
      'you',
      diff.anchorRefs,
      (file) => {
        const changed = diff.files.find((candidate) => candidate.newPath === file);
        return changed ? addedLines(changed.diff) : undefined;
      },
    );
    const summary = composeSummaryBody(
      composeSummary(review, response.agentLabel, 'terse'),
      '',
      review,
      withheld,
    );
    expect(drafts).toEqual([]);
    expect(summary).toContain('## Accepted findings outside the diff');
    expect(summary).toContain('### docs/evidence.md:2 - Unsafe mode remains enabled');

    const threadsBefore = await connection.listThreads(ref);
    const stateBefore = await readEmulatorState();
    const notesBefore = stateBefore.mergeRequests.find((mr) => mr.ref === '9101!2841')?.notes;
    const result = await performSubmit(connection, ref, {
      drafts,
      summary,
      requestChanges: false,
      asSingleThread: false,
    });

    expect(result.comments).toEqual([]);
    expect(result.summaryPosted).toBe(true);
    const threadsAfter = await connection.listThreads(ref);
    expect(threadsAfter.map((thread) => thread.id)).toEqual(threadsBefore.map((thread) => thread.id));
    const stateAfter = await readEmulatorState();
    expect(stateAfter.mergeRequests.find((mr) => mr.ref === '9101!2841')?.notes).toBe((notesBefore ?? 0) + 1);
    const summaryPost = stateAfter.requestLog.lastIndexOf('POST /api/v4/projects/9101/merge_requests/2841/notes');
    expect(summaryPost).toBeGreaterThanOrEqual(0);
    expect(stateAfter.requestLog.slice(summaryPost).some(
      (entry) => entry.startsWith('POST ') && entry.includes('/discussions'),
    )).toBe(false);
  });
});
