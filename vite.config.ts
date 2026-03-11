import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: {
        builder: 'builder.html',
      },
      output: {
        manualChunks(id) {
          if (id.includes('/src/lib/geo.ts') || id.includes('/src/reference/')) {
            return 'geo-analysis';
          }
          if (id.includes('/src/lib/reportHtml.ts') || id.includes('/src/report/') || id.includes('/src/vendor/')) {
            return 'report-runtime';
          }
          if (id.includes('/node_modules/react')) {
            return 'react-vendor';
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './tests/setup.ts',
  },
});
