import { getProvider } from '../platform/registry';
import type { Connection } from '../platform/provider';
import type { Pod } from '../domain/types';
import type { SecretStore } from './storage';
import { tokenSecretKey } from './storage';

export async function connectionForPod(pod: Pod, secrets: SecretStore): Promise<Connection> {
  const provider = getProvider(pod.providerId);
  const token = (await secrets.get(tokenSecretKey(pod.instanceUrl))) ?? '';
  return provider.connect({ instanceUrl: pod.instanceUrl, token });
}
