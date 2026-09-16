/**
 * No provider may serve investigation again.
 *
 * The five revision-pinned operations were on `Connection` as optional members,
 * so a forge could serve a review's evidence when a local object store could
 * not. That fallback is gone: the rule is that anything git can answer is
 * answered by git, always, and the provider is asked only for what is not in
 * the repository. A route that exists is a route that gets taken, so this file
 * is the tripwire — a provider that grows a `readDiff` back fails here, whatever
 * else compiles.
 *
 * It lives under `src/providers` because it names concrete providers, which the
 * dependency rule permits only here and in `src/registry.ts`. The neutral half
 * of the boundary — what may and may not join `InvestigationSource` at all — is
 * in `src/platform/investigationSource.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { INVESTIGATION_OPERATION_NAMES } from '../platform/types';
import type { Connection } from '../platform/provider';
import { createGitHubProvider } from './github/githubProvider';
import { createGitLabProvider } from './gitlab/gitlabProvider';
import { fixtureProvider } from './fixture/fixtureProvider';

const CONFIG = { instanceUrl: 'https://example.invalid', credential: { kind: 'token' as const, token: 't' } };

/** Every shipped connection, so the tripwire covers all of them rather than a representative one. */
function everyConnection(): readonly { id: string; connection: Connection }[] {
  return [
    { id: 'github', connection: createGitHubProvider().connect({ ...CONFIG, instanceUrl: 'https://github.com' }) },
    { id: 'gitlab', connection: createGitLabProvider().connect(CONFIG) },
    { id: 'fixture', connection: fixtureProvider.connect({ instanceUrl: 'fixture', credential: { kind: 'none' } }) },
  ];
}

describe('no provider may serve investigation again', () => {
  it('defines none of the five on any shipped connection', () => {
    const offenders: string[] = [];
    for (const { id, connection } of everyConnection()) {
      const bag = connection as unknown as Record<string, unknown>;
      for (const operation of INVESTIGATION_OPERATION_NAMES) {
        if (bag[operation] !== undefined) offenders.push(`${id}.${operation}`);
      }
    }
    expect(
      offenders,
      'a forge answering one of these is a second route around the object store, which is how the fallback comes back',
    ).toEqual([]);
  });

  it('still answers the forge-only operations, so the absence above is a boundary and not an empty object', () => {
    // Non-vacuity. Without this, deleting every method from a connection would
    // make the case above pass while breaking the product.
    for (const { id, connection } of everyConnection()) {
      const bag = connection as unknown as Record<string, unknown>;
      expect(typeof bag.getChangeRequestDiff, `${id} must still fetch a whole diff for the review screens`).toBe('function');
      expect(typeof bag.submitReview, `${id} must still post a review`).toBe('function');
      expect(typeof bag.getObjectSource, `${id} must still say where objects come from, or explicitly not define it`).toBeOneOf([
        'function',
        'undefined',
      ]);
    }
  });

  it('declares no investigation capabilities on any provider', () => {
    for (const provider of [createGitHubProvider(), createGitLabProvider(), fixtureProvider]) {
      expect('reviewInvestigation' in provider.capabilities, `${provider.id} must not declare investigation capabilities`).toBe(false);
      expect(Object.keys(provider.capabilities.detailRetrieval ?? {}).sort()).toEqual([
        'changeRequestDetails',
        'issueDetails',
        'pagination',
      ]);
    }
  });
});
