export interface SignInOption {
  label: string;
  description: string;
  flow: 'debug' | 'custom';
}

export function getSignInOptions(hasDebugBypass: boolean): SignInOption[] {
  const options: SignInOption[] = [];

  if (hasDebugBypass) {
    options.push({
      label: 'Continue with the emulator',
      description: 'Use the local debug GitLab emulator and move to the next screen.',
      flow: 'debug',
    });
  }

  options.push({
    label: 'Use a GitLab instance',
    description: 'Enter a GitLab URL and continue with the sign-in flow.',
    flow: 'custom',
  });

  return options;
}
