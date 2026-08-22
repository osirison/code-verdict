import { describe, expect, it } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Pod } from '../domain/types';
import { PodStore } from './pods';
import type { KeyValueStore } from './storage';
import { legacyTokenSecretKey, readToken, tokenSecretKey } from './storage';

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

describe('tokenSecretKey', () => {
  it('keys tokens per provider and instance host', () => {
    expect(tokenSecretKey('gitlab', 'http://127.0.0.1:8971')).toBe('codeVerdict.token.gitlab.127.0.0.1:8971');
    expect(tokenSecretKey('gitlab', 'https://gitlab.com/')).toBe('codeVerdict.token.gitlab.gitlab.com');
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
    };
    await expect(readToken(secrets, 'gitlab', 'https://gitlab.com')).resolves.toBe('glpat-old');
    // Rewritten under the scoped key, so the fallback is taken only once.
    expect(store.get(tokenSecretKey('gitlab', 'https://gitlab.com'))).toBe('glpat-old');
  });

  it('returns undefined when neither key holds a secret', async () => {
    const secrets = { get: () => Promise.resolve(undefined), store: () => Promise.resolve() };
    await expect(readToken(secrets, 'gitlab', 'https://gitlab.com')).resolves.toBeUndefined();
  });
});
