export interface DebugAuthBypass {
  enabled: boolean;
  instanceUrl: string;
  token: string;
  reason: 'development' | 'override';
}

const DEFAULT_DEBUG_INSTANCE_URL = 'http://127.0.0.1:8971';
const DEFAULT_DEBUG_TOKEN = 'glpat-emulator';

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

  if (mode === 1 || overrideEnabled || env.NODE_ENV === 'development') {
    return {
      enabled: true,
      instanceUrl: explicitInstanceUrl ?? DEFAULT_DEBUG_INSTANCE_URL,
      token: explicitToken ?? DEFAULT_DEBUG_TOKEN,
      reason: explicitInstanceUrl || explicitToken ? 'override' : 'development',
    };
  }

  return null;
}
