/**
 * The single place concrete providers are wired into the platform registry.
 * ESLint forbids importing `src/providers/**` anywhere else.
 */
import { registerProvider, listProviders } from './platform/registry';
import { tracedFetch } from './app/apiTrace';
import { fixtureProvider } from './providers/fixture/fixtureProvider';
// vocab-ok: the single wiring point is the one place concrete providers are named
import { createGitHubProvider } from './providers/github/githubProvider';
// vocab-ok: the single wiring point is the one place concrete providers are named
import { createGitLabProvider } from './providers/gitlab/gitlabProvider';

export function registerBuiltInProviders(): void {
  // Built from the factories rather than taken as the modules' pre-built
  // singletons so every platform call goes through the traced fetch seam. One
  // wrapper serves both: tracing decorates fetch, so a provider is traced
  // without knowing tracing exists, and the next provider is traced for free.
  // The fixture provider makes no HTTP calls and has nothing to trace.
  const traced = tracedFetch(fetch);
  for (const provider of [createGitLabProvider(traced), createGitHubProvider(traced), fixtureProvider]) {
    if (!listProviders().some((p) => p.id === provider.id)) {
      registerProvider(provider);
    }
  }
}
