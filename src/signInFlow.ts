/**
 * The sign-in entry point's choices. One option per registered real provider,
 * plus the debug-emulator shortcut when the bypass is active. The chooser is
 * skipped when there is only one option, so a single-provider install does not
 * gain a pointless step.
 */
import type { ScmProvider } from './platform/provider';

export interface SignInOption {
  label: string;
  description: string;
  flow: 'debug' | 'provider';
  /** Which provider the flow connects. Absent only for the debug bypass. */
  providerId?: string;
}

export function getSignInOptions(
  hasDebugBypass: boolean,
  providers: readonly ScmProvider[],
): SignInOption[] {
  const options: SignInOption[] = [];

  if (hasDebugBypass) {
    options.push({
      label: 'Continue with the emulator',
      description: 'Use the local debug emulator and move to the next screen.',
      flow: 'debug',
    });
  }

  for (const provider of providers) {
    options.push({
      label: `Use ${provider.displayName}`,
      description: `Connect ${provider.host.instanceUrlLabel} and continue with the sign-in flow.`,
      flow: 'provider',
      providerId: provider.id,
    });
  }

  return options;
}

/** A chooser is worth showing only when there is something to choose. */
export function needsSignInChoice(options: readonly SignInOption[]): boolean {
  return options.length > 1;
}
