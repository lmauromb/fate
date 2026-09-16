import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    deps: { resolveDepSubpath: true },
    entry: ['./src/app.tsx'],
    outputOptions: { codeSplitting: false, entryFileNames: 'index.js' },
  },
});
