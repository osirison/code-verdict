import {
  DIGEST_CADENCES,
  NOTIFICATION_MODES,
  type DigestCadence,
  type NotificationMode,
} from '../domain/notifications';
import { escapeHtml, renderPage, type RouteAssets } from './theme';
import type { Vocabulary } from './vocab';

export type { DigestCadence, NotificationMode };

export interface NotificationSettingView {
  key: string;
  label: string;
  hint: string;
  mode: NotificationMode;
}

export interface ContextSettingsView {
  sectionBudget: number;
  totalBudget: number;
  maxLinkedItems: number;
  includeTitle: boolean;
  includeDescription: boolean;
  includeLinkedItems: boolean;
  usageEnabled: boolean;
}

export interface SettingsViewState {
  /** Platform nouns for the active pod's provider — never hardcoded here. */
  vocabulary: Vocabulary;
  instanceUrl: string;
  connectionStatus: string;
  connected: boolean;
  hasToken: boolean;
  quietMode: boolean;
  digestCadence: DigestCadence;
  shareRates: boolean;
  context: ContextSettingsView;
  notifications: NotificationSettingView[];
  /** Where `*.agent.md` definitions are searched, and what each one yielded. */
  agentLocations: AgentLocationView[];
}

export interface AgentLocationView {
  /** The path as configured, or the built-in `.github/agents` entry. */
  label: string;
  /** Built-in roots cannot be removed; only configured ones can. */
  configured: boolean;
  status: 'ok' | 'unreadable';
  /** Agents parsed from it. Zero with status 'ok' just means an empty directory. */
  agentCount: number;
}

/**
 * Spec §11's status line: "connected as @you · api scope · token expires in
 * 42 days" — the expiry segment only when the provider reports one.
 */
export function formatConnectionStatus(status: {
  username?: string;
  scopes?: string[];
  tokenExpiresInDays?: number;
}, fallbackUsername?: string): string {
  const scopes = status.scopes ?? ['unknown'];
  const days = status.tokenExpiresInDays;
  return [
    `connected as @${status.username ?? fallbackUsername ?? 'you'}`,
    `${scopes.join(', ')} scope${scopes.length === 1 ? '' : 's'}`,
    ...(days !== undefined ? [`token expires in ${days} day${days === 1 ? '' : 's'}`] : []),
  ].join(' · ');
}

export type SettingsMessage =
  | { type: 'rotateToken' }
  | { type: 'testConnection' }
  | { type: 'setNotification'; key: string; mode: NotificationMode }
  | { type: 'setQuietMode'; value: boolean }
  | { type: 'setDigestCadence'; value: DigestCadence }
  | { type: 'setShareRates'; value: boolean }
  | {
    type: 'setContextBudget';
    key: 'sectionBudget' | 'totalBudget' | 'maxLinkedItems';
    value: number;
  }
  | {
    type: 'setContextToggle';
    key: 'includeTitle' | 'includeDescription' | 'includeLinkedItems' | 'usageEnabled';
    value: boolean;
  }
  | { type: 'addAgentLocation' }
  | { type: 'removeAgentLocation'; label: string }
  | { type: 'openSettingsJson' };

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
.location { display: flex; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--row); }
.location-path { color: var(--fg-hi); font: 12px/1.3 var(--font-mono); min-width: 0; overflow-wrap: anywhere; }
.location-status { color: var(--fg-dimmer); font-size: 11px; margin-left: auto; flex: none; }
.location-status.bad { color: var(--warn, var(--fg-dim)); }
.link { border: none; background: none; color: var(--link); cursor: pointer; padding: 0; font: 11px/1 var(--font-ui); }
.context-setting { display: flex; align-items: center; gap: 14px; padding: 9px 0; border-bottom: 1px solid var(--row); }
.context-setting .notification-copy { flex: 1; }
.number-input { width: 112px; flex: none; padding: 7px 9px; text-align: right; }
.context-toggles { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px 18px; padding-top: 4px; }
.context-toggle { align-items: flex-start; }
.context-toggle-copy { display: flex; flex-direction: column; gap: 3px; }
pre { margin: 0; border: 1px solid var(--line); border-radius: 6px; background: var(--code); padding: 13px 15px; color: var(--fg); font: 12px/1.75 var(--font-mono); overflow-x: auto; }
`;

/**
 * The connection region (issue #39 follow-up): status, masked token and the
 * two live-check actions. `testConnection` runs only on open and when
 * `#test-connection` is pressed here — never as a side effect of patching
 * this region for an unrelated reason (a token rotation, say), so this
 * markup always reflects whatever the panel last actually checked.
 */
