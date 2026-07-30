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

export function listProviders(): ScmProvider[] {
  return [...providers.values()];
}

/** Test hook — the registry is module-global state. */
export function clearProviders(): void {
  providers.clear();
}
