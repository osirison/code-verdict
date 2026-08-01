import { escapeHtml, renderPage } from './theme';

export type NotificationMode = 'Interrupt' | 'Badge' | 'Digest' | 'Off';

export interface NotificationSettingView {
  key: string;
  label: string;
  hint: string;
  mode: NotificationMode;
}

export interface SettingsViewState {
  instanceUrl: string;
  connectionStatus: string;
  connected: boolean;
  hasToken: boolean;
  quietMode: boolean;
  digestCadence: 'Hourly' | 'Twice a day' | 'End of day';
  shareRates: boolean;
  notifications: NotificationSettingView[];
}

export type SettingsMessage =
  | { type: 'rotateToken' }
  | { type: 'setNotification'; key: string; mode: NotificationMode }
  | { type: 'setQuietMode'; value: boolean }
  | { type: 'setDigestCadence'; value: SettingsViewState['digestCadence'] }
  | { type: 'setShareRates'; value: boolean }
  | { type: 'openSettingsJson' };

const MODES: readonly NotificationMode[] = ['Interrupt', 'Badge', 'Digest', 'Off'];
const CADENCES: readonly SettingsViewState['digestCadence'][] = ['Hourly', 'Twice a day', 'End of day'];

const CSS = `
.wrap { max-width: 820px; padding: 26px 30px; display: flex; flex-direction: column; gap: 26px; }
h1 { color: var(--fg-max); font-size: 19px; font-weight: 600; line-height: 1.25; }
.section { display: flex; flex-direction: column; gap: 11px; }
.label { color: var(--fg-dimmer); font-size: 10px; font-weight: 500; letter-spacing: .09em; text-transform: uppercase; }
.connection { display: flex; align-items: center; gap: 12px; border: 1px solid var(--line); border-radius: 6px; padding: 13px 15px; }
.connection-copy { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.instance { color: var(--fg-hi); font: 500 12.5px/1.3 var(--font-mono); }
.status { color: var(--fg-dimmer); font-size: 11.5px; }
.status.ok { color: var(--ok); }
.connection-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.masked { color: var(--fg-dimmer); font: 11px/1 var(--font-mono); }
.notification { display: flex; align-items: center; gap: 14px; padding: 9px 0; border-bottom: 1px solid var(--row); }
.notification-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.notification-name { color: var(--fg-hi); font-size: 12.5px; font-weight: 500; line-height: 1.3; }
.hint { color: var(--fg-dimmer); font-size: 11px; line-height: 1.4; }
.segments { margin-left: auto; display: flex; gap: 3px; padding: 3px; border-radius: 5px; background: var(--bg3); flex: none; }
.segments button { border: none; border-radius: 4px; background: none; color: var(--fg-dim); cursor: pointer; padding: 5px 8px; font: 11px/1 var(--font-ui); }
.segments button.active { color: #fff; background: var(--accent); }
.segments button.active.off { background: var(--line3); }
.toggle { display: inline-flex; align-items: center; gap: 8px; border: none; background: none; color: var(--fg); cursor: pointer; padding: 0; font: 12px/1.3 var(--font-ui); text-align: left; }
.box { width: 15px; color: var(--accent); font-family: var(--font-mono); }
.note { max-width: 70ch; color: var(--fg-dim); font-size: 12.5px; line-height: 1.65; text-wrap: pretty; }
.subnote { color: var(--fg-dimmer); font-size: 11.5px; line-height: 1.55; text-wrap: pretty; }
.cadence { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cadence-label { color: var(--fg-dim); font-size: 11.5px; }
.chip.compact { padding: 5px 10px; }
.settings-head { display: flex; align-items: center; gap: 12px; }
.link { border: none; background: none; color: var(--link); cursor: pointer; padding: 0; font: 11px/1 var(--font-ui); }
pre { margin: 0; border: 1px solid var(--line); border-radius: 6px; background: var(--code); padding: 13px 15px; color: var(--fg); font: 12px/1.75 var(--font-mono); overflow-x: auto; }
`;

