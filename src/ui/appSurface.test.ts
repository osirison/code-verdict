import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  message: undefined as ((message: unknown) => void) | undefined,
  dispose: undefined as (() => void) | undefined,
}));

const panel = vi.hoisted(() => ({
  title: '',
  reveal: vi.fn(),
  webview: {
    html: '',
    onDidReceiveMessage: vi.fn((handler: (message: unknown) => void) => {
      handlers.message = handler;
      return { dispose: vi.fn() };
    }),
  },
  onDidDispose: vi.fn((handler: () => void) => {
    handlers.dispose = handler;
    return { dispose: vi.fn() };
  }),
}));

const createWebviewPanel = vi.hoisted(() => vi.fn(() => panel));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  window: { createWebviewPanel },
}));

describe('AppSurface', () => {
  beforeEach(() => {
    createWebviewPanel.mockClear();
    panel.reveal.mockClear();
  });

  it('reuses one panel and replaces route message and back handlers', async () => {
    const { AppSurface } = await import('./appSurface.js');
    const dashboardMessage = vi.fn();
    const dashboardLeave = vi.fn();
    const reviewMessage = vi.fn();
    const reviewBack = vi.fn();
    const routeChanged = vi.fn();
    const routeSubscription = AppSurface.onDidChangeRoute(routeChanged);

    const dashboard = AppSurface.show('dashboard', 'Verdict');
    dashboard.onMessage(dashboardMessage);
    dashboard.onLeave(dashboardLeave);

    const review = AppSurface.show('review', 'Verdict: Review', reviewBack);
    review.onMessage(reviewMessage);
    handlers.message?.({ type: 'select', itemId: 'finding-1' });
    handlers.message?.({ type: 'appBack' });

    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(dashboardLeave).toHaveBeenCalledOnce();
    expect(dashboardMessage).not.toHaveBeenCalled();
    expect(reviewMessage).toHaveBeenCalledWith({ type: 'select', itemId: 'finding-1' });
    expect(reviewBack).toHaveBeenCalledOnce();
    expect(routeChanged).toHaveBeenLastCalledWith('review');
    expect(panel.title).toBe('Verdict: Review');

    routeSubscription.dispose();
    handlers.dispose?.();
  });
});
