/**
 * The Verdict webview design system — the POC's design tokens
 * (`spec/prototypes/GitLab AI Review - Prototype.dc.html` :root block)
 * verbatim, so every screen resolves pixel-identical to the prototype.
 *
 * Product decision (overriding the README's theme-variable rule): the POC
 * palette is canonical. Host theme classes do not replace product colors;
 * alternate Verdict themes require an explicit product-level selection.
 *
 * Type: UI text uses the system stack; code, ids, paths, counts and
 * metadata use JetBrains Mono like the POC, falling back to the user's
 * editor font when it is not installed (no font is bundled).
 */

export const VERDICT_TOKENS_CSS = `
:root {
  /* Surfaces — POC dark set, verbatim */
  --bg: #1f1f1f;
  --bg2: #181818;
  --bg3: #252525;
  --card: #242424;
  --code: #141414;
  --row: #232323;
  /* Lines */
  --line: #2b2b2b;
  --line2: #3c3c3c;
  --line3: #4a4a4a;
  --hover: #383838;
  /* Text */
  --fg-max: #f0f0f0;
  --fg-hi: #e8e8e8;
  --fg: #cccccc;
  --fg2: #bdbdbd;
  --fg-dim: #9d9d9d;
  --fg-dim2: #8b8b8b;
  --fg-dimmer: #6e7681;
  --gutter: #5a5a5a;
  --link: #4daafc;
  /* Accents */
  --accent: #0078d4;
  --accent-h: #1a86e0;
  --accent-fg: #ffffff;
  --sel: #04395e;
  --sel-soft: #04395e33;
  --brand: #fc6d26;
  --brand-h: #ff8144;
  --agent: #a371f7;
  --agent-t: #a371f722;
  --agent-b: #a371f755;
  --agent-f: #a371f70f;
  /* Semantic */
  --sev-blocker: #f85149;
  --sev-blocker-t: #f8514922;
  --sev-blocker-b: #f8514966;
  --sev-major: #d29922;
  --sev-major-t: #d2992222;
  --sev-minor: #4a9eff;
  --sev-minor-t: #4a9eff22;
  --nit-t: #8b8b8b22;
  --ok: #3fb950;
  --ok-t: #3fb95022;
  --ok-strong: #238636;
  --ok-strong-h: #2ea043;
  --ok-strong-t: #23863622;
  --add-bg: #1b3a24;
  --add-fg: #8ddaa0;
  --del-bg: #3a1e1e;
  --del-fg: #f0a5a2;
  /* Type */
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", var(--vscode-editor-font-family, ui-monospace), monospace;
}
/* POC light theme, verbatim ([data-theme="light"] in the prototype). */
[data-verdict-theme="light"] {
  --bg: #ffffff;
  --bg2: #f3f3f3;
  --bg3: #e8e8e8;
  --card: #fafafa;
  --code: #f8f8f8;
  --row: #ececec;
  --line: #e0e0e0;
  --line2: #cecece;
  --line3: #b8b8b8;
  --hover: #dcdcdc;
  --fg-max: #111111;
  --fg-hi: #1f1f1f;
  --fg: #3b3b3b;
  --fg2: #4a4a4a;
  --fg-dim: #616161;
  --fg-dim2: #595959;
  --fg-dimmer: #595959;
  --gutter: #a8a8a8;
  --link: #0066bf;
  --sel: #cce4f7;
  --sel-soft: #cce4f755;
  --brand: #b8341d;
  --brand-h: #d14526;
  --agent: #6b3fc7;
  --agent-t: #6b3fc71f;
  --agent-b: #6b3fc766;
  --agent-f: #6b3fc70d;
  --sev-blocker: #b3252b;
  --sev-blocker-t: #b3252b1f;
  --sev-blocker-b: #b3252b66;
  --sev-major: #8a6100;
  --sev-major-t: #8a61001f;
  --sev-minor: #0b62c4;
  --sev-minor-t: #0b62c41f;
  --nit-t: #59595922;
  --ok: #116329;
  --ok-t: #1163291f;
  --ok-strong: #116329;
  --ok-strong-h: #1a7f37;
  --ok-strong-t: #1163291f;
  --add-bg: #e6ffec;
  --add-fg: #116329;
  --del-bg: #ffebe9;
  --del-fg: #a40e26;
}
`;

