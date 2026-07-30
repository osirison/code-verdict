import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The dependency rule: nothing outside src/providers may reach into a
    // concrete provider. Everything above the data layer talks to
    // src/platform only.
    files: ['src/**/*.ts'],
    ignores: ['src/providers/**', 'src/registry.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/providers/*', '**/providers/**'],
              message:
                'Only src/registry.ts may import concrete providers. Depend on src/platform instead.',
            },
          ],
        },
      ],
    },
  },
);
