import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-server/**', '**/node_modules/**', '**/coverage/**', 'prisma/migrations/**', 'client/public/mediapipe/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['client/**/*.{ts,tsx}', 'yukti-agent/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['server/**/*.ts', 'prisma/**/*.ts', 'shared/**/*.ts', '*.js', 'client/scripts/**/*.mjs', 'yukti-agent/server/**/*.ts', 'yukti-agent/common/**/*.ts', 'yukti-agent/*.ts'],
    languageOptions: { globals: globals.node },
  },
);