function connectionRegion(state: SettingsViewState): string {
  const e = escapeHtml;
  return `<section class="section"><div class="label">Connection</div><div class="connection">
      <div class="connection-copy"><span class="instance">${e(state.instanceUrl)}</span><span class="status ${state.connected ? 'ok' : ''}">${e(state.connectionStatus)}</span></div>
      <div class="connection-actions"><span class="masked">${state.hasToken ? '••••••••' : 'no token'}</span><button class="btn" id="test-connection">Test connection</button><button class="btn" id="rotate-token">Rotate token</button></div>
    </div></section>`;
}

function notificationsRegion(state: SettingsViewState): string {
  const notifications = state.notifications.map((setting) => `<div class="notification">
    <div class="notification-copy"><span class="notification-name">${escapeHtml(setting.label)}</span><span class="hint">${escapeHtml(setting.hint)}</span></div>
    <div class="segments">${NOTIFICATION_MODES.map((mode) => `<button class="${setting.mode === mode ? `active ${mode === 'Off' ? 'off' : ''}` : ''}" data-notification="${escapeHtml(setting.key)}" data-mode="${mode}">${mode}</button>`).join('')}</div>
  </div>`).join('');
  return `<section class="section"><div class="label">Notifications</div>${notifications}
      <button class="toggle" id="quiet" data-checked="${state.quietMode}"><span class="box">${state.quietMode ? '☑' : '☐'}</span><span>Quiet hours</span></button>
      <span class="subnote">${state.quietMode ? 'Only blockers and direct mentions interrupt you.' : 'All events use their selected delivery mode.'}</span>
      <div class="cadence"><span class="cadence-label">Digest arrives</span>${DIGEST_CADENCES.map((cadence) => `<button class="chip compact ${state.digestCadence === cadence ? 'active' : ''}" data-cadence="${cadence}">${cadence}</button>`).join('')}</div>
    </section>`;
}

/**
 * The agents region (issue #39 follow-up): the searched locations and what
 * each yielded. `addAgentLocation`/`removeAgentLocation` are the two message
 * cases that re-run the filesystem scan (`settings.ts`'s `agentLocationViews`)
 * on their own — the scan is what those actions are *about*, so patching this
 * region without it would show a location that was just added or removed as
 * if nothing happened. That is distinct from the connection test, which never
 * runs off the back of an unrelated message.
 */
function agentsRegion(state: SettingsViewState): string {
  const e = escapeHtml;
  return `<section class="section"><div class="settings-head"><span class="label">Agents</span><button class="link" id="add-location">Add a location…</button></div>
      <p class="subnote">Agents are <code>*.agent.md</code> files. The folders listed below are searched already; add more to search elsewhere.</p>
      ${state.agentLocations
        .map((location) => `<div class="location">
          <span class="location-path">${e(location.label)}</span>
          <span class="location-status ${location.status === 'unreadable' ? 'bad' : ''}">${
            location.status === 'unreadable'
              ? 'could not be read'
              : `${location.agentCount} agent${location.agentCount === 1 ? '' : 's'}`
          }</span>
          ${location.configured ? `<button class="link" data-remove-location="${e(location.label)}">Remove</button>` : ''}
        </div>`)
        .join('')}
      ${state.agentLocations.length === 0 ? '<span class="subnote">No workspace folder is open, so there is nowhere to search.</span>' : ''}
    </section>`;
}

