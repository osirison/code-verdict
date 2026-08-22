import { describe, expect, it } from 'vitest';
import { getSignInOptions, needsSignInChoice } from './signInFlow';
import type { ScmProvider } from './platform/provider';

function provider(id: string, displayName: string, instanceUrlLabel: string): ScmProvider {
  return { id, displayName, host: { instanceUrlLabel } } as unknown as ScmProvider;
}

const GITLAB = provider('gitlab', 'GitLab', 'GitLab instance URL');
const GITHUB = provider('github', 'GitHub', 'GitHub host');

describe('sign-in options', () => {
  it('offers one option per registered provider, naming no platform of its own', () => {
    const options = getSignInOptions(false, [GITLAB, GITHUB]);
    expect(options.map((o) => o.providerId)).toEqual(['gitlab', 'github']);
    expect(options.map((o) => o.label)).toEqual(['Use GitLab', 'Use GitHub']);
  });

  it('skips the chooser when a single provider is registered', () => {
    expect(needsSignInChoice(getSignInOptions(false, [GITLAB]))).toBe(false);
    expect(needsSignInChoice(getSignInOptions(false, [GITLAB, GITHUB]))).toBe(true);
  });

  it('adds the emulator shortcut only under the debug bypass, and it names no platform', () => {
    expect(getSignInOptions(false, [GITLAB]).some((o) => o.flow === 'debug')).toBe(false);
    const debug = getSignInOptions(true, [GITLAB]).find((o) => o.flow === 'debug');
    expect(debug).toBeDefined();
    expect(debug?.description).not.toMatch(/gitlab|github/i);
    // One provider plus the bypass is still a choice worth showing.
    expect(needsSignInChoice(getSignInOptions(true, [GITLAB]))).toBe(true);
  });
});