export const VERDICT_BASE_CSS = `
* { box-sizing: border-box; margin: 0; }
body {
  background: #0a0a0a;
  color: var(--fg);
  font-family: var(--font-ui);
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
  padding: 0;
}
.verdict-app { min-height: 100vh; background: var(--bg); color: var(--fg); }
.app-breadcrumb {
  height: 38px; display: flex; align-items: center; gap: 7px; padding: 0 18px;
  border-bottom: 1px solid var(--line); background: var(--bg2);
  color: var(--fg-dim); font-size: 11.5px;
}
.app-back {
  display: inline-flex; align-items: center; gap: 6px; border: 0; padding: 4px 2px;
  background: none; color: var(--link); font: 500 11.5px/1 var(--font-ui); cursor: pointer;
}
.app-back:hover { color: var(--fg-hi); }
.app-crumb-separator { color: var(--fg-dimmer); }
.app-crumb-current { color: var(--fg2); }
.app-content { min-height: calc(100vh - 38px); }
a { color: var(--link); text-decoration: none; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--line2); border-radius: 5px; }
::-webkit-scrollbar-track { background: transparent; }
/* Three animations, each deliberate (spec: tool, not showcase): tin/spin for
   motion, skel-pulse for the loading placeholders below (issue #39). */
@keyframes tin { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes skel-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }

/*
 * Loading-skeleton placeholder (issue #39): a screen's first paint, before
 * the fetch that would otherwise leave the previous screen frozen on
 * navigation. Only the shared look lives here — callers size it with a CSS
 * class in their own nonce'd CSS const, never a style attribute: this
 * page's CSP authorises nonce'd style elements only, and a nonce never
 * covers a style attribute, so an inline size here silently collapses to
 * zero (issue #45).
 */
.skel { display: inline-block; background: var(--bg3); border: 1px solid var(--line2); border-radius: 4px; color: transparent; animation: skel-pulse 1.4s ease-in-out infinite; }

.mono { font-family: var(--font-mono); }
.dim { color: var(--fg-dim); }
.dimmer { color: var(--fg-dimmer); }
.ok { color: var(--ok); }
.bad { color: var(--sev-blocker); }
.warn { color: var(--sev-major); }
.info { color: var(--sev-minor); }
.run { color: var(--sev-minor); }
.agent-fg { color: var(--agent); }

/* 10px/500 uppercase tracked section label */
.section-label {
  font-size: 10px; font-weight: 500; text-transform: uppercase;
  letter-spacing: .09em; color: var(--fg-dimmer);
}

/* Buttons: 4-5px radius, hover lightens one step */
.btn {
  font-family: var(--font-ui); font-size: 12px; cursor: pointer;
  border-radius: 5px; padding: 6px 14px; border: 1px solid transparent;
  background: var(--line); color: var(--fg-hi); border-color: var(--line2);
}
.btn:hover { background: var(--hover); }
.btn-accent { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
.btn-accent:hover { background: var(--accent-h); }
.btn-brand { background: var(--brand); color: #fff; border-color: transparent; }
.btn-brand:hover { background: var(--brand-h); }
.btn-ok { background: var(--ok-strong); color: #fff; border-color: transparent; }
.btn-ok:hover { background: var(--ok-strong-h); }
.btn-danger { background: var(--line); color: var(--sev-blocker); border-color: var(--sev-blocker); }
.btn-danger:hover { background: var(--sev-blocker-t); }
.btn[disabled], .btn-inert { background: var(--line); color: var(--fg-dimmer); border-color: transparent; cursor: default; }

/* Capsule chips (presets, filters): 6px/11px padding, 14px radius */
.chip {
  display: inline-block; font-size: 11px; color: var(--fg-dim);
  padding: 6px 11px; border-radius: 14px; border: 1px solid var(--line2);
  background: none; cursor: pointer; font-family: var(--font-ui);
}
.chip:hover { border-color: var(--accent); }
.chip.active { background: var(--accent); color: var(--accent-fg); border-color: transparent; }

/* Small state pills: 5px/8px padding, 3px radius */
.pill {
  display: inline-block; font-family: var(--font-mono); font-size: 11px;
  padding: 5px 8px; border-radius: 3px; color: var(--fg-dimmer);
  background: var(--nit-t);
}
.pill-warn { color: var(--sev-major); background: var(--sev-major-t); }
.pill-bad { color: var(--sev-blocker); background: var(--sev-blocker-t); }
.pill-ok { color: var(--ok); background: var(--ok-t); }
.pill-agent { color: var(--agent); background: var(--agent-t); }
.pill-info { color: var(--sev-minor); background: var(--sev-minor-t); }

/* Severity chips: 9.5px/600 uppercase, .07em tracking, 5px/7px padding */
.sev {
  display: inline-block; font-family: var(--font-mono); font-size: 9.5px;
  font-weight: 600; text-transform: uppercase; letter-spacing: .07em;
  padding: 5px 7px; border-radius: 3px;
}
.sev-blocker { color: var(--sev-blocker); background: var(--sev-blocker-t); }
.sev-major { color: var(--sev-major); background: var(--sev-major-t); }
.sev-minor { color: var(--sev-minor); background: var(--sev-minor-t); }
.sev-nit { color: var(--fg-dim2); background: var(--nit-t); }

/* Cards: 1px line border, 6px radius */
.card { border: 1px solid var(--line); border-radius: 6px; background: var(--card); }

/* Inputs: 1px line2, 5px radius, bg2, 9px/11px padding */
.input {
  font-family: var(--font-mono); font-size: 12.5px; color: var(--fg-hi);
  background: var(--bg2); border: 1px solid var(--line2); border-radius: 5px;
  padding: 9px 11px; outline: none; width: 100%;
}
.input:focus { border-color: var(--accent); }

/* Segmented control container */
.seg { display: inline-flex; background: var(--bg3); border-radius: 5px; padding: 2px; gap: 2px; }
.seg button {
  border: none; background: none; color: var(--fg-dim); font-size: 11px;
  font-family: var(--font-mono); padding: 4px 10px; border-radius: 4px; cursor: pointer;
}
.seg button.active { background: var(--accent); color: var(--accent-fg); }

/* Key caps for the keyboard overlay / hints */
.kbd {
  display: inline-block; min-width: 20px; text-align: center;
  font-family: var(--font-mono); font-size: 11px; font-weight: 500;
  background: var(--bg2); border: 1px solid var(--line2); border-radius: 4px;
  padding: 2px 6px; color: var(--fg2);
}
`;

