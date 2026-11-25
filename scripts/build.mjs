import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');
const DIST_DIR = path.resolve('dist');
const PUBLIC_DIR = path.resolve('public');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function copyStaticAssets() {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  copyDir(PUBLIC_DIR, DIST_DIR);
  const cssFiles = [
    ['src/options/options.css', 'options.css'],
    ['src/popup/popup.css', 'popup.css'],
  ];
  for (const [src, name] of cssFiles) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(DIST_DIR, name));
    }
  }
}

const buildOptions = {
  entryPoints: {
    background: 'src/background/index.ts',
    content: 'src/content/index.ts',
    options: 'src/options/options.ts',
    popup: 'src/popup/popup.ts',
  },
  outdir: DIST_DIR,
  bundle: true,
  format: 'esm',
  target: ['chrome116'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

// Content script in MV3 without web_accessible_resources works most reliably as IIFE
const contentBuildOptions = {
  entryPoints: {
    content: 'src/content/index.ts',
  },
  outdir: DIST_DIR,
  bundle: true,
  format: 'iife',
  target: ['chrome116'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

const esmBuildOptions = {
  entryPoints: {
    background: 'src/background/index.ts',
    options: 'src/options/options.ts',
    popup: 'src/popup/popup.ts',
  },
  outdir: DIST_DIR,
  bundle: true,
  format: 'esm',
  target: ['chrome116'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

async function run() {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  copyStaticAssets();

  if (isWatch) {
    const [ctxEsm, ctxContent] = await Promise.all([
      esbuild.context(esmBuildOptions),
      esbuild.context(contentBuildOptions),
    ]);
    await Promise.all([ctxEsm.watch(), ctxContent.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(esmBuildOptions),
      esbuild.build(contentBuildOptions),
    ]);
    copyStaticAssets();
    console.log('Build completed successfully -> dist/');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
