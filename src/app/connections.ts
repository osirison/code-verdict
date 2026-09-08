import { getProvider, tryGetProvider } from '../platform/registry';
import type { AuthMode, Connection, ConnectionIntent, Credential } from '../platform/provider';
import { ScmError } from '../platform/errors';
import type { Pod } from '../domain/types';
import type { SecretStore } from './storage';
import { readToken } from './storage';
import { registerSecretValue } from './harnessActivitySanitizer';

/**
 * Acquires a host-supplied session. Injected so the app layer stays free of
 * `vscode` — `extension.ts` passes the real `vscode.authentication` bridge.
 */
export type SessionProvider = (
  providerId: string,
  instanceUrl: string,
  opts?: { createIfNone?: boolean },
) => Promise<string | undefined>;

let acquireSession: SessionProvider | undefined;

/** Wired once at activation; absent in tests, which use token pods. */
export function setSessionProvider(provider: SessionProvider | undefined): void {
  acquireSession = provider;
}

/**
 * Acquire a session through the same bridge `connectionForPod` uses. Onboarding
 * calls this with `createIfNone` so the editor may prompt for an account;
 * connecting an existing pod never prompts.
 */
export async function acquireSessionFor(
  providerId: string,
  instanceUrl: string,
  opts: { createIfNone?: boolean } = {},
): Promise<string | undefined> {
  return acquireSession?.(providerId, instanceUrl, opts);
}

/** Whether a provider offers the editor-session path for this host. */
export function sessionAvailableFor(providerId: string, instanceUrl: string): boolean {
  return (
    acquireSession !== undefined
    && getProvider(providerId).authModesFor(instanceUrl).includes('session')
  );
}

/**
 * Build the credential for a pod from the modes its provider declares for that
 * host, best first. A session pod stores no secret, so a missing secret is only
 * an error when the mode that needs one is the mode in play.
 *
 * Both branches below hand the secret to `registerSecretValue`
 * (`./harnessActivitySanitizer`) before returning it. This is the single point
 * in the extension where a credential of either kind becomes a value the rest
 * of the code can hold, which is what makes it the right place and the only
 * place: the redactor's strongest layer is the one that knows the actual
 * secret rather than guessing at the syntax around it, and that layer is only
 * as complete as this call site is. Registering here — rather than in each
 * provider, or beside each thing that logs — means a future channel that logs
 * something nobody anticipated is covered without being told about it.
 */
async function credentialForPod(pod: Pod, secrets: SecretStore): Promise<Credential> {
  const declared: readonly AuthMode[] = getProvider(pod.providerId).authModesFor(pod.instanceUrl);
  // A pod that recorded its mode uses that one only. Falling through to another
  // would change which identity the pod runs as.
  const modes = pod.authMode && declared.includes(pod.authMode) ? [pod.authMode] : declared;

  for (const mode of modes) {
    if (mode === 'none') return { kind: 'none' };
    if (mode === 'session' && acquireSession) {
      const accessToken = await acquireSession(pod.providerId, pod.instanceUrl);
      if (accessToken !== undefined) {
        registerSecretValue(accessToken);
        return { kind: 'session', accessToken };
      }
      continue;
    }
    if (mode === 'token') {
      const token = await readToken(secrets, pod.providerId, pod.instanceUrl);
      if (token !== undefined && token !== '') {
        registerSecretValue(token);
        return { kind: 'token', token };
      }
      continue;
    }
  }

  if (modes.includes('token')) {
    throw new ScmError('auth', `No stored credential for ${pod.instanceUrl}. Reconnect the pod.`);
  }
  throw new ScmError('auth', `Could not obtain a session for ${pod.instanceUrl}. Reconnect the pod.`);
}

/**
 * `intent` tells the provider who is waiting on this connection. Only the
 * background poll declares itself; everything else is a user standing in front
 * of the screen, which is what the default means. A provider that meters
 * requests can then keep a reserve for the second kind — nothing here knows or
 * needs to know whether one does.
 */
export async function connectionForPod(
  pod: Pod,
  secrets: SecretStore,
  opts: { intent?: ConnectionIntent } = {},
): Promise<Connection> {
  const provider = tryGetProvider(pod.providerId);
  // A pod naming a provider this build does not have is reported, never
  // silently redirected to a different one.
  if (!provider) {
    throw new ScmError('notFound', `Provider "${pod.providerId}" is not available in this build.`);
  }
  return provider.connect({
    instanceUrl: pod.instanceUrl,
    credential: await credentialForPod(pod, secrets),
    intent: opts.intent,
  });
}