/**
 * The `?` keyboard overlay (spec §12): scrim over the whole window, a 720px
 * panel, four groups in a 2-column grid. Shared by every full-page screen via
 * renderPage — `?` opens it anywhere, Esc or a scrim click dismisses it, and
 * the status bar's "? keys" segment reaches it with a `verdict:showKeys`
 * message. Key caps stay the spec's glyphs (⌘, ⇧, ↩) verbatim — the
 * prototype is canonical.
 */
const KEYS_CSS = `
.keys-overlay { position: fixed; inset: 0; z-index: 40; display: flex; align-items: flex-start; justify-content: center; padding: 36px; background: rgba(0,0,0,.58); }
.keys-overlay[hidden] { display: none; }
.keys-panel { width: 720px; max-width: 100%; max-height: 100%; overflow-y: auto; background: var(--bg3); border: 1px solid var(--line2); border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,.6); animation: tin .18s ease-out; }
.keys-head { display: flex; align-items: baseline; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--line2); }
.keys-title { color: var(--fg-max); font-size: 13px; font-weight: 600; }
.keys-note { flex: 1; color: var(--fg-dim); font-size: 11.5px; }
.keys-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px 28px; padding: 16px 18px 20px; }
.keys-group { display: flex; flex-direction: column; gap: 7px; }
.keys-row { display: flex; align-items: center; gap: 10px; }
.keys-cap { flex: none; min-width: 74px; text-align: center; font: 500 11px/1 var(--font-mono); background: var(--bg2); border: 1px solid var(--line2); border-radius: 4px; padding: 5px 8px; color: var(--fg2); }
.keys-label { font-size: 12px; color: var(--fg); }
.keys-hint { font-size: 10.5px; color: var(--fg-dimmer); }
`;

