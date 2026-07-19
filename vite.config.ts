import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.json';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, 'src');

export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest })],
  resolve: {
    alias: [{ find: /^@\/(.*)$/, replacement: `${src}/$1` }],
  },
  build: {
    rollupOptions: {
      input: {
        welcome: path.resolve(here, 'welcome.html'),
        stats: path.resolve(here, 'stats.html'),
        library: path.resolve(here, 'library.html'),
        player: path.resolve(here, 'player.html'),
        // chrome.offscreen host for the local OCR engine — created at
        // runtime via chrome.runtime.getURL, so crxjs can't discover
        // it from the manifest.
        offscreen: path.resolve(here, 'offscreen.html'),
      },
    },
  },
});
