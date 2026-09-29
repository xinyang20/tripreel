import globals from 'globals';

export default [
  {
    ignores: [
      'dist/vendor/**',
      'dist/data/**',
      'node_modules/**',
      'output/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'constructor-super': 'error',
      'valid-typeof': 'error',
    },
  },
];