const KEYS_GROUPS: ReadonlyArray<{
  group: string;
  rows: ReadonlyArray<{ cap: string; label: string; hint?: string }>;
}> = [
  {
    group: 'Triage',
    rows: [
      { cap: 'A', label: 'Accept', hint: 'applies the suggested fix when there is one' },
      { cap: '⇧A', label: 'Accept comment-only' },
      { cap: 'R', label: 'Reject' },
      { cap: 'S', label: 'Skip' },
      { cap: 'J / K', label: 'Next / previous' },
      { cap: '1–4', label: 'Jump to severity' },
      { cap: 'U', label: 'Undo' },
    ],
  },
  {
    group: 'Agent',
    rows: [
      { cap: '⌘↩', label: 'Ask' },
      { cap: 'E', label: 'Explain' },
      { cap: 'F', label: 'Show fix' },
      { cap: '⇧F', label: 'Find similar' },
    ],
  },
  {
    group: 'Navigation',
    rows: [
      { cap: '⌘1 ⌘2 ⌘3', label: 'Mode' },
      { cap: 'O', label: 'Open in editor' },
      { cap: 'G then D', label: 'Dashboard' },
      { cap: 'G then P', label: 'Posted reviews' },
      { cap: '⌘↵', label: 'Generate summary' },
    ],
  },
  {
    group: 'Everywhere',
    rows: [
      { cap: '?', label: 'Help' },
      { cap: '⌘⇧P', label: 'Palette' },
      { cap: 'Esc', label: 'Close' },
    ],
  },
];

function renderKeysOverlay(): string {
  const groups = KEYS_GROUPS.map(
    ({ group, rows }) => `<section class="keys-group"><div class="section-label">${escapeHtml(group)}</div>${rows
      .map(
        (row) => `<div class="keys-row"><span class="keys-cap">${escapeHtml(row.cap)}</span><span class="keys-label">${escapeHtml(row.label)}</span>${row.hint ? `<span class="keys-hint">${escapeHtml(row.hint)}</span>` : ''}</div>`,
      )
      .join('')}</section>`,
  ).join('');
  return `<div class="keys-overlay" id="verdict-keys" hidden role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
    <div class="keys-panel" id="verdict-keys-panel" tabindex="-1">
      <header class="keys-head"><span class="keys-title">Keyboard</span><span class="keys-note">shortcuts apply when the review tab has focus</span><span class="kbd">Esc</span></header>
      <div class="keys-grid">${groups}</div>
    </div>
  </div>`;
}

/**
 * Capture-phase on window so the open overlay swallows every key before any
 * screen-level keydown map — a triage verdict must not fire invisibly
 * behind the scrim — and `?` works on screens that bind no keys.
 * A scrim click closes; clicks on the panel itself do not.
 */
const KEYS_SCRIPT = `
;(() => {
  const overlay = document.getElementById('verdict-keys');
  if (!overlay) return;
  const show = () => { overlay.hidden = false; document.getElementById('verdict-keys-panel')?.focus(); };
  const hide = () => { overlay.hidden = true; };
  window.verdictKeysShow = show;
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) hide(); });
  window.addEventListener('message', (ev) => { if (ev.data && ev.data.type === 'verdict:showKeys') show(); });
  window.addEventListener('keydown', (ev) => {
    if (!overlay.hidden) {
      if (ev.key === 'Escape') hide();
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (ev.key !== '?' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    if (t instanceof HTMLElement && t.closest('input, textarea, select, [contenteditable]')) return;
    ev.preventDefault();
    ev.stopPropagation();
    show();
  }, true);
})();
`;

