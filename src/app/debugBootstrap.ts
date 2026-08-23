/**
 * Debug-only bootstrap: when the launch config sets the auth-bypass env
 * vars (see `src/debugAuth.ts`), pre-seed everything onboarding would
 * produce — token in the secret store, a pod pointing at the emulator —
 * so an F5 session lands straight on populated screens.
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

  const existing = podStore.findByInstance(bypass.providerId, bypass.instanceUrl);
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
