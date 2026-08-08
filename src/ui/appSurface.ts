import * as vscode from 'vscode';

type MessageHandler = (message: unknown) => void;

export interface AppRoute {
  readonly panel: vscode.WebviewPanel;
  onMessage(handler: MessageHandler): void;
  onLeave(handler: () => void): void;
}

interface ActiveRoute {
  id: string;
  handlers: MessageHandler[];
  leaveHandlers: Array<() => void>;
  back?: () => void;
}

export class AppSurface {
  private static current: AppSurface | undefined;
  private static readonly routeListeners = new Set<(route?: string) => void>();

  static show(id: string, title: string, back?: () => void): AppRoute {
    const surface = AppSurface.current ??= new AppSurface();
    surface.activate(id, title, back);
    return {
      panel: surface.panel,
      onMessage: (handler) => surface.active?.handlers.push(handler),
      onLeave: (handler) => surface.active?.leaveHandlers.push(handler),
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

  private activate(id: string, title: string, back?: () => void): void {
    if (this.active?.id !== id) {
      this.leaveActiveRoute();
      this.active = { id, handlers: [], leaveHandlers: [], back };
    } else {
      this.active.back = back;
    }
    this.panel.title = title;
    this.panel.reveal(vscode.ViewColumn.One, true);
    AppSurface.notifyRoute(id.split(':')[0]);
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