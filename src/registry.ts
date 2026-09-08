/**
 * The single place concrete providers are wired into the platform registry.
 * ESLint forbids importing `src/providers/**` anywhere else.
 */
import { registerProvider, listProviders } from './platform/registry';
import { tracedFetch } from './app/apiTrace';
import { fixtureProvider } from './providers/fixture/fixtureProvider';
import { createDemoInvestigationSource } from './providers/fixture/demoInvestigationSource';
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

/**
 * The sample data provider's own id, and the source that serves its
 * investigation — both re-exported through the one module allowed to name
 * `src/providers/**`.
 *
 * A pod on this provider reviews sample data that exists in no repository and
 * on no remote, so there is nothing for the local git source to clone and
 * nothing for source selection to obtain. The host hands the source in instead
 * (`HarnessRuntimeDeps.investigationSource`), for a pod on this provider and no
 * other. They are re-exported rather than imported directly by the host for the
 * same reason the providers are: the ESLint rule that keeps concrete platform
 * code out of feature code has exactly one exemption, and this file is it.
 *
 * The id is read off the provider rather than written down again, so the wiring
 * cannot come to name a provider that no longer answers to it.
 */
export const SAMPLE_DATA_PROVIDER_ID = fixtureProvider.id;

export { createDemoInvestigationSource };
