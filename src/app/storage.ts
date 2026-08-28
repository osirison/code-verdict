/**
 * Narrow storage interfaces so app-layer state is testable without the
 * `vscode` module. `vscode.Memento` and `vscode.SecretStorage` satisfy
 * these structurally.
 */
/**
 * Read-modify-write is the shape of nearly every store built on this —
 * `PodStore.upsert`, `ReviewHistory.add`, `ReviewRunStore.record`,
 * `ThreadFlags.concede`, `ManualChangesetStore.add`. It is safe on one
 * condition, which the interface states rather than leaves to luck: **`get`
 * reflects a preceding `update` immediately, without waiting for that
 * update's promise to settle.** `vscode.Memento` satisfies it (it writes its
 * in-memory value synchronously and persists afterwards), and so must any
 * test double.
 *
 * Given that, a read and a write with no `await` between them cannot
 * interleave with another caller's — JavaScript runs the pair to completion.
 * Put an `await` between them and the guarantee is gone: two callers read the
 * same array and the second write drops the first's entry. So keep the pair
 * synchronous; do not reach for a queue or a lock, which would only hide
 * where the real requirement lives.
 */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
  /**
   * Every key currently stored. Optional because most callers reach for a key
   * they already know; retention is the exception — it has to find records for
   * change requests that closed, which nothing else is holding a key for.
   * `vscode.Memento` provides it; a test double need not.
   */
  keys?(): readonly string[];
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
