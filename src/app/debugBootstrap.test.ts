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
import { connectionForPod } from './connections';
import { fetchPodData, repoIdsOf, repoLabel } from './podQuery';
import { PodStore } from './pods';
import type { KeyValueStore, SecretStore } from './storage';
import { runDebugBootstrap } from './debugBootstrap';
import { runDemoAgent } from './demoAgent';
import { composeCommentDrafts, performSubmit } from './submit';
import { composeSummary } from '../domain/summary';
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
    const drafts = composeCommentDrafts(review, response.agentLabel, 'you', diff.anchorRefs);
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
});