/**
 * Shared region-patch mechanism (issue #39): lets a panel replace a piece of
 * an already-loaded page instead of the whole document, so the previous
 * screen never has to sit frozen for a whole fetch on navigation. Bundled
 * into every full-page bootstrap (see `renderPage`) — it is inert until an
 * `AppRoute.postRegions` call actually posts a `verdict:regions` message.
 *
 * `verdictReady` tells `AppSurface` this listener is armed; until it lands,
 * `postRegions` reports "not ready" and the caller falls back to a full
 * `setHtml`, so readiness is never load-bearing for correctness.
 */
export const REGIONS_SCRIPT = `
;(() => {
  window.verdictVscode.postMessage({ type: 'verdictReady' });

  // The DOM state a patch would otherwise discard (design D8, task 9.1):
  // window scroll, per-container scroll and <details> expansion, captured
  // from elements carrying a stable id — an id is the only handle that can
  // match an element to its rebuilt self after innerHTML is replaced, so a
  // stateful element without one is simply not restored (the convention is
  // documented in docs/ARCHITECTURE.md).
  const captureView = () => {
    const open = {};
    for (const el of document.querySelectorAll('details[id]')) open[el.id] = el.open;
    const scrolls = {};
    for (const el of document.querySelectorAll('[id]')) {
      if (el.scrollTop || el.scrollLeft) scrolls[el.id] = { t: el.scrollTop, l: el.scrollLeft };
    }
    return { x: window.scrollX, y: window.scrollY, open, scrolls };
  };
  // Restore order is load-bearing: details first (opening one changes the
  // layout everything after lands in), then focus (focus() scrolls ancestor
  // containers to reveal its element, which would undo a container restore
  // that ran earlier), then container scrolls, then window scroll last.
  // Returns whether every restore verifiably landed — false when an id is
  // missing (a loading skeleton not yet holding the real content) or the
  // window scroll clamped against a document still too short for it.
  const applyView = (view, focusId, selStart, selEnd) => {
    let landed = true;
    for (const id of Object.keys(view.open)) {
      const el = document.getElementById(id);
      if (el) el.open = view.open[id]; else landed = false;
    }
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus();
        if (selStart != null && selEnd != null) {
          try { el.setSelectionRange(selStart, selEnd); } catch {}
        }
      }
    }
    for (const id of Object.keys(view.scrolls)) {
      const el = document.getElementById(id);
      if (el) { el.scrollTop = view.scrolls[id].t; el.scrollLeft = view.scrolls[id].l; } else landed = false;
    }
    window.scrollTo(view.x, view.y);
    if (window.scrollX !== view.x || window.scrollY !== view.y) landed = false;
    return landed;
  };

  // Per-route view state (design D8, task 9.4): saved when a navigation
  // patch swaps #app-route away from a route, reapplied when one swaps back,
  // so returning to a screen restores its scroll position and expanded
  // sections instead of resetting to top. Keyed by the routeKey AppSurface
  // sends on exactly those patches (the shell document stamps the first
  // route's key on #app-route), so a patch can never restore one route's
  // state onto another. Capped because the changeset routes are keyed per
  // changeset id — without a bound the map would grow with every changeset
  // visited for the life of the panel. Oldest-saved is evicted; re-saving on
  // each leave keeps a route the reviewer actually returns to alive.
  const ROUTE_STATES_MAX = 8;
  const routeStates = new Map();
  let currentRoute = document.getElementById('app-route')?.dataset.routeKey;
  // A route entered through a loading skeleton cannot take its saved state
  // yet: the containers are not in the DOM and the document is too short
  // for the scroll. The snapshot is held pending and reapplied on the next
  // patch for the same route (the content render), then dropped — a hard
  // bound, so a patch minutes later can never yank the viewport back to an
  // entry-time position the reviewer has since scrolled away from.
  let pendingView;

  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!data || data.type !== 'verdict:regions') return;
    const entering = data.routeKey !== undefined && data.routeKey !== currentRoute;
    if (entering && currentRoute !== undefined) {
      routeStates.delete(currentRoute);
      routeStates.set(currentRoute, captureView());
      if (routeStates.size > ROUTE_STATES_MAX) routeStates.delete(routeStates.keys().next().value);
    }
    // A patch replaces innerHTML wholesale, which would otherwise drop focus
    // to <body> and send the next keystroke to a screen's keyboard handler
    // as though it were a real shortcut (the other half of #38 — a full
    // re-render used to do exactly this). Snapshot focus/selection and the
    // view state above, patch, then restore them.
    //
    // Restore focus and selection ONLY — never .value: the re-rendered value
    // is the panel's own state (e.g. a regenerated summary), and restoring a
    // stale typed value would clobber it. The host holds every editable's
    // in-progress text (task 9.3), so what the patch paints is already
    // current and no value restore is ever needed.
    const active = document.activeElement;
    const focusId = active && active.id ? active.id : undefined;
    let selStart, selEnd;
    try { selStart = active ? active.selectionStart : undefined; selEnd = active ? active.selectionEnd : undefined; } catch {}
    const before = entering ? undefined : captureView();
    for (const id of Object.keys(data.regions)) {
      // Not every region id exists on every screen (e.g. a page with no
      // breadcrumb) — skip rather than throw, and let the rest of the batch
      // still land.
      const el = document.getElementById(id);
      if (el) el.innerHTML = data.regions[id];
    }
    if (entering) {
      currentRoute = data.routeKey;
      document.getElementById('app-route')?.setAttribute('data-route-key', data.routeKey);
      // No focus restore across a route change: the departed screen's field
      // is gone, and a coincidentally shared id would focus a stranger. A
      // route never seen (or evicted) starts at the top, exactly as a fresh
      // document used to.
      const saved = routeStates.get(data.routeKey);
      pendingView = saved && !applyView(saved) ? saved : undefined;
      if (!saved) window.scrollTo(0, 0);
      return;
    }
    if (pendingView) {
      applyView(pendingView, focusId, selStart, selEnd);
      pendingView = undefined;
    } else {
      applyView(before, focusId, selStart, selEnd);
    }
  });
})();
`;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One screen's static assets, as the resident shell (design D7) needs them:
 * the union of every route's `css` and `script` is baked into one document
 * per panel lifetime, so both must be safe to coexist with every other
 * screen's — `css` is scoped under `className` (see `scopeRouteCss`), and
 * `script` must consist of `document`-level delegated listeners that match
 * nothing while the screen's markup is absent from `#app-route`.
 */
