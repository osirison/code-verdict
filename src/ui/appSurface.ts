import * as vscode from 'vscode';

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
   * while this route already thought it was ready means exactly that a
   * reload happened, not a duplicate signal. `ready` is reset to false
   * first, so a handler's normal repaint path (refresh()/render()) falls
   * back to a full `setHtml` on its own — no separate "force full" signal
   * needed anywhere (issue #39 follow-up).
   */
  onReload(handler: () => void): void;
  /** Assigns the full page and marks the route not-ready for a region patch,
   * until the new page's REGIONS_SCRIPT echoes back `verdictReady` (#39). */
  setHtml(html: string): void;
  /**
   * Patches only the named regions into the currently-loaded page instead of
   * a full document replace — the fix for #39 (navigation waiting on a fetch
   * left the previous screen frozen the whole time).
   *
   * Returns false when the page has not yet signalled ready; the caller must
   * fall back to a full `setHtml()` — readiness is never load-bearing for
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
  handlers: MessageHandler[];
  leaveHandlers: Array<() => void>;
  /** Fired when a second `verdictReady` arrives while already `ready` (#39 follow-up). */
  reloadHandlers: Array<() => void>;
  back?: () => void;
  /** Whether the currently-loaded page's REGIONS_SCRIPT has armed itself. */
  ready: boolean;
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
        route.ready = false;
        surface.panel.webview.html = html;
      },
      postRegions: (regions) => {
        if (surface.active !== route) return true;
        if (!route.ready) return false;
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

  private constructor() {
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      if (isReadyMessage(message)) {
        // The armed signal from REGIONS_SCRIPT (#39). Return early like
        // appBack below — never fall through to route handlers, or every
        // page load would also dispatch as a message to whatever screen is
        // active.
        if (this.active) {
          if (this.active.ready) {
            // A second arrival while already ready is not a duplicate — the
            // document was recreated out from under this route (see
            // AppRoute.onReload above). Reset readiness first so a handler's
            // own repaint falls back to setHtml rather than trusting this
            // fresh, possibly-stale DOM to accept a patch.
            this.active.ready = false;
            for (const handler of this.active.reloadHandlers) handler();
          } else {
            this.active.ready = true;
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

  private activate(id: string, title: string, back?: () => void): ActiveRoute {
    if (this.active?.id !== id) {
      this.leaveActiveRoute();
      this.active = { id, handlers: [], leaveHandlers: [], reloadHandlers: [], back, ready: false };
    } else {
      this.active.back = back;
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