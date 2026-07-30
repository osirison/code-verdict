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

/** Secrets are keyed per instance host — never per pod, never in settings. */
export function tokenSecretKey(instanceUrl: string): string {
  let host: string;
  try {
    host = new URL(instanceUrl).host;
  } catch {
    host = instanceUrl;
  }
  return `codeVerdict.token.${host}`;
}