export interface RouteAssets {
  /** The ancestor class `css` is scoped under and the route content's wrapper carries. */
  className: string;
  css: string;
  script: string;
}

/**
 * Scopes a route's CSS under its ancestor class (task 8.2) with native CSS
 * nesting: `header { … }` inside `.route-dashboard { … }` resolves as
 * `.route-dashboard header { … }`. Without this, unioning the screens' CSS
 * into the resident shell (D7) lets same-named selectors fight — the
 * dashboard's and the posted screen's `.thead` disagree on column counts,
 * their `.skel-title`s on size, tuning's and onboarding's `h1` on font size.
 * Relaxed nesting (bare element selectors like `header`) needs Chromium 120;
 * the extension floor is VS Code 1.96, whose runtime is well past that.
 * Specificity only ever gains the one ancestor class, uniformly, so no
 * route rule can start losing to the shared base CSS it used to beat.
 */
export function scopeRouteCss(className: string, css: string): string {
  return `.${className} {\n${css}\n}`;
}

/**
 * Structural markers `renderPage` places around the two per-route regions of
 * every full-page document, so `AppSurface` can lift the route's content out
 * of the document a screen rendered and patch it into the resident shell
 * (D7) instead of assigning a whole document per navigation. HTML comments:
 * they survive an innerHTML round-trip harmlessly, and content cannot forge
 * one — every renderer escapes `<` before it could spell a comment open.
 */
