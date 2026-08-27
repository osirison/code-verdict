import { describe, expect, it } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Pod } from '../domain/types';
import { PodStore } from './pods';
import type { KeyValueStore } from './storage';
import { deleteTokenIfUnused, legacyTokenSecretKey, readToken, tokenSecretKey } from './storage';
import type { SecretStore } from './storage';

function memorySecrets(entries: Record<string, string> = {}): SecretStore & { keys(): string[] } {
  const map = new Map(Object.entries(entries));
  return {
    keys: () => [...map.keys()],
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    update: async (key, value) => {
      map.set(key, value);
    },
  };
}

function pod(id: string, instanceUrl = 'http://127.0.0.1:8971'): Pod {
  return {
    id,
    name: `Pod ${id}`,
    providerId: 'gitlab',
    instanceUrl,
    sources: [{ kind: 'group', groupId: '4821', repoIds: ['9101'] }],
    criteria: DEFAULT_CRITERIA,
    agentId: '',
  };
}

describe('PodStore', () => {
  it('persists pods and the active pointer', async () => {
    const store = new PodStore(memoryStore());
    await store.upsert(pod('a'));
    await store.upsert(pod('b'));
    await store.setActive('b');
    expect(store.list().map((p) => p.id)).toEqual(['a', 'b']);
    expect(store.activePod?.id).toBe('b');
  });

  it('falls back to the first pod when no active pointer is set', async () => {
    const store = new PodStore(memoryStore());
    await store.upsert(pod('only'));
    expect(store.activePod?.id).toBe('only');
  });

  it('upsert replaces by id and findByInstance matches provider + url', async () => {
    const store = new PodStore(memoryStore());
    await store.upsert(pod('a'));
    await store.upsert({ ...pod('a'), name: 'Renamed' });
    expect(store.list()).toHaveLength(1);
    expect(store.get('a')?.name).toBe('Renamed');
    expect(store.findByInstance('gitlab', 'http://127.0.0.1:8971')?.id).toBe('a');
    expect(store.findByInstance('gitlab', 'https://gitlab.com')).toBeUndefined();
  });
});

describe('PodStore.remove', () => {
  it('removes a pod that was not active and leaves the pointer alone', async () => {
    const store = new PodStore(memoryStore());
    await store.upsert(pod('a'));
    await store.upsert(pod('b'));
    await store.setActive('a');

    await store.remove('b');

    expect(store.list().map((p) => p.id)).toEqual(['a']);
    expect(store.activePod?.id).toBe('a');
  });

  it('repoints the active pointer at a survivor when the active pod goes', async () => {
    const store = new PodStore(memoryStore());
    await store.upsert(pod('a'));
    await store.upsert(pod('b'));
    await store.setActive('a');

    await store.remove('a');

    expect(store.list().map((p) => p.id)).toEqual(['b']);
    expect(store.activePod?.id).toBe('b');
  });

  it('clears the pointer when the last pod goes', async () => {
    const kv = memoryStore();
    const store = new PodStore(kv);
    await store.upsert(pod('only'));
    await store.setActive('only');

    await store.remove('only');

    expect(store.list()).toEqual([]);
    expect(store.activePod).toBeUndefined();
    // Not merely shadowed by the pods[0] fallback: the key itself is cleared,
    // so re-creating a pod with the same id cannot make it silently active.
    expect(kv.get('codeVerdict.activePodId')).toBeUndefined();
  });

  it('is a no-op for an unknown id, down to not touching the pointer', async () => {
    const kv = memoryStore();
    const store = new PodStore(kv);
    await store.upsert(pod('a'));
    await store.setActive('a');

    await store.remove('nope');

    expect(store.list().map((p) => p.id)).toEqual(['a']);
    expect(kv.get('codeVerdict.activePodId')).toBe('a');
  });
});

