import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

function resolveGitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __PNV_GIT_COMMIT__: JSON.stringify(resolveGitCommit()),
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: {
        index: 'index.html',
        builder: 'builder.html',
      },
      output: {
        manualChunks(id) {
          if (id.includes('/src/reference/generated/pathways.json')) {
            return 'reference-pathways';
          }
          if (id.includes('/src/reference/generated/ncbi_gene_map.json')) {
            return 'reference-gene-map';
          }
          if (id.includes('/src/reference/generated/ppi.json')) {
            return 'reference-ppi';
          }
          if (id.includes('/src/reference/generated/huri.json')) {
            return 'reference-huri';
          }
          if (id.includes('/src/reference/generated/aliases.json')) {
            return 'reference-aliases';
          }
          if (id.includes('/node_modules/xlsx/')) {
            return 'xlsx-vendor';
          }
          if (
            id.includes('/src/vendor/cytoscape') ||
            id.includes('/src/vendor/elk.bundled') ||
            id.includes('/src/vendor/layout-base') ||
            id.includes('/src/vendor/cose-base')
          ) {
            return 'report-vendor-network';
          }
          if (id.includes('/src/vendor/plotly')) {
            return 'report-vendor-plotly';
          }
          if (
            id.includes('/src/vendor/jspdf') ||
            id.includes('/src/vendor/svg2pdf')
          ) {
            return 'report-vendor-pdf';
          }
          if (id.includes('/src/lib/geoSearch.ts')) {
            return 'geo-search';
          }
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
    include: ['tests/**/*.{test,spec}.{js,mjs,jsx,ts,tsx}'],
    environment: 'jsdom',
    setupFiles: './tests/setup.ts',
  },
});
