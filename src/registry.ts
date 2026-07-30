/**
 * The single place concrete providers are wired into the platform registry.
 * ESLint forbids importing `src/providers/**` anywhere else.
 */
import { registerProvider, listProviders } from './platform/registry';
import { fixtureProvider } from './providers/fixture/fixtureProvider';
import { gitlabProvider } from './providers/gitlab/gitlabProvider';

export function registerBuiltInProviders(): void {
  for (const provider of [gitlabProvider, fixtureProvider]) {
    if (!listProviders().some((p) => p.id === provider.id)) {
      registerProvider(provider);
    }
  }
}
