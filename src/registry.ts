/**
 * The single place concrete providers are wired into the platform registry.
 * ESLint forbids importing `src/providers/**` anywhere else.
 */
import { registerProvider, listProviders } from './platform/registry';
import { fixtureProvider } from './providers/fixture/fixtureProvider';
// vocab-ok: the single wiring point is the one place concrete providers are named
import { githubProvider } from './providers/github/githubProvider';
// vocab-ok: the single wiring point is the one place concrete providers are named
import { gitlabProvider } from './providers/gitlab/gitlabProvider';

export function registerBuiltInProviders(): void {
  for (const provider of [gitlabProvider, githubProvider, fixtureProvider]) {
    if (!listProviders().some((p) => p.id === provider.id)) {
      registerProvider(provider);
    }
  }
}
