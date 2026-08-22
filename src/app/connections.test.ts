/**
 * Credential selection and the unregistered-provider case — the two spec
 * scenarios that live in the app layer rather than in a provider.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { connectionForPod, setSessionProvider, sessionAvailableFor } from './connections';
import { clearProviders, registerProvider } from '../platform/registry';
import { registerBuiltInProviders } from '../registry';
import { legacyTokenSecretKey, tokenSecretKey, type SecretStore } from './storage';
import type { Pod } from '../domain/types';

function secretsWith(entries: Record<string, string> = {}): SecretStore & { seen: Map<string, string> } {
  const seen = new Map(Object.entries(entries));
  return {
    seen,
    get: (key: string) => Promise.resolve(seen.get(key)),
    store: (key: string, value: string) => {
      seen.set(key, value);
      return Promise.resolve();
    },
  };
}

function pod(providerId: string, instanceUrl: string): Pod {
  return {
    id: 'p1',
    name: 'Pod',
    providerId,
    instanceUrl,
    sources: [],
    criteria: { severityFloor: 'minor', minConfidence: 70, categories: [], extraInstructions: '' },
    agentId: '',
  };
}

afterEach(() => {
  setSessionProvider(undefined);
  clearProviders();
});

describe('an unregistered provider is reported, not guessed', () => {
  it('refuses to connect a pod whose provider this build does not have', async () => {
    registerBuiltInProviders();
    await expect(connectionForPod(pod('bitbucket', 'https://bitbucket.org'), secretsWith()))
      .rejects.toMatchObject({ kind: 'notFound' });
  });
});

describe('credential selection follows the modes the provider declares', () => {
  it('prefers the editor session on a host that offers one, storing no secret', async () => {
    registerBuiltInProviders();
    const calls: string[] = [];
    setSessionProvider((providerId) => {
      calls.push(providerId);
      return Promise.resolve('gho_session_token');
    });
    const secrets = secretsWith();
    await expect(connectionForPod(pod('github', 'https://github.com'), secrets)).resolves.toBeDefined();
    expect(calls).toEqual(['github']);
    // A session pod stores nothing: the session is re-acquired at use time.
    expect(secrets.seen.size).toBe(0);
  });

  it('falls through to the stored token when no session is available', async () => {
    registerBuiltInProviders();
    setSessionProvider(() => Promise.resolve(undefined));
    const secrets = secretsWith({
      [tokenSecretKey('github', 'https://github.com')]: 'ghp_stored',
    });
    await expect(connectionForPod(pod('github', 'https://github.com'), secrets)).resolves.toBeDefined();
  });

  it('uses the token path on an enterprise host, which declares no session', async () => {
    registerBuiltInProviders();
    setSessionProvider(() => Promise.resolve('never-used'));
    expect(sessionAvailableFor('github', 'https://ghe.example.test')).toBe(false);
    expect(sessionAvailableFor('github', 'https://github.com')).toBe(true);

    const secrets = secretsWith({
      [tokenSecretKey('github', 'https://ghe.example.test')]: 'ghp_ghes',
    });
    await expect(connectionForPod(pod('github', 'https://ghe.example.test'), secrets)).resolves.toBeDefined();
  });

  it('errors when a token pod has no stored credential at all', async () => {
    registerBuiltInProviders();
    await expect(connectionForPod(pod('gitlab', 'https://gitlab.com'), secretsWith()))
      .rejects.toMatchObject({ kind: 'auth' });
  });

  it('migrates a legacy instance-only secret rather than signing the pod out', async () => {
    registerBuiltInProviders();
    const secrets = secretsWith({
      [legacyTokenSecretKey('https://gitlab.com')]: 'glpat_old',
    });
    await expect(connectionForPod(pod('gitlab', 'https://gitlab.com'), secrets)).resolves.toBeDefined();
    expect(secrets.seen.get(tokenSecretKey('gitlab', 'https://gitlab.com'))).toBe('glpat_old');
  });

  it('needs no credential for a demo provider', async () => {
    registerBuiltInProviders();
    await expect(connectionForPod(pod('fixture', 'https://demo.invalid'), secretsWith())).resolves.toBeDefined();
  });

  it('reports no session available when nothing is wired, even for github.com', () => {
    registerBuiltInProviders();
    expect(sessionAvailableFor('github', 'https://github.com')).toBe(false);
  });
});

describe('registry hygiene', () => {
  it('rejects a duplicate provider id', () => {
    registerBuiltInProviders();
    const clone = { id: 'github' } as never;
    expect(() => registerProvider(clone)).toThrow(/already registered/i);
  });
});