function contextRegion(state: SettingsViewState): string {
  return `<section class="section"><div class="label">Context</div>
      <p class="subnote">Set the limits and starting sources for new reviews. Auto-derived context is intent; attachments and diffs are reviewable evidence.</p>
      <div class="context-setting">
        <label class="notification-copy" for="context-section-budget"><span class="notification-name">Per-section budget</span><span class="hint">Maximum characters from one auto-derived section.</span></label>
        <input class="input number-input" id="context-section-budget" data-context-budget="sectionBudget" type="number" min="1" step="1" value="${state.context.sectionBudget}">
      </div>
      <div class="context-setting">
        <label class="notification-copy" for="context-total-budget"><span class="notification-name">Total budget</span><span class="hint">Maximum characters across auto-derived context; attachments and diffs are separate.</span></label>
        <input class="input number-input" id="context-total-budget" data-context-budget="totalBudget" type="number" min="1" step="1" value="${state.context.totalBudget}">
      </div>
      <div class="context-setting">
        <label class="notification-copy" for="context-max-linked-items"><span class="notification-name">Linked item limit</span><span class="hint">Maximum linked work items included in the prompt.</span></label>
        <input class="input number-input" id="context-max-linked-items" data-context-budget="maxLinkedItems" type="number" min="1" step="1" value="${state.context.maxLinkedItems}">
      </div>
      <div class="context-toggles">
        <button class="toggle context-toggle" data-context-toggle="includeTitle" data-enabled="${state.context.includeTitle}"><span class="box">${state.context.includeTitle ? '☑' : '☐'}</span><span class="context-toggle-copy"><span class="notification-name">Include title</span><span class="hint">Start new reviews with the change request title.</span></span></button>
        <button class="toggle context-toggle" data-context-toggle="includeDescription" data-enabled="${state.context.includeDescription}"><span class="box">${state.context.includeDescription ? '☑' : '☐'}</span><span class="context-toggle-copy"><span class="notification-name">Include description</span><span class="hint">Start new reviews with the change request description.</span></span></button>
        <button class="toggle context-toggle" data-context-toggle="includeLinkedItems" data-enabled="${state.context.includeLinkedItems}"><span class="box">${state.context.includeLinkedItems ? '☑' : '☐'}</span><span class="context-toggle-copy"><span class="notification-name">Include linked work items</span><span class="hint">Start new reviews with linked work items.</span></span></button>
        <button class="toggle context-toggle" data-context-toggle="usageEnabled" data-enabled="${state.context.usageEnabled}"><span class="box">${state.context.usageEnabled ? '☑' : '☐'}</span><span class="context-toggle-copy"><span class="notification-name">Show context usage</span><span class="hint">Estimate use of the selected model's input capacity.</span></span></button>
      </div>
    </section>`;
}

function privacyRegion(state: SettingsViewState): string {
  const e = escapeHtml;
  return `<section class="section"><div class="label">Data &amp; privacy</div>
      <p class="note">The selected agent and model receive diff hunks, file paths, your review criteria, selected attachment contents and paths, and, when enabled, the ${e(state.vocabulary.changeRequestNoun)} title, description, and linked ${e(state.vocabulary.workItemNounPlural)}. Nothing reaches ${e(state.vocabulary.platformName)} until you press Submit — rejected findings and their rationale never leave this machine.</p>
      <button class="toggle" id="share-rates" data-checked="${state.shareRates}"><span class="box">${state.shareRates ? '☑' : '☐'}</span><span>Share accept/reject rates with your team</span></button>
      <span class="subnote">${state.shareRates ? 'Aggregate rates are shared; finding text and rejection rationale stay local.' : 'Rates remain local to this VS Code profile.'}</span>
    </section>`;
}

/** Derived from notifications/quietMode/digestCadence/shareRates — every case that changes one of those patches this region alongside its own. */
function jsonPreviewRegion(state: SettingsViewState): string {
  const preview = JSON.stringify({
    'codeVerdict.notifications': Object.fromEntries(state.notifications.map((setting) => [setting.key, setting.mode])),
    'codeVerdict.notifications.quietMode': state.quietMode,
    'codeVerdict.notifications.digestCadence': state.digestCadence,
    'codeVerdict.context.sectionBudget': state.context.sectionBudget,
    'codeVerdict.context.totalBudget': state.context.totalBudget,
    'codeVerdict.context.maxLinkedItems': state.context.maxLinkedItems,
    'codeVerdict.context.includeTitle': state.context.includeTitle,
    'codeVerdict.context.includeDescription': state.context.includeDescription,
    'codeVerdict.context.includeLinkedItems': state.context.includeLinkedItems,
    'codeVerdict.contextUsage.enabled': state.context.usageEnabled,
    'codeVerdict.shareAcceptRejectRates': state.shareRates,
  }, null, 2);
  return `<section class="section"><div class="settings-head"><span class="label">settings.json</span><button class="link" id="open-json">Open in editor</button></div>
      <pre>${escapeHtml(preview)}</pre><span class="hint">Every control above writes here. The access token is not a setting — it lives in the VS Code secret store.</span>
    </section>`;
}

