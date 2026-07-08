const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

function copyMermaidBundle() {
  const src = path.join(__dirname, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
  const dest = path.join(__dirname, 'resources', 'features', 'flow-analyzer', 'mermaid.min.js');
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const sharedOptions = {
  bundle: true,
  format: 'cjs',
  minify: production,
  minifyWhitespace: production,
  minifyIdentifiers: production,
  minifySyntax: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  target: ['node18'],
  legalComments: 'none',
  drop: production ? ['debugger'] : [],
  treeShaking: true,
  logLevel: 'silent'
};

async function main() {
  const extensionCtx = await esbuild.context({
    ...sharedOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    external: ['vscode'],
  });

  if (watch) {
    await extensionCtx.watch();
    console.log('[Node API Forge] Watching for changes...');
  } else {
    await extensionCtx.rebuild();
    await extensionCtx.dispose();
    copyMermaidBundle();
    console.log('[Node API Forge] Build complete');
  }
}

main().catch((e) => {
  console.error('[Node API Forge] Build failed:', e);
  process.exit(1);
});
