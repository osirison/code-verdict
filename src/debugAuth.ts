export interface DebugAuthBypass {
  enabled: boolean;
  /** Which provider the emulator speaks. Configurable so the bypass is not
   *  wired to one platform (see docs/ARCHITECTURE.md). */
  providerId: string;
  instanceUrl: string;
  token: string;
  reason: 'development' | 'override';
}

const DEFAULT_DEBUG_INSTANCE_URL = 'http://127.0.0.1:8971';
const DEFAULT_DEBUG_TOKEN = 'glpat-emulator';
// vocab-ok: a provider id, not user-visible text — the emulator's default platform
const DEFAULT_DEBUG_PROVIDER_ID = 'gitlab';

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function getDebugAuthBypass(
  mode: number | undefined = 0,
  env: Record<string, string | undefined> = process.env,
): DebugAuthBypass | null {
  const overrideEnabled = isTruthy(env.VERDICT_DEBUG_AUTH_BYPASS);
  const explicitInstanceUrl = env.CODE_VERDICT_DEBUG_INSTANCE_URL?.trim();
  const explicitToken = env.CODE_VERDICT_DEBUG_TOKEN?.trim();
  const explicitProviderId = env.CODE_VERDICT_DEBUG_PROVIDER?.trim();

  // Both gates are required: the explicit env opt-in AND an Extension
  // Development Host. 2 = vscode.ExtensionMode.Development (this module
  // stays vscode-free); a packaged install (Production = 1) must never
  // pick the bypass up from an inherited environment.
  const inDevelopmentHost = mode === 2;
  if (inDevelopmentHost && overrideEnabled) {
    return {
      enabled: true,
      providerId: explicitProviderId ?? DEFAULT_DEBUG_PROVIDER_ID,
      instanceUrl: explicitInstanceUrl ?? DEFAULT_DEBUG_INSTANCE_URL,
      token: explicitToken ?? DEFAULT_DEBUG_TOKEN,
      reason: explicitInstanceUrl || explicitToken || explicitProviderId ? 'override' : 'development',
    };
  }

  return null;
}
