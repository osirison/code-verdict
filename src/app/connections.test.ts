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
import { clearRegisteredSecretValues, redactSecrets } from './harnessActivitySanitizer';

function secretsWith(entries: Record<string, string> = {}): SecretStore & { seen: Map<string, string> } {
  const seen = new Map(Object.entries(entries));
  return {
    seen,
    get: (key: string) => Promise.resolve(seen.get(key)),
    store: (key: string, value: string) => {
      seen.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      seen.delete(key);
      return Promise.resolve();
    },
  };
}

function pod(providerId: string, instanceUrl: string, authMode?: Pod['authMode']): Pod {
  return {
    id: 'p1',
    authMode,
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

describe('a pod that recorded its auth mode is not re-authenticated as someone else', () => {
  it('uses the pasted token even when the editor holds a GitHub session', async () => {
    registerBuiltInProviders();
    let sessionAsked = false;
    setSessionProvider(() => {
      sessionAsked = true;
      return Promise.resolve('gho_someone_elses_account');
    });
    const secrets = secretsWith({
      [tokenSecretKey('github', 'https://github.com')]: 'ghp_mine',
    });

    await expect(connectionForPod(pod('github', 'https://github.com', 'token'), secrets))
      .resolves.toBeDefined();
    // The whole point: the editor account is never consulted for a token pod.
    expect(sessionAsked).toBe(false);
  });

  it('uses the session for a pod that recorded one, ignoring any stored token', async () => {
    registerBuiltInProviders();
    setSessionProvider(() => Promise.resolve('gho_session'));
    const secrets = secretsWith({
      [tokenSecretKey('github', 'https://github.com')]: 'ghp_stale',
    });
    await expect(connectionForPod(pod('github', 'https://github.com', 'session'), secrets))
      .resolves.toBeDefined();
  });

  it('falls back to the declared order for a pod created before authMode existed', async () => {
    registerBuiltInProviders();
    let sessionAsked = false;
    setSessionProvider(() => {
      sessionAsked = true;
      return Promise.resolve('gho_session');
    });
    await expect(connectionForPod(pod('github', 'https://github.com'), secretsWith()))
      .resolves.toBeDefined();
    expect(sessionAsked).toBe(true);
  });

  it('ignores a recorded mode the provider no longer offers for that host', async () => {
    registerBuiltInProviders();
    setSessionProvider(() => Promise.resolve('gho_session'));
    // Enterprise hosts declare token only; a stale 'session' must not strand the pod.
    const secrets = secretsWith({
      [tokenSecretKey('github', 'https://ghe.example.test')]: 'ghp_ghes',
    });
    await expect(connectionForPod(pod('github', 'https://ghe.example.test', 'session'), secrets))
      .resolves.toBeDefined();
  });
});

/**
 * The one place the redactor's strongest layer gets its facts. `harnessActivitySanitizer.ts` had
 * three separate holes in a day, each a credential that was plainly present and simply did not
 * have the syntax the pattern expected. A value the host is holding does not need a shape to be
 * recognised — but only if something tells the redactor about it, and this is the only point where
 * a credential of either kind becomes a value the rest of the extension can hold.
 *
 * The secrets below are deliberately opaque: no `ghp_`/`glpat-` prefix, nothing any pattern in the
 * sanitizer recognises, so a passing assertion can only mean registration happened.
 */
describe('a credential the host materialises is registered with the redactor', () => {
  afterEach(clearRegisteredSecretValues);

  it('registers a pasted token, so it is redacted wherever it later appears', async () => {
    registerBuiltInProviders();
    const opaque = 'Qp7xTv2rLw8sNb4cZk3m';
    expect(redactSecrets(`plain ${opaque} text`)).toContain(opaque); // nothing knows it yet

    const secrets = secretsWith({ [tokenSecretKey('gitlab', 'https://gitlab.com')]: opaque });
    await expect(connectionForPod(pod('gitlab', 'https://gitlab.com'), secrets)).resolves.toBeDefined();

    expect(redactSecrets(`plain ${opaque} text`)).toBe('plain [REDACTED] text');
  });

  it('registers a host-supplied session token too, which stores no secret to find later', async () => {
    registerBuiltInProviders();
    const opaque = 'Nb4cZk3mQp7xTv2rLw8s';
    setSessionProvider(() => Promise.resolve(opaque));

    await expect(connectionForPod(pod('github', 'https://github.com'), secretsWith())).resolves.toBeDefined();

    expect(redactSecrets(`{"note":"used ${opaque}"}`)).not.toContain(opaque);
  });

  it('registers nothing for a provider that needs no credential', async () => {
    registerBuiltInProviders();
    await expect(connectionForPod(pod('fixture', 'https://demo.invalid'), secretsWith())).resolves.toBeDefined();
    expect(redactSecrets('an ordinary sentence about a demo pod')).toBe('an ordinary sentence about a demo pod');
  });
});
