import { describe, expect, it } from 'vitest';
import { GITLAB_VOCABULARY } from '../testing/specFixtures';
import { formatConnectionStatus, renderSettingsHtml, type SettingsViewState } from './settingsHtml';

const state: SettingsViewState = {
  vocabulary: GITLAB_VOCABULARY,
  instanceUrl: 'http://127.0.0.1:8971',
  connectionStatus: 'connected as @you · api scope',
  connected: true,
  hasToken: true,
  quietMode: false,
  digestCadence: 'End of day',
  shareRates: false,
  agentLocations: [{ label: '.github/agents', configured: false, status: 'ok', agentCount: 2 }],
  notifications: [
    { key: 'agentFinished', label: 'Agent finished a review', hint: 'Review results are ready to triage.', mode: 'Interrupt' },
    { key: 'replyPosted', label: 'Reply on a comment you posted', hint: 'An author replied to your review.', mode: 'Interrupt' },
    { key: 'authorPushed', label: 'Author pushed a fix', hint: 'The merge request changed after review.', mode: 'Badge' },
    { key: 'pipelineFailed', label: 'Pipeline failed', hint: 'A watched pipeline needs attention.', mode: 'Digest' },
    { key: 'reviewRequested', label: 'Review requested from you', hint: 'A merge request is waiting on you.', mode: 'Interrupt' },
    { key: 'mentioned', label: 'You were mentioned', hint: 'A discussion mentioned your username.', mode: 'Badge' },
    { key: 'threadStale', label: 'A posted thread went stale', hint: 'New commits moved a reviewed line.', mode: 'Digest' },
  ],
};

describe('settings fidelity (spec §11)', () => {
  it('renders every required section and notification event', () => {
    const html = renderSettingsHtml(state, 'nonce123');
    expect(html).toContain('Settings');
    expect(html).toContain('Connection');
    expect(html).toContain('Notifications');
    expect(html).toContain('Data &amp; privacy');
    expect(html).toContain('settings.json');
    expect(html).toContain('Agent finished a review');
    expect(html).toContain('A posted thread went stale');
    expect(html).toContain('Rotate token');
    expect(html).toContain('••••••••');
  });

  it('wires controls through typed CSP-safe messages', () => {
    const html = renderSettingsHtml(state, 'nonce123');
    expect(html).toContain(`script-src 'nonce-nonce123'`);
    expect(html).toContain("type: 'setNotification'");
    expect(html).toContain("type: 'setQuietMode'");
    expect(html).toContain("type: 'openSettingsJson'");
    expect(html).toContain('let quietMode = false');
    expect(html).toContain('quietMode = !quietMode');
    expect(html).toContain('shareRates = !shareRates');
  });
});

describe('formatConnectionStatus', () => {
  it('composes the spec §11 status line, expiry included', () => {
    expect(
      formatConnectionStatus({ username: 'you', scopes: ['api'], tokenExpiresInDays: 42 }),
    ).toBe('connected as @you · api scope · token expires in 42 days');
  });

  it('omits the expiry segment when the provider does not report one', () => {
    expect(formatConnectionStatus({ username: 'you', scopes: ['api'] })).toBe(
      'connected as @you · api scope',
    );
  });

  it('falls back to the pod username, then "you"', () => {
    expect(formatConnectionStatus({}, 'mira')).toBe('connected as @mira · unknown scope');
    expect(formatConnectionStatus({})).toBe('connected as @you · unknown scope');
  });

  it('pluralizes scopes and days', () => {
    expect(
      formatConnectionStatus({ username: 'you', scopes: ['api', 'read_user'], tokenExpiresInDays: 1 }),
    ).toBe('connected as @you · api, read_user scopes · token expires in 1 day');
  });
});

describe('the Agents section (spec: review-agents — Additional agent locations)', () => {
  const render = (locations: SettingsViewState['agentLocations']) =>
    renderSettingsHtml({ ...state, agentLocations: locations }, 'n');

  it('lists each searched location with what it yielded', () => {
    const html = render([
      { label: '.github/agents', configured: false, status: 'ok', agentCount: 2 },
      { label: '/home/me/agents', configured: true, status: 'ok', agentCount: 1 },
    ]);
    expect(html).toContain('.github/agents');
    expect(html).toContain('2 agents');
    expect(html).toContain('/home/me/agents');
    expect(html).toContain('1 agent<');
  });

  it('names an unreadable location without hiding the others', () => {
    const html = render([
      { label: '/gone', configured: true, status: 'unreadable', agentCount: 0 },
      { label: '.github/agents', configured: false, status: 'ok', agentCount: 3 },
    ]);
    expect(html).toContain('/gone');
    expect(html).toContain('could not be read');
    expect(html).toContain('3 agents');
  });

  it('offers Remove only for a configured location, never for the built-in one', () => {
    const html = render([
      { label: '.github/agents', configured: false, status: 'ok', agentCount: 0 },
      { label: '/home/me/agents', configured: true, status: 'ok', agentCount: 0 },
    ]);
    expect(html).toContain('data-remove-location="/home/me/agents"');
    expect(html).not.toContain('data-remove-location=".github/agents"');
  });

  it('says so when there is nowhere to search', () => {
    expect(render([])).toContain('No workspace folder is open');
  });

  it('offers a way to add one', () => {
    expect(render([])).toContain('id="add-location"');
  });
});
