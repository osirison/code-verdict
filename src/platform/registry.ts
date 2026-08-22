import type { ScmProvider } from './provider';

const providers = new Map<string, ScmProvider>();

export function registerProvider(provider: ScmProvider): void {
  if (providers.has(provider.id)) {
    throw new Error(`Provider already registered: ${provider.id}`);
  }
  providers.set(provider.id, provider);
}

export function getProvider(id: string): ScmProvider {
  const p = providers.get(id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

/**
 * The registry lookup that does not throw — for chrome that must still render
 * when a stored pod names a provider this build does not have. Feature code
 * uses `getProvider`; error paths use this.
 */
export function tryGetProvider(id: string): ScmProvider | undefined {
  return providers.get(id);
}

export function listProviders(): ScmProvider[] {
  return [...providers.values()];
}

/** Providers a user can actually connect to — demo providers excluded. */
export function listRealProviders(): ScmProvider[] {
  return listProviders().filter((p) => p.demo !== true);
}

/**
 * The provider onboarding starts on: the only real one when there is a single
 * choice, otherwise the first registered. The chooser overrides it.
 */
export function defaultProviderId(): string {
  const first = listRealProviders()[0] ?? listProviders()[0];
  if (!first) throw new Error('No providers registered');
  return first.id;
}

/** Test hook — the registry is module-global state. */
export function clearProviders(): void {
  providers.clear();
}
