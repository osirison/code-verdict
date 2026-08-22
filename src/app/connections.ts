import { getProvider } from '../platform/registry';
import type { AuthMode, Connection, Credential } from '../platform/provider';
import { ScmError } from '../platform/errors';
import type { Pod } from '../domain/types';
import type { SecretStore } from './storage';
import { readToken } from './storage';

/**
 * Acquires a host-supplied session. Injected so the app layer stays free of
 * `vscode` — `extension.ts` passes the real `vscode.authentication` bridge.
 */
export type SessionProvider = (
  providerId: string,
  instanceUrl: string,
) => Promise<string | undefined>;

let acquireSession: SessionProvider | undefined;

/** Wired once at activation; absent in tests, which use token pods. */
export function setSessionProvider(provider: SessionProvider | undefined): void {
  acquireSession = provider;
}

/**
 * Build the credential for a pod from the modes its provider declares for that
 * host, best first. A session pod stores no secret, so a missing secret is only
 * an error when the mode that needs one is the mode in play.
 */
async function credentialForPod(pod: Pod, secrets: SecretStore): Promise<Credential> {
  const modes: readonly AuthMode[] = getProvider(pod.providerId).authModesFor(pod.instanceUrl);

  for (const mode of modes) {
    if (mode === 'none') return { kind: 'none' };
    if (mode === 'session' && acquireSession) {
      const accessToken = await acquireSession(pod.providerId, pod.instanceUrl);
      if (accessToken !== undefined) return { kind: 'session', accessToken };
      continue;
    }
    if (mode === 'token') {
      const token = await readToken(secrets, pod.providerId, pod.instanceUrl);
      if (token !== undefined && token !== '') return { kind: 'token', token };
      continue;
    }
  }

  if (modes.includes('token')) {
    throw new ScmError('auth', `No stored credential for ${pod.instanceUrl}. Reconnect the pod.`);
  }
  throw new ScmError('auth', `Could not obtain a session for ${pod.instanceUrl}. Reconnect the pod.`);
}

export async function connectionForPod(pod: Pod, secrets: SecretStore): Promise<Connection> {
  const provider = getProvider(pod.providerId);
  return provider.connect({
    instanceUrl: pod.instanceUrl,
    credential: await credentialForPod(pod, secrets),
  });
}