export const SETTINGS_REGION_IDS = [
  'set-connection',
  'set-notifications',
  'set-agents',
  'set-context',
  'set-privacy',
  'set-json',
] as const;

export type SettingsRegionId = (typeof SETTINGS_REGION_IDS)[number];

/** Every patchable region, from the same helpers the full page uses — one source of markup (issue #39). */
export function renderSettingsRegions(state: SettingsViewState): Record<SettingsRegionId, string> {
  return {
    'set-connection': connectionRegion(state),
    'set-notifications': notificationsRegion(state),
    'set-agents': agentsRegion(state),
    'set-context': contextRegion(state),
    'set-privacy': privacyRegion(state),
    'set-json': jsonPreviewRegion(state),
  };
}

/**
 * Bound once on `document`, not per element (issue #39): a region patch
 * replaces one of the containers above wholesale, which would drop any
 * listener bound to an element inside it. Delegation means the patched
 * markup needs no re-binding at all — every control below matches on
 * `closest()` instead of binding to the element the initial render produced.
 *
 * The quiet-hours and share-rates toggles read their current state off the
 * button's own `data-checked` attribute rather than a module-level variable:
 * the host repaints this region after every change, so the attribute is
 * always current and there is nothing left for a client-side variable to
 * cache (and no way for it to desync from a patch it did not cause).
 */
const SCRIPT = `
  const vscode = window.verdictVscode;
  const post = (m) => vscode.postMessage(m);
  const on = (id, type, extra) => document.addEventListener('click', (ev) => {
    if (!ev.target.closest('#' + id)) return;
    post({ type, ...(extra ?? {}) });
  });
  on('test-connection', 'testConnection');
  on('rotate-token', 'rotateToken');
  document.addEventListener('click', (ev) => {
    const button = ev.target.closest('[data-notification]');
    if (button) post({ type: 'setNotification', key: button.dataset.notification, mode: button.dataset.mode });
  });
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('#quiet');
    if (el) post({ type: 'setQuietMode', value: el.dataset.checked !== 'true' });
  });
  document.addEventListener('click', (ev) => {
    const button = ev.target.closest('[data-cadence]');
    if (button) post({ type: 'setDigestCadence', value: button.dataset.cadence });
  });
  document.addEventListener('change', (ev) => {
    const input = ev.target.closest('[data-context-budget]');
    if (!input) return;
    const value = Number(input.value);
    if (Number.isInteger(value) && value > 0) post({ type: 'setContextBudget', key: input.dataset.contextBudget, value });
  });
  document.addEventListener('click', (ev) => {
    const button = ev.target.closest('[data-context-toggle]');
    if (button) post({ type: 'setContextToggle', key: button.dataset.contextToggle, value: button.dataset.enabled !== 'true' });
  });
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('#share-rates');
    if (el) post({ type: 'setShareRates', value: el.dataset.checked !== 'true' });
  });
  on('open-json', 'openSettingsJson');
  on('add-location', 'addAgentLocation');
  document.addEventListener('click', (ev) => {
    const button = ev.target.closest('[data-remove-location]');
    if (button) post({ type: 'removeAgentLocation', label: button.dataset.removeLocation });
  });
`;

/** This screen's contribution to the resident shell (design D7, task 8.3). */
export const SETTINGS_ROUTE: RouteAssets = { className: 'route-settings', css: CSS, script: SCRIPT };

export function renderSettingsHtml(state: SettingsViewState, nonce: string): string {
  const regions = renderSettingsRegions(state);
  const body = `<main class="wrap">
    <h1>Settings</h1>
    ${SETTINGS_REGION_IDS.map((id) => `<div id="${id}">${regions[id]}</div>`).join('\n    ')}
  </main>`;
  return renderPage({ title: 'Verdict: Settings', nonce, css: CSS, body, script: SCRIPT, breadcrumb: { current: 'Settings' }, routeClass: SETTINGS_ROUTE.className });
}
