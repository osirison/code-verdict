/**
 * Narrow storage interfaces so app-layer state is testable without the
 * `vscode` module. `vscode.Memento` and `vscode.SecretStorage` satisfy
 * these structurally.
 */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
}

function hostOf(instanceUrl: string): string {
  try {
    return new URL(instanceUrl).host;
  } catch {
    return instanceUrl;
  }
}

/**
 * Secrets are keyed per provider and instance host — never per pod, never in
 * settings. The provider is part of the key so two providers pointing at the
 * same host cannot read or overwrite each other's credential.
 */
export function tokenSecretKey(providerId: string, instanceUrl: string): string {
  return `codeVerdict.token.${providerId}.${hostOf(instanceUrl)}`;
}

/**
 * The pre-provider key shape. Read-only: `readToken` falls back to it once and
 * rewrites under the scoped key, so pods created before provider scoping are
 * not silently signed out.
 */
export function legacyTokenSecretKey(instanceUrl: string): string {
  return `codeVerdict.token.${hostOf(instanceUrl)}`;
}

/**
 * Read a stored token, migrating a legacy instance-only secret to the
 * provider-scoped key the first time it is found there.
 */
export async function readToken(
  secrets: SecretStore,
  providerId: string,
  instanceUrl: string,
): Promise<string | undefined> {
  const key = tokenSecretKey(providerId, instanceUrl);
  const scoped = await secrets.get(key);
  if (scoped !== undefined) return scoped;

  const legacy = await secrets.get(legacyTokenSecretKey(instanceUrl));
  if (legacy === undefined) return undefined;
  await secrets.store(key, legacy);
  return legacy;
}