const CRUMB_START = '<!--verdict:crumb-->';
const CRUMB_END = '<!--/verdict:crumb-->';
const ROUTE_START = '<!--verdict:route-->';
const ROUTE_END = '<!--/verdict:route-->';

/** The two shell regions a navigation swaps: the breadcrumb container and the route body. */
export interface RouteRegions {
  crumb: string;
  route: string;
}

/**
 * Recovers the swappable regions from a `renderPage` document. Returns
 * undefined for a document without the markers (`renderFallbackHtml`'s
 * script-free error pages), which callers must assign whole — those pages
 * carry no REGIONS_SCRIPT, so a patch could never reach them anyway.
 */
export function extractRouteRegions(html: string): RouteRegions | undefined {
  const crumbStart = html.indexOf(CRUMB_START);
  const crumbEnd = html.indexOf(CRUMB_END);
  const routeStart = html.indexOf(ROUTE_START);
  const routeEnd = html.indexOf(ROUTE_END);
  if (crumbStart === -1 || crumbEnd <= crumbStart || routeStart <= crumbEnd || routeEnd <= routeStart) {
    return undefined;
  }
  return {
    crumb: html.slice(crumbStart + CRUMB_START.length, crumbEnd),
    route: html.slice(routeStart + ROUTE_START.length, routeEnd),
  };
}

/**
 * The ‹ back control, delegated on `document` rather than bound to the
 * element (task 8.4): under the resident shell a navigation patches the
 * breadcrumb container's innerHTML, which silently drops any listener bound
 * to the old `#app-back` node — the button would go dead after the first
 * route change. Registered on every full page, breadcrumb or not, because
 * the shell outlives the route that first painted it: a breadcrumb patched
 * in later must already be wired.
 */
const APP_BACK_SCRIPT = `document.addEventListener('click',(ev)=>{if(ev.target.closest('#app-back'))window.verdictVscode.postMessage({type:'appBack'});});`;

/**
 * Codicons for the extension chrome (issue #6). A webview gets no icon font
 * for free and its CSP blocks remote ones, so the caller passes the bundled
 * stylesheet's webview URI plus the webview's own `cspSource`; both style-src
 * and font-src have to admit that source for the font to load at all.
 */
export interface CodiconAssets {
  styleUri: string;
  cspSource: string;
}

/**
 * Full webview document with the strict CSP and the design system inlined.
 *
 * Every non-embedded page shares the resident shell's structure (task 8.2):
 * the breadcrumb lives in `#app-breadcrumb` and the route's content in
 * `#app-route`, both marker-wrapped so `AppSurface` can lift them out of
 * this document and patch them into the already-loaded shell instead of
 * assigning a new document per navigation (D7).
 */
