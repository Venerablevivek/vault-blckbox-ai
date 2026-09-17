import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint rules that catch bugs, not style: floating promises (a forgotten await is how an error
 * escapes the error handler), unsafe any, unused code, and console output outside main.ts.
 * Formatting is Prettier's job.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { project: './tsconfig.eslint.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'error',
      // Async implementations of async interfaces (storage, mailer, test doubles) often have
      // nothing to await; the rule would force pointless Promise.resolve wrappers.
      '@typescript-eslint/require-await': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Tests read loosely-typed JSON responses on purpose.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    // Process entry points: printing a fatal startup error is the one legitimate console use.
    files: ['src/main.ts', 'src/maintenance.ts', 'src/worker.ts'],
    rules: { 'no-console': 'off' },
  },
  { files: ['eslint.config.mjs'], ...tseslint.configs.disableTypeChecked },
);