export function renderSettingsHtml(state: SettingsViewState, nonce: string): string {
  const e = escapeHtml;
  const notifications = state.notifications.map((setting) => `<div class="notification">
    <div class="notification-copy"><span class="notification-name">${e(setting.label)}</span><span class="hint">${e(setting.hint)}</span></div>
    <div class="segments">${MODES.map((mode) => `<button class="${setting.mode === mode ? `active ${mode === 'Off' ? 'off' : ''}` : ''}" data-notification="${e(setting.key)}" data-mode="${mode}">${mode}</button>`).join('')}</div>
  </div>`).join('');
  const preview = JSON.stringify({
    'codeVerdict.notifications': Object.fromEntries(state.notifications.map((setting) => [setting.key, setting.mode])),
    'codeVerdict.notifications.quietMode': state.quietMode,
    'codeVerdict.notifications.digestCadence': state.digestCadence,
    'codeVerdict.shareAcceptRejectRates': state.shareRates,
  }, null, 2);

  const body = `<main class="wrap">
    <h1>Settings</h1>
    <section class="section"><div class="label">Connection</div><div class="connection">
      <div class="connection-copy"><span class="instance">${e(state.instanceUrl)}</span><span class="status ${state.connected ? 'ok' : ''}">${e(state.connectionStatus)}</span></div>
      <div class="connection-actions"><span class="masked">${state.hasToken ? 'glpat-••••••••' : 'no token'}</span><button class="btn" id="rotate-token">Rotate token</button></div>
    </div></section>
    <section class="section"><div class="label">Notifications</div>${notifications}
      <button class="toggle" id="quiet"><span class="box">${state.quietMode ? '☑' : '☐'}</span><span>Quiet hours</span></button>
      <span class="subnote">${state.quietMode ? 'Only blockers and direct mentions interrupt you.' : 'All events use their selected delivery mode.'}</span>
      <div class="cadence"><span class="cadence-label">Digest arrives</span>${CADENCES.map((cadence) => `<button class="chip compact ${state.digestCadence === cadence ? 'active' : ''}" data-cadence="${cadence}">${cadence}</button>`).join('')}</div>
    </section>
    <section class="section"><div class="label">Data &amp; privacy</div>
      <p class="note">Diff hunks, file paths and your criteria go to the Copilot agent you selected. Nothing reaches GitLab until you press Submit — rejected findings and their rationale never leave this machine.</p>
      <button class="toggle" id="share-rates"><span class="box">${state.shareRates ? '☑' : '☐'}</span><span>Share accept/reject rates with your team</span></button>
      <span class="subnote">${state.shareRates ? 'Aggregate rates are shared; finding text and rejection rationale stay local.' : 'Rates remain local to this VS Code profile.'}</span>
    </section>
    <section class="section"><div class="settings-head"><span class="label">settings.json</span><button class="link" id="open-json">Open in editor</button></div>
      <pre>${e(preview)}</pre><span class="hint">Every control above writes here. The access token is not a setting — it lives in the VS Code secret store.</span>
    </section>
  </main>`;
  const script = `
    const vscode = window.verdictVscode;
    const post = (message) => vscode.postMessage(message);
    document.getElementById('rotate-token')?.addEventListener('click', () => post({ type: 'rotateToken' }));
    document.querySelectorAll('[data-notification]').forEach((button) => button.addEventListener('click', () => post({ type: 'setNotification', key: button.dataset.notification, mode: button.dataset.mode })));
    document.getElementById('quiet')?.addEventListener('click', () => post({ type: 'setQuietMode', value: ${!state.quietMode} }));
    document.querySelectorAll('[data-cadence]').forEach((button) => button.addEventListener('click', () => post({ type: 'setDigestCadence', value: button.dataset.cadence })));
    document.getElementById('share-rates')?.addEventListener('click', () => post({ type: 'setShareRates', value: ${!state.shareRates} }));
    document.getElementById('open-json')?.addEventListener('click', () => post({ type: 'openSettingsJson' }));
  `;
  return renderPage({ title: 'Verdict: Settings', nonce, css: CSS, body, script, breadcrumb: { current: 'Settings' } });
}