import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { renderShellDocument } from './appShell';
import { extractRouteRegions } from './theme';

type MessageHandler = (message: unknown) => void;

export interface AppRoute {
  readonly panel: vscode.WebviewPanel;
  onMessage(handler: MessageHandler): void;
  onLeave(handler: () => void): void;
  /**
   * Fires when this route's document reloads out from under it — "Developer:
   * Reload Webviews", or dragging the Verdict tab into another editor group.
   * VS Code recreates the webview from the *stored* `webview.html`, which a
   * region patch never touches (only `setHtml` does), so the recreated DOM
   * is whatever was last full-rendered — stale once a patch has landed since.
   * Its REGIONS_SCRIPT re-arms and posts `verdictReady` again; arriving
   * while the surface already thought it was ready means exactly that a
   * reload happened, not a duplicate signal. `ready` is reset to false
   * first, so a handler's normal repaint path (refresh()/render()) falls
   * back to a full `setHtml` — which reassigns the whole shell — on its
   * own; no separate "force full" signal needed anywhere (issue #39
   * follow-up).
   */
  onReload(handler: () => void): void;
  /**
   * Shows this route's page. Under the resident shell (design D7) this no
   * longer means assigning the document it is given: when the loaded shell
   * has signalled ready, the route's content and breadcrumb are lifted out
   * of the rendered document (its `renderPage` markers) and patched into
   * `#app-route`/`#app-breadcrumb` — navigation stops paying for a full
   * document per route. When the shell is not ready — first paint, after a
   * reload, after a marker-less fallback page took over — the shell document
   * (the union of every route's CSS and script, `appShell.ts`) is assigned
   * whole with this route's content already in place, and the route is
   * marked not-ready until the new page's REGIONS_SCRIPT echoes back
   * `verdictReady` (#39). A document without the markers
   * (`renderFallbackHtml`'s script-free error pages) is assigned verbatim.
   */
  setHtml(html: string): void;
  /**
   * Patches only the named regions into the currently-loaded page instead of
   * a full document replace — the fix for #39 (navigation waiting on a fetch
   * left the previous screen frozen the whole time).
   *
   * Returns false when the page has not yet signalled ready, and also when
   * `#app-route` currently holds a different route's content (this route was
   * just navigated to, so its region ids are not in the DOM for a patch to
   * find); the caller must fall back to a full `setHtml()` — which itself
   * patches when it can — so readiness is never load-bearing for
   * correctness, only for avoiding an unnecessary full render.
   *
   * A patch queued by a route that is no longer `AppSurface.active` (the
   * reviewer navigated away while the fetch was in flight) is dropped
   * silently and this still returns true: falling back to setHtml() here
   * would repaint whatever screen is now showing with this stale route's
   * html, which is worse than doing nothing.
   */
  postRegions(regions: Record<string, string>): boolean;
}

interface ActiveRoute {
  id: string;
  /** The tab title from `AppSurface.show`, reused as the shell document's <title>. */
  title: string;
  handlers: MessageHandler[];
  leaveHandlers: Array<() => void>;
  /** Fired when a second `verdictReady` arrives while already `ready` (#39 follow-up). */
  reloadHandlers: Array<() => void>;
  back?: () => void;
}

export class AppSurface {
  private static current: AppSurface | undefined;
  private static readonly routeListeners = new Set<(route?: string) => void>();

  static show(id: string, title: string, back?: () => void): AppRoute {
    const surface = AppSurface.current ??= new AppSurface();
    const route = surface.activate(id, title, back);
    return {
      panel: surface.panel,
      onMessage: (handler) => surface.active?.handlers.push(handler),
      onLeave: (handler) => surface.active?.leaveHandlers.push(handler),
      onReload: (handler) => surface.active?.reloadHandlers.push(handler),
      setHtml: (html) => {
        const regions = extractRouteRegions(html);
        if (regions && surface.ready) {
          // The navigation patch (task 8.4): the shell is loaded and armed,
          // so entering a route swaps #app-route and the breadcrumb instead
          // of the incoming route assigning a document. This is the whole
          // point of the resident shell — the union CSS and scripts stay
          // loaded, and only the route's markup crosses the IPC boundary.
          surface.loadedRouteId = route.id;
          // routeKey rides the navigation patch only, never postRegions
          // (task 9.4): it is what lets the page save the departed route's
          // view state and reapply this route's, keyed by the same id the
          // surface routes by. A same-route setHtml carries it too and the
          // page sees no change — deliberately, so a full re-render of the
          // showing screen is a patch like any other, not a route entry.
          void surface.panel.webview.postMessage({
            type: 'verdict:regions',
            routeKey: route.id,
            regions: { 'app-breadcrumb': regions.crumb, 'app-route': regions.route },
          });
          return;
        }
        // Not ready (first paint, post-reload, or a fallback page holds the
        // webview): assign a full document — the shell with this route's
        // content already in place, so nothing waits on a patch the page
        // could not receive yet. A marker-less page (renderFallbackHtml) is
        // assigned verbatim; it carries no REGIONS_SCRIPT, so readiness
        // stays down and the next marked render assigns a fresh shell.
        surface.ready = false;
        surface.loadedRouteId = regions ? route.id : undefined;
        surface.panel.webview.html = regions
          ? renderShellDocument({
            title: route.title,
            nonce: crypto.randomBytes(16).toString('hex'),
            regions,
            routeKey: route.id,
          })
          : html;
      },
      postRegions: (regions) => {
        if (surface.active !== route) return true;
        if (!surface.ready || surface.loadedRouteId !== route.id) return false;
        void surface.panel.webview.postMessage({ type: 'verdict:regions', regions });
        return true;
      },
    };
  }

