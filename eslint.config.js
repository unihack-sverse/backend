import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'coverage/**', '.data/**', 'public/**', 'tests/.chain/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[object.name='process'][property.name='env']", message: 'Read configuration from src/config/env.js only (08 §2).' },
        { selector: 'ExportDefaultDeclaration', message: 'Use named exports (08 §1).' },
      ],
    },
  },
  { files: ['src/config/env.js', 'scripts/**', 'tests/**', 'vitest*.config.js', 'eslint.config.js'], rules: { 'no-restricted-syntax': 'off', 'no-console': 'off' } },
];
