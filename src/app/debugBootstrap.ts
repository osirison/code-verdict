/**
 * Debug-only bootstrap: when the launch config sets the auth-bypass env
 * vars (see `src/debugAuth.ts`), pre-seed everything onboarding would
 * produce — token in the secret store, a pod pointing at the emulator.
 * The first F5 on a fresh profile still needs "Verdict: sign in" -> the
 * debug option once; after that, activation reconnects on its own because
 * the emulator pod is now the selected pod.
 *
 * This is the app-layer home of the bypass: providers stay config-driven
 * and never read the environment.
 */
import type { DebugAuthBypass } from '../debugAuth';
import { getProvider } from '../platform/registry';
import type { Repository } from '../platform/types';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Pod, PodSource } from '../domain/types';
import type { PodStore } from './pods';
import type { SecretStore } from './storage';
import { tokenSecretKey } from './storage';

const DEFAULT_SOURCES = 'group 4821, 9210';
const DEBUG_POD_ID = 'pod_debug_emulator';

// Shared by isDebugBootstrapPodActive and runDebugBootstrap's reuse branch:
// keyed by provider+instance, not by DEBUG_POD_ID — a pod seeded any other
// way at the same instance still counts, whatever else sits beside it in the
// pod list.
function matchesBypass(pod: Pod | undefined, bypass: DebugAuthBypass): boolean {
  return pod?.providerId === bypass.providerId && pod?.instanceUrl === bypass.instanceUrl;
}

// Gates the activation-time reconnect (see extension.ts): only fire when the
// selected pod itself points at the emulator. Plain "Run Extension" with no
// emulator started must never touch the network on F5.
export function isDebugBootstrapPodActive(bypass: DebugAuthBypass, podStore: PodStore): boolean {
  return matchesBypass(podStore.activePod, bypass);
}

export async function runDebugBootstrap(
  bypass: DebugAuthBypass,
  podStore: PodStore,
  secrets: SecretStore,
  env: Record<string, string | undefined> = process.env,
): Promise<Pod> {
  await secrets.store(tokenSecretKey(bypass.providerId, bypass.instanceUrl), bypass.token);

  const provider = getProvider(bypass.providerId);
  const connection = provider.connect({
    instanceUrl: bypass.instanceUrl,
    credential: { kind: 'token', token: bypass.token },
  });

  // Always verify connectivity — a reused pod against a dead emulator must
  // fail loudly here, not toast "connected" and break on the first query.
  const status = await connection.testConnection();
  if (!status.ok) {
    throw new Error(
      `Debug bootstrap could not connect to ${bypass.instanceUrl}: ${status.error?.message ?? 'unknown error'}. Is the emulator running (npm run emulator)?`,
    );
  }

  // Onboarding assigns pods random ids and never dedupes by instance, so two
  // pods can share this provider+instanceUrl. Reuse the one already selected
  // when it's one of them — findByInstance's first match is otherwise
  // whichever pod happened to be created first, and switching to it would
  // hijack the selection exactly like the bug this file already fixes once.
  const active = podStore.activePod;
  const existing = matchesBypass(active, bypass)
    ? active
    : podStore.findByInstance(bypass.providerId, bypass.instanceUrl);
  if (existing) {
    await podStore.setActive(existing.id);
    return existing;
  }

  const sources: PodSource[] = [];
  const repos: Repository[] = [];
  const inputs = (env.CODE_VERDICT_DEBUG_SOURCES ?? DEFAULT_SOURCES)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const input of inputs) {
    const resolved = await connection.resolveSource(input);
    if (resolved.kind === 'repository') {
      sources.push({ kind: 'repository', repoId: resolved.repo.id });
      repos.push(resolved.repo);
    } else if (resolved.kind === 'group') {
      sources.push({
        kind: 'group',
        groupId: resolved.group.id,
        repoIds: resolved.repositories.map((r) => r.id),
      });
      repos.push(...resolved.repositories);
    }
    // notVisible / noMatch inputs are skipped — never silently added.
  }
  if (sources.length === 0) {
    throw new Error(`Debug bootstrap resolved no sources from "${inputs.join(', ')}"`);
  }

  const pod: Pod = {
    id: DEBUG_POD_ID,
    name: 'Emulator pod',
    providerId: bypass.providerId,
    instanceUrl: bypass.instanceUrl,
    sources,
    criteria: { ...DEFAULT_CRITERIA, categories: [...DEFAULT_CRITERIA.categories] },
    agentId: '',
    repos: repos.map((r) => ({ id: r.id, path: r.path, name: r.name })),
    username: status.username,
  };
  await podStore.upsert(pod);
  await podStore.setActive(pod.id);
  return pod;
}
