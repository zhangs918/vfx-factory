import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '@vfx-factory/artifact-schema': path.resolve(import.meta.dirname, 'packages/vfx-artifact-schema/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    open: true,
  },
  build: {
    target: 'esnext',
    modulePreload: false,
    // Runtime payloads are deployed from public/assets independently. Copying
    // the multi-GB local corpus into every application build is both wasteful
    // and an easy way to publish licensed/generated fixtures accidentally.
    copyPublicDir: false,
  },
});
