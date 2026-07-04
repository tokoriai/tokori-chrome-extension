import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone test config — deliberately does NOT load the @crxjs plugin
// (it rewrites inputs from manifest.json and assumes an extension build
// context, which breaks Vitest). We only need the `@/*` path alias.
const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src');

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\/(.*)$/, replacement: `${src}/$1` }],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup/chrome-stub.ts'],
  },
});
