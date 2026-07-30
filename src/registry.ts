/**
 * The single place concrete providers are wired into the platform registry.
 * ESLint forbids importing `src/providers/**` anywhere else.
 */
import { registerProvider, listProviders } from './platform/registry';
import { fixtureProvider } from './providers/fixture/fixtureProvider';

export function registerBuiltInProviders(): void {
  if (listProviders().some((p) => p.id === fixtureProvider.id)) return;
  registerProvider(fixtureProvider);
}
