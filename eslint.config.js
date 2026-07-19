import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'public/tesseract/', 'scripts/'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Application + library source (browser + web-extension + service worker).
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        ...globals.webextensions,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // The MAIN-world player hook and the message router legitimately
      // need `any` in a couple of spots; surface the rest as warnings.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Best-effort operations deliberately swallow errors with `catch {}`.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    // Page / content entry points mount via createRoot and export nothing,
    // so react-refresh's "must export components" hint doesn't apply.
    files: [
      'src/popup/index.tsx',
      'src/options/index.tsx',
      'src/welcome/index.tsx',
      'src/content/index.tsx',
    ],
    rules: { 'react-refresh/only-export-components': 'off' },
  },

  {
    // shadcn/ui primitives follow the upstream pattern of exporting a
    // component alongside its cva variants — that mix is intentional.
    files: ['src/components/ui/**/*.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },

  // Build / test tooling config files run in Node.
  {
    files: ['*.{js,ts,mjs,cjs}', 'test/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Keep Prettier last so it can turn off any conflicting stylistic rules.
  prettier,
);
