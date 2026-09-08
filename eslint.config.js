import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  { ignores: ['dist/**', 'node_modules/**', '.mastra/**', 'coverage/**', 'playwright-report/**'] },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // TypeScript's compiler resolves globals/identifiers (and we run `tsc` in CI),
      // so ESLint's no-undef is redundant and produces false positives for Node
      // built-ins (Buffer, process, setInterval, …). Defer to the type-checker.
      'no-undef': 'off',
      // Guardrail: raw console usage is discouraged — use the redacting logger.
      'no-console': 'warn',
      'no-restricted-globals': 'off',
    },
  },
];
