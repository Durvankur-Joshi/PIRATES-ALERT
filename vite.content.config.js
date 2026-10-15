import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/content/index.js'),
      name: 'PiratesAlertContent',
      formats: ['iife'],
      fileName: () => 'content.js'
    }
  }
});
