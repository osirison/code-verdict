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
  delete(key: string): Thenable<void>;
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
  // `|` cannot appear in a provider id or a hostname, so a scoped key can never
  // collide with a legacy one. Joining with `.` did collide:
  // scoped('gitlab', 'acme.com') and legacy('gitlab.acme.com') were the same
  // string, and readToken would migrate one pod's token onto another's key.
  return `codeVerdict.token.${providerId}|${hostOf(instanceUrl)}`;
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

/** Just enough of a pod to name the secret it reads — keeps this file domain-free. */
export interface TokenOwner {
  providerId: string;
  instanceUrl: string;
}

/**
 * Drop a deleted pod's token, but only when nothing that survives reads the
 * same secret. Secrets are keyed provider + host and never per pod, so two
 * pods on one instance share one credential — deleting it with a sibling
 * still around signs that sibling out of a pod nobody touched.
 *
 * Compared by key rather than by `instanceUrl`, because "https://host/" and
 * "https://host" are two strings naming one secret.
 */
export async function deleteTokenIfUnused(
  secrets: SecretStore,
  removed: TokenOwner,
  remaining: readonly TokenOwner[],
): Promise<void> {
  const key = tokenSecretKey(removed.providerId, removed.instanceUrl);
  if (remaining.some((pod) => tokenSecretKey(pod.providerId, pod.instanceUrl) === key)) return;
  await secrets.delete(key);

  // The legacy key is host-only, so a surviving pod on the same host under a
  // *different* provider can still migrate its token out of it via readToken.
  // That makes the condition for dropping it strictly stronger than the one
  // above: nothing left on this host at all, whatever the provider.
  const legacy = legacyTokenSecretKey(removed.instanceUrl);
  if (remaining.some((pod) => legacyTokenSecretKey(pod.instanceUrl) === legacy)) return;
  await secrets.delete(legacy);
}
