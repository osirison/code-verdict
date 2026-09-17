/**
 * The read path for `codeVerdict.changesets.*`. `detectChangesets` itself is
 * covered by `app/changesets.test.ts`; this is about what reaches it from
 * settings.json.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TRAILER, detectChangesets } from '../app/changesets';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Pod } from '../domain/types';

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => (key in settings.values ? settings.values[key] : fallback),
    }),
  },
}));

import { changesetDetectionOptions, changesetTrailer } from './changesetOptions';

const EMPTY_STORE = { get: () => undefined, update: () => Promise.resolve() };

const POD: Pod = {
  id: 'pod-1',
  name: 'Platform',
  providerId: 'fixture',
  instanceUrl: 'https://example.test',
  sources: [{ kind: 'repository', repoId: 'acme/api' }],
  criteria: DEFAULT_CRITERIA,
  agentId: 'built-in',
};

function changeRequest(number: string, description: string) {
  return {
    ref: { repoId: 'acme/api', number },
    title: `CR ${number}`,
    state: 'open' as const,
    sourceBranch: 'feat/x',
    targetBranch: 'main',
    author: { username: 'author' },
    reviewers: [],
    webUrl: `https://example.test/pr/${number}`,
    updatedAt: '2026-08-20T09:00:00Z',
    headSha: 'aaaa',
    description,
  };
}

describe('codeVerdict.changesets.trailer read path', () => {
  beforeEach(() => {
    settings.values = {};
  });

  it('uses the shipped trailer when nothing is configured and a configured string when one is', () => {
    expect(changesetTrailer()).toBe(DEFAULT_TRAILER);
    settings.values['changesets.trailer'] = 'Closes:';
    expect(changesetTrailer()).toBe('Closes:');
  });

  // Every consumer of the trailer calls `.trim()` on it first
  // (`detectChangesets`, `linkedWorkItemNumbers`), so a non-string did not
  // detect nothing — it threw `TypeError: trailer.trim is not a function` out
  // of detection, which runs on the dashboard, the sidebar and the review
  // context. This asserts the throw is gone *and* that detection still works
  // off the default, because falling back to a trailer nothing matches would
  // be the same outage with a quieter symptom.
  it('falls back to the shipped trailer on a non-string instead of throwing out of detection', () => {
    const crs = [changeRequest('1', 'Part-of: #1180'), changeRequest('2', 'Part-of: #1180')];
    for (const bad of [42, true, null, { trailer: 'Part-of:' }, ['Part-of:']]) {
      settings.values['changesets.trailer'] = bad;
      expect(changesetTrailer(), String(bad)).toBe(DEFAULT_TRAILER);
      const options = changesetDetectionOptions(EMPTY_STORE, undefined);
      expect(() => detectChangesets(POD, crs, [], options), String(bad)).not.toThrow();
      expect(detectChangesets(POD, crs, [], options).map((set) => set.detection), String(bad)).toEqual(['trailer']);
    }
  });
});

describe('codeVerdict.changesets.branchDetection read path', () => {
  beforeEach(() => {
    settings.values = {};
  });

  it('is on when unset and honours an explicit false', () => {
    expect(changesetDetectionOptions(EMPTY_STORE, undefined).branchFallback).toBe(true);
    settings.values['changesets.branchDetection'] = false;
    expect(changesetDetectionOptions(EMPTY_STORE, undefined).branchFallback).toBe(false);
  });

  // `detectChangesets` reads `branchFallback` truthily, so a non-boolean used
  // to half-apply in whichever direction it coerced: `0` and `""` switched the
  // branch fallback off though it ships on, and `"false"` switched it on. Both
  // have to land on the declared default instead.
  it('reads a non-boolean as the shipped on rather than letting a falsy string switch the fallback off', () => {
    for (const bad of [0, '', 'false', 'true', 1, null, {}, []]) {
      settings.values['changesets.branchDetection'] = bad;
      expect(changesetDetectionOptions(EMPTY_STORE, undefined).branchFallback, String(bad)).toBe(true);
    }
  });
});