  static reveal(): boolean {
    if (!AppSurface.current) return false;
    AppSurface.current.panel.reveal();
    return true;
  }

  /**
   * Reveal the surface and post into whatever screen is active (the `? keys`
   * status-bar segment reaches the keyboard overlay this way). Reveal first —
   * posting into a hidden panel would open nothing the user can see.
   */
  static postToActive(message: unknown): boolean {
    const surface = AppSurface.current;
    if (!surface) return false;
    surface.panel.reveal();
    void surface.panel.webview.postMessage(message);
    return true;
  }

  static onDidChangeRoute(listener: (route?: string) => void): vscode.Disposable {
    AppSurface.routeListeners.add(listener);
    return { dispose: () => AppSurface.routeListeners.delete(listener) };
  }

  private readonly panel = vscode.window.createWebviewPanel(
    'codeVerdict.app',
    'Verdict',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  private active?: ActiveRoute;
  /**
   * Whether the loaded document's REGIONS_SCRIPT has armed itself. A
   * property of THIS SURFACE, not of the active route (task 8.3): under the
   * resident shell the document survives navigation, so readiness carried on
   * the route — reset per route change, as it was before D7 — would make the
   * first patch after every navigation report not-ready and fall back to a
   * full assignment, rebuilding the per-route documents the shell exists to
   * remove while appearing to work. Reset only when a document is actually
   * assigned or the webview reports it was recreated.
   */
  private ready = false;
  /**
   * Which route's content currently occupies `#app-route`. Gates
   * `postRegions`: after a navigation the shell is armed but still shows the
   * previous route, so a patch aimed at the incoming route's region ids
   * would find nothing and silently leave the old screen up — the mismatch
   * makes it report not-ready instead, and the setHtml fallback swaps the
   * route in.
   */
  private loadedRouteId?: string;

  private constructor() {
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      if (isReadyMessage(message)) {
        // The armed signal from REGIONS_SCRIPT (#39). Return early like
        // appBack below — never fall through to route handlers, or every
        // page load would also dispatch as a message to whatever screen is
        // active.
        if (this.active) {
          if (this.ready) {
            // A second arrival while already ready is not a duplicate — the
            // document was recreated out from under this route (see
            // AppRoute.onReload above). Reset readiness first so a handler's
            // own repaint falls back to setHtml rather than trusting this
            // fresh, possibly-stale DOM to accept a patch.
            this.ready = false;
            for (const handler of this.active.reloadHandlers) handler();
          } else {
            this.ready = true;
          }
        }
        return;
      }
      if (isBackMessage(message)) {
        this.active?.back?.();
        return;
      }
      for (const handler of this.active?.handlers ?? []) handler(message);
    });
    this.panel.onDidDispose(() => {
      this.leaveActiveRoute();
      AppSurface.current = undefined;
      AppSurface.notifyRoute();
    });
  }

  /**
   * Switches the active route. Deliberately does NOT touch `this.ready`
   * (task 8.4): the shell document survives the route change, so the
   * incoming route's first render — every screen renders immediately on
   * entry — goes through its `setHtml`, which patches `#app-route` and the
   * breadcrumb into the armed shell instead of assigning a document. The
   * `loadedRouteId` mismatch is what routes that try `postRegions` first
   * bounce off, into that same setHtml fallback.
   */
  private activate(id: string, title: string, back?: () => void): ActiveRoute {
    if (this.active?.id !== id) {
      this.leaveActiveRoute();
      this.active = { id, title, handlers: [], leaveHandlers: [], reloadHandlers: [], back };
    } else {
      this.active.back = back;
      this.active.title = title;
    }
    this.panel.title = title;
    this.panel.reveal(vscode.ViewColumn.One, true);
    AppSurface.notifyRoute(id.split(':')[0]);
    return this.active;
  }

  private static notifyRoute(route?: string): void {
    for (const listener of AppSurface.routeListeners) listener(route);
  }

  private leaveActiveRoute(): void {
    const route = this.active;
    this.active = undefined;
    for (const handler of route?.leaveHandlers ?? []) handler();
  }
}

function isBackMessage(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'type' in message
    && (message as { type?: unknown }).type === 'appBack';
}

function isReadyMessage(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'type' in message
    && (message as { type?: unknown }).type === 'verdictReady';
}