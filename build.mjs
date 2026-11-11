// Bundles src/main.ts and inlines JS + CSS into a single dist/index.html.
// Usage: bun build.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';

const version = JSON.parse(readFileSync('./package.json', 'utf8')).version;
const res = await Bun.build({ entrypoints: ['./src/main.ts'], minify: true, target: 'browser', define: { __APP_VERSION__: JSON.stringify(version) } });
if (!res.success) { console.error(res.logs); process.exit(1); }
const js = await res.outputs[0].text();
// fonts are embedded (src/fonts.css, built by fonts/make-fonts.py) so the app also works offline / packaged
const css = readFileSync('./src/fonts.css', 'utf8') + readFileSync('./src/styles.css', 'utf8');
const html = readFileSync('./index.html', 'utf8')
  .replace('/*__CSS__*/', () => css)
  .replace('/*__JS__*/', () => js.replace(/<\/script/gi, '<\\/script'));
mkdirSync('./dist', { recursive: true });
writeFileSync('./dist/index.html', html);
// high-quality multi-velocity instrument packs (scripts/build-hq-sounds.py) ship next to the page
if (existsSync('./sounds-hq')) {
  mkdirSync('./dist/sounds/hq', { recursive: true });
  for (const f of readdirSync('./sounds-hq')) if (f.endsWith('.json')) copyFileSync(`./sounds-hq/${f}`, `./dist/sounds/hq/${f}`);
}
console.log(`dist/index.html  ${(html.length / 1024).toFixed(1)} KB  (v${version})`);
