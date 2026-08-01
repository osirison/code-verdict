import { describe, expect, it } from 'vitest';
import { renderOnboardingHtml, type OnboardingViewState } from './onboardingHtml';

const base: OnboardingViewState = {
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