import { defineConfig } from 'vite';
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// After build: inject the list of every emitted file into dist/sw.js so the whole
// app shell (hashed JS/CSS, fonts, icons) is precached for offline use.
function precacheServiceWorker() {
  let outDir;
  return {
    name: 'reel7-precache-sw',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      const files = [];
      const walk = (d) => readdirSync(d).forEach((f) => {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else files.push('./' + relative(outDir, p).split('\\').join('/'));
      });
      walk(outDir);
      const list = ['./', ...files.filter((f) => f !== './sw.js' && !f.endsWith('.txt') && !f.endsWith('.ttf'))];
      const swPath = join(outDir, 'sw.js');
      const version = Date.now().toString(36);
      const src = readFileSync(swPath, 'utf8')
        .replace("'__BUILD__'", JSON.stringify(version))
        .replace('self.__PRECACHE__ ||', `${JSON.stringify(list)} ||`);
      writeFileSync(swPath, src);
      console.log(`[reel7] service worker precaches ${list.length} files (v ${version})`);
    },
  };
}

export default defineConfig({
  base: './',
  server: { host: true },
  preview: { host: true },
  define: {
    // Busts the HTTP cache of public/scratch-processor.js on each production build.
    __REEL7_BUILD__: JSON.stringify(Date.now().toString(36)),
  },
  build: { outDir: 'dist', target: 'es2020', assetsInlineLimit: 0 },
  worker: { format: 'es' },
  plugins: [precacheServiceWorker()],
});
