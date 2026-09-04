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
  context: {
    sectionBudget: 4_000,
    totalBudget: 12_000,
    maxLinkedItems: 5,
    includeTitle: true,
    includeDescription: true,
    includeLinkedItems: true,
    usageEnabled: true,
  },
  harness: {
    maxElapsedSecondsPerAttempt: 1_800,
    maxModelTurnsPerAttempt: 64,
    maxToolRequestsPerAttempt: 256,
    maxEvidenceMegabytesPerAttempt: 8,
    highRiskReservePercent: 20,
    verificationReservePercent: 15,
    transientRetriesPerOperation: 3,
    checkpointCadenceToolCalls: 10,
    retainedCheckpointsPerLineage: 3,
    maxActivityEventsPerAttempt: 1_000,
    terminalAttemptHistoryCount: 5,
    terminalAttemptHistoryMaxAgeDays: 30,
    requireInspectionMinRisk: 'low',
  },
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
    expect(html).toContain('Context');
    expect(html).toContain('Harness');
    expect(html).toContain('Data &amp; privacy');
    expect(html).toContain('settings.json');
    expect(html).toContain('Agent finished a review');
    expect(html).toContain('A posted thread went stale');
    expect(html).toContain('Rotate token');
    expect(html).toContain('••••••••');
    expect(html).toContain('The selected agent and model receive diff hunks, file paths, your review criteria, selected attachment contents and paths, and, when enabled, the merge request title, description, and linked issues.');
  });

  it('wires controls through typed CSP-safe messages', () => {
    const html = renderSettingsHtml(state, 'nonce123');
    expect(html).toContain(`script-src 'nonce-nonce123'`);
    expect(html).toContain("type: 'setNotification'");
    expect(html).toContain("type: 'setQuietMode'");
    // Delegated on `document` via the shared `on(id, type)` helper (issue #39
    // follow-up), not bound to the rendered button directly — a region patch
    // replaces this markup, and a handler bound to the replaced node would
    // die with it.
    expect(html).toContain("on('open-json', 'openSettingsJson')");
    expect(html).toContain("on('test-connection', 'testConnection')");
    // The toggle's next value comes off its own rendered `data-checked`
    // attribute, not a client-side variable the host can never see: the host
    // repaints this region after every change, so the attribute is always
    // current.
    expect(html).toContain('data-checked="false"');
    expect(html).toContain("el.dataset.checked !== 'true'");
  });

  it('renders every context setting and wires validated typed messages', () => {
    const html = renderSettingsHtml(state, 'nonce123');
    expect(html).toContain('data-context-budget="sectionBudget" type="number" min="1" step="1" value="4000"');
    expect(html).toContain('data-context-budget="totalBudget" type="number" min="1" step="1" value="12000"');
    expect(html).toContain('data-context-budget="maxLinkedItems" type="number" min="1" step="1" value="5"');
    expect(html).toContain('data-context-toggle="includeTitle" data-enabled="true"');
    expect(html).toContain('data-context-toggle="includeDescription" data-enabled="true"');
    expect(html).toContain('data-context-toggle="includeLinkedItems" data-enabled="true"');
    expect(html).toContain('data-context-toggle="usageEnabled" data-enabled="true"');
    expect(html).toContain("type: 'setContextBudget'");
    expect(html).toContain("type: 'setContextToggle'");
    expect(html).toContain('Number.isInteger(value) && value > 0');
  });

  it('renders every harness setting this change exposes, and only those', () => {
    const html = renderSettingsHtml(state, 'nonce123');
    expect(html).toContain('data-harness-number="maxElapsedSecondsPerAttempt" type="number" min="1" step="1" value="1800"');
    expect(html).toContain('data-harness-number="maxModelTurnsPerAttempt" type="number" min="1" step="1" value="64"');
    expect(html).toContain('data-harness-number="maxToolRequestsPerAttempt" type="number" min="1" step="1" value="256"');
    expect(html).toContain('data-harness-number="maxEvidenceMegabytesPerAttempt" type="number" min="1" step="1" value="8"');
    // The two reserve percents allow 0 and cap at 100 — not the `min="1"` every count-like field uses.
    expect(html).toContain('data-harness-number="highRiskReservePercent" type="number" min="0" max="100" step="1" value="20"');
    expect(html).toContain('data-harness-number="verificationReservePercent" type="number" min="0" max="100" step="1" value="15"');
    // Retries allow 0 (no retries), unlike the count-like fields above.
    expect(html).toContain('data-harness-number="transientRetriesPerOperation" type="number" min="0" step="1" value="3"');
    expect(html).toContain('data-harness-number="checkpointCadenceToolCalls" type="number" min="1" step="1" value="10"');
    expect(html).toContain('data-harness-number="retainedCheckpointsPerLineage" type="number" min="1" step="1" value="3"');
    expect(html).toContain('data-harness-number="maxActivityEventsPerAttempt" type="number" min="1" step="1" value="1000"');
    expect(html).toContain('data-harness-number="terminalAttemptHistoryCount" type="number" min="1" step="1" value="5"');
    expect(html).toContain('data-harness-number="terminalAttemptHistoryMaxAgeDays" type="number" min="1" step="1" value="30"');
    // Never a provider page-size setting: internal pagination mechanics, out of both package.json and this panel.
    for (const pageSizeKey of [
      'manifestPageSize',
      'diffOrFileReadPageLines',
      'diffOrFileReadPageBytes',
      'searchResultPageMatches',
      'searchResultPageBytes',
    ]) {
      expect(html).not.toContain(`data-harness-number="${pageSizeKey}"`);
    }
  });

  it('renders the risk-coverage control with the fail-closed default selected, and wires typed messages', () => {
    const html = renderSettingsHtml(state, 'nonce123');
    expect(html).toContain('Inspection required from');
    expect(html).toContain('data-min-risk="low"');
    expect(html).toContain('data-min-risk="medium"');
    expect(html).toContain('data-min-risk="high"');
    expect(html).toMatch(/class="active" data-min-risk="low"/);
    expect(html).toContain("type: 'setHarnessNumber'");
    expect(html).toContain("type: 'setHarnessMinRisk'");
  });

  it('the risk-coverage control moves with the configured value, never defaulting silently back to low', () => {
    const html = renderSettingsHtml({ ...state, harness: { ...state.harness, requireInspectionMinRisk: 'high' } }, 'n');
    expect(html).toMatch(/class="active" data-min-risk="high"/);
    expect(html).not.toMatch(/class="active" data-min-risk="low"/);
  });

  it('never writes an inline style attribute anywhere on the page', () => {
    expect(renderSettingsHtml(state, 'nonce123')).not.toContain('style="');
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