describe('deleteTokenIfUnused', () => {
  const onHost = (id: string, providerId = 'gitlab', instanceUrl = 'https://gitlab.example') =>
    ({ id, providerId, instanceUrl });

  it('keeps the token while another pod on the same provider and host still reads it', async () => {
    const key = tokenSecretKey('gitlab', 'https://gitlab.example');
    const secrets = memorySecrets({ [key]: 'glpat-shared' });

    await deleteTokenIfUnused(secrets, onHost('a'), [onHost('b')]);

    // Secrets are keyed provider + host, so deleting here would have signed
    // pod "b" out of a pod nobody asked to touch.
    expect(secrets.keys()).toContain(key);
  });

  it('treats a trailing-slash instance url as the same secret', async () => {
    const key = tokenSecretKey('gitlab', 'https://gitlab.example');
    const secrets = memorySecrets({ [key]: 'glpat-shared' });

    await deleteTokenIfUnused(secrets, onHost('a', 'gitlab', 'https://gitlab.example'), [
      onHost('b', 'gitlab', 'https://gitlab.example/'),
    ]);

    expect(secrets.keys()).toContain(key);
  });

  it('deletes the token once the last pod on that provider and host goes', async () => {
    const key = tokenSecretKey('gitlab', 'https://gitlab.example');
    const secrets = memorySecrets({ [key]: 'glpat-shared' });

    await deleteTokenIfUnused(secrets, onHost('a'), []);

    expect(secrets.keys()).not.toContain(key);
  });

  it('leaves another provider on the same host signed in', async () => {
    const gitlabKey = tokenSecretKey('gitlab', 'https://one.example');
    const githubKey = tokenSecretKey('github', 'https://one.example');
    const secrets = memorySecrets({ [gitlabKey]: 'glpat', [githubKey]: 'ghp' });

    await deleteTokenIfUnused(secrets, onHost('a', 'gitlab', 'https://one.example'), [
      onHost('b', 'github', 'https://one.example'),
    ]);

    expect(secrets.keys()).toEqual([githubKey]);
  });

  it('keeps an unmigrated legacy secret while any pod on that host survives', async () => {
    const legacy = legacyTokenSecretKey('https://one.example');
    const secrets = memorySecrets({ [legacy]: 'glpat-legacy' });

    await deleteTokenIfUnused(secrets, onHost('a', 'gitlab', 'https://one.example'), [
      onHost('b', 'github', 'https://one.example'),
    ]);

    // The legacy key carries no provider, so the github pod can still migrate
    // its token out of it — a stronger condition than the scoped key's.
    expect(secrets.keys()).toContain(legacy);
  });

  it('deletes the legacy secret when nothing is left on the host at all', async () => {
    const legacy = legacyTokenSecretKey('https://one.example');
    const secrets = memorySecrets({ [legacy]: 'glpat-legacy' });

    await deleteTokenIfUnused(secrets, onHost('a', 'gitlab', 'https://one.example'), [
      onHost('b', 'gitlab', 'https://two.example'),
    ]);

    expect(secrets.keys()).toEqual([]);
  });
});

describe('tokenSecretKey', () => {
  it('keys tokens per provider and instance host', () => {
    expect(tokenSecretKey('gitlab', 'http://127.0.0.1:8971')).toBe('codeVerdict.token.gitlab|127.0.0.1:8971');
    expect(tokenSecretKey('gitlab', 'https://gitlab.com/')).toBe('codeVerdict.token.gitlab|gitlab.com');
  });

  it('cannot collide with a legacy key, whatever the host is named', () => {
    // Joining with "." made these the same string, so readToken would hand one
    // pod's token to another and then persist the substitution.
    expect(tokenSecretKey('gitlab', 'https://acme.com'))
      .not.toBe(legacyTokenSecretKey('https://gitlab.acme.com'));
    expect(tokenSecretKey('github', 'https://acme.com'))
      .not.toBe(legacyTokenSecretKey('https://github.acme.com'));
  });

  it('keeps two providers on one host apart', () => {
    expect(tokenSecretKey('github', 'https://example.test')).not.toBe(
      tokenSecretKey('gitlab', 'https://example.test'),
    );
  });

  it('migrates a legacy instance-only secret to the provider-scoped key', async () => {
    const store = new Map<string, string>([[legacyTokenSecretKey('https://gitlab.com'), 'glpat-old']]);
    const secrets = {
      get: (key: string) => Promise.resolve(store.get(key)),
      store: (key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => {
        store.delete(key);
        return Promise.resolve();
      },
    };
    await expect(readToken(secrets, 'gitlab', 'https://gitlab.com')).resolves.toBe('glpat-old');
    // Rewritten under the scoped key, so the fallback is taken only once.
    expect(store.get(tokenSecretKey('gitlab', 'https://gitlab.com'))).toBe('glpat-old');
  });

  it('returns undefined when neither key holds a secret', async () => {
    const secrets = { get: () => Promise.resolve(undefined), store: () => Promise.resolve(), delete: () => Promise.resolve() };
    await expect(readToken(secrets, 'gitlab', 'https://gitlab.com')).resolves.toBeUndefined();
  });
});
