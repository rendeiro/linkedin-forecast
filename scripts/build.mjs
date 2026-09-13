import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/popup', { recursive: true });
mkdirSync('dist/options', { recursive: true });
cpSync('static', 'dist', { recursive: true });
cpSync('src/ui/styles.css', 'dist/styles.css');
cpSync('src/ui/popup/index.html', 'dist/popup/index.html');
cpSync('src/ui/options/index.html', 'dist/options/index.html');

const common = {
  bundle: true, sourcemap: false, target: 'chrome110', logLevel: 'info',
  jsx: 'automatic', jsxImportSource: 'preact', define: { 'process.env.NODE_ENV': '"production"' },
};
const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: ['src/content/index.ts'], outfile: 'dist/content.js', format: 'iife' }),
  esbuild.context({ ...common, entryPoints: ['src/background/index.ts'], outfile: 'dist/background.js', format: 'esm' }),
  esbuild.context({ ...common, entryPoints: ['src/ui/popup/main.tsx'], outfile: 'dist/popup/main.js', format: 'esm' }),
  esbuild.context({ ...common, entryPoints: ['src/ui/options/main.tsx'], outfile: 'dist/options/main.js', format: 'esm' }),
]);
if (watch) {
  await Promise.all(contexts.map(c => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(contexts.map(c => c.rebuild()));
  await Promise.all(contexts.map(c => c.dispose()));
  if (!existsSync('dist/manifest.json')) throw new Error('manifest missing');
  console.log('built dist/');
}