export function renderPage(opts: {
  title: string;
  nonce: string;
  css: string;
  body: string;
  script?: string;
  breadcrumb?: { parent?: string; current: string };
  /**
   * Scopes `css` under this ancestor class and wraps `body` in a div
   * carrying it (task 8.2), so the page's rules and markup stay well-formed
   * for the CSS/script union the resident shell is built from. Every
   * full-page screen passes its `RouteAssets.className` here.
   */
  routeClass?: string;
  /**
   * Pre-rendered breadcrumb container content, passed through verbatim in
   * place of `breadcrumb` — for `appShell.ts`, which re-hosts a breadcrumb
   * extracted from a route's own document and has no parts to rebuild it
   * from. Wins over `breadcrumb` when both are given.
   */
  breadcrumbHtml?: string;
  /**
   * Stamped on `#app-route` as `data-route-key` so REGIONS_SCRIPT knows
   * which route's content the document loaded with (task 9.4): the first
   * navigation away must save that route's view state under its own key,
   * and without the stamp the state of everything before the first
   * route-keyed patch would be lost. Passed only by `appShell.ts`, which is
   * the one caller that knows the `AppSurface` route id.
   */
  routeKey?: string;
  embedded?: boolean;
  /**
   * Opt an `embedded` page into REGIONS_SCRIPT and its `verdictReady`
   * handshake (issue #46 task 2.5). Every non-embedded page already gets it
   * unconditionally below; an embedded one otherwise does not, because the
   * only embedded caller today (the sidebar `WebviewView`) predates region
   * patching. Gated behind its own flag rather than folded into `embedded`
   * so a future embedded caller that has no use for it is unaffected.
   */
  regions?: boolean;
  codicons?: CodiconAssets;
}): string {
  const breadcrumb = opts.breadcrumb
    ? `<nav class="app-breadcrumb" aria-label="Breadcrumb"><button class="app-back" id="app-back" type="button">‹ ${escapeHtml(opts.breadcrumb.parent ?? 'Dashboard')}</button><span class="app-crumb-separator">/</span><span class="app-crumb-current" id="app-crumb-current">${escapeHtml(opts.breadcrumb.current)}</span></nav>`
    : '';
  const crumbContent = opts.breadcrumbHtml ?? breadcrumb;
  const routeContent = opts.routeClass ? `<div class="${opts.routeClass}">${opts.body}</div>` : opts.body;
  const routeKeyAttr = opts.routeKey ? ` data-route-key="${escapeHtml(opts.routeKey)}"` : '';
  const body = opts.embedded
    ? opts.body
    : `<main class="verdict-app"><div id="app-breadcrumb">${CRUMB_START}${crumbContent}${CRUMB_END}</div><div class="app-content" id="app-route"${routeKeyAttr}>${ROUTE_START}${routeContent}${ROUTE_END}</div></main>${renderKeysOverlay()}`;
  const keysScript = opts.embedded ? '' : KEYS_SCRIPT;
  const regionsScript = opts.embedded ? (opts.regions ? REGIONS_SCRIPT : '') : REGIONS_SCRIPT;
  const backScript = opts.embedded ? '' : APP_BACK_SCRIPT;
  // REGIONS_SCRIPT needs the vscode API to post `verdictReady`, so acquire it
  // for every full (non-embedded) page — not only when the caller supplies
  // its own script or a breadcrumb, as before #39 — and for an embedded page
  // that opted into regions, which the sidebar does. Without that last arm an
  // embedded caller passing `regions: true` and no script of its own emits
  // REGIONS_SCRIPT with no `window.verdictVscode` to post `verdictReady`
  // through: it throws, never arms, and because "not ready" falls back to a
  // full assignment the screen degrades to rebuilding itself on every change
  // with nothing anywhere reporting why.
  const bootstrap = opts.script || opts.breadcrumb || opts.regions || !opts.embedded
    ? `window.verdictVscode=acquireVsCodeApi();${backScript}${opts.script ?? ''}${keysScript}${regionsScript}`
    : `${keysScript}${regionsScript}`;
  const script = bootstrap ? `<script nonce="${opts.nonce}">${bootstrap}</script>` : '';
  const css = opts.routeClass ? scopeRouteCss(opts.routeClass, opts.css) : opts.css;
  const codicons = opts.codicons;
  const styleSrc = codicons ? `'nonce-${opts.nonce}' ${codicons.cspSource}` : `'nonce-${opts.nonce}'`;
  const fontSrc = codicons ? ` font-src ${codicons.cspSource};` : '';
  const codiconLink = codicons
    ? `\n<link rel="stylesheet" href="${escapeHtml(codicons.styleUri)}">`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${styleSrc}; script-src 'nonce-${opts.nonce}';${fontSrc}">${codiconLink}
<style nonce="${opts.nonce}">${VERDICT_TOKENS_CSS}${VERDICT_BASE_CSS}${opts.embedded ? '' : KEYS_CSS}${css}</style>
<title>${escapeHtml(opts.title)}</title>
</head>
<body>
${body}
${script}
</body>
</html>`;
}
