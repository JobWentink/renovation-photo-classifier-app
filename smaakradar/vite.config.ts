import { defineConfig } from 'vite';

// `base: './'` zorgt dat de build overal werkt: GitHub Pages, Netlify, een submap, ...
export default defineConfig({
  base: './',
  build: { target: 'es2021', sourcemap: true },
  test: { environment: 'node' },
} as any);
