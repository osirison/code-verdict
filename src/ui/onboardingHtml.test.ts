import { describe, expect, it } from 'vitest';
import { GITLAB_HOST, GITLAB_VOCABULARY } from '../testing/specFixtures';
import { renderOnboardingHtml, type OnboardingViewState } from './onboardingHtml';

const base: OnboardingViewState = {
  vocabulary: GITLAB_VOCABULARY,
  host: GITLAB_HOST,
  step: 1,
  instanceUrl: 'http://127.0.0.1:8971',
  connectionStatus: 'Not tested yet',
  connected: false,
  podName: 'Platform squad',
  sources: [],
  selectedProjects: 0,
};

describe('onboarding fidelity (spec §1)', () => {
  it('renders the connect, pod, and project steps with exact core copy', () => {
    const connect = renderOnboardingHtml(base, 'nonce123');
    const pod = renderOnboardingHtml({ ...base, step: 2, connected: true }, 'nonce123');
    const projects = renderOnboardingHtml({ ...base, step: 3, connected: true }, 'nonce123');
    expect(connect).toContain('Welcome to Code Verdict');
    expect(connect).toContain('Test connection');
    expect(pod).toContain('Name your pod');
    expect(pod).toContain('Platform squad');
    expect(projects).toContain('Add projects to Platform squad');
    expect(projects).toContain('group 4821');
  });

  it('keeps secrets behind a strict CSP and typed messages', () => {
    const html = renderOnboardingHtml(base, 'nonce123');
    const projects = renderOnboardingHtml({ ...base, step: 3, connected: true }, 'nonce123');
    expect(html).toContain('type="password"');
    expect(html).toContain(`script-src 'nonce-nonce123'`);
    expect(html).toContain("type: 'testConnection'");
    expect(projects).toContain("type: 'createPod'");
  });
});
describe('the session path (spec: a provider that authenticates by host-supplied session)', () => {
  it('offers the account as the default and marks the token optional', () => {
    const html = renderOnboardingHtml({ ...base, sessionAvailable: true }, 'n');
    expect(html).toContain('Use my GitLab account');
    expect(html).toContain('optional');
    // The token field stays as the fallback — offered, not required.
    expect(html).toContain('id="token"');
    expect(html).toContain("post({ type: 'useSession'");
  });

  it('asks only for a token when the provider declares no session for the host', () => {
    const html = renderOnboardingHtml(base, 'n');
    // The listener line is always present and `?.`-guarded; the button is the
    // thing that must be absent.
    expect(html).not.toContain('Use my GitLab account');
    expect(html).not.toContain('id="use-session"');
    expect(html).not.toContain('optional');
    expect(html).toContain('id="token"');
  });
});
