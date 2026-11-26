import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stageDir = path.join(repoRoot, 'dist-desktop-stage');
const releaseDir = path.join(repoRoot, 'release');
const rootNodeModules = path.join(repoRoot, 'node_modules');

function copyRecursive(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true, force: true });
}

function resolvePkgDir(pkgName, fromDir) {
  const candidates = [
    path.join(fromDir, 'node_modules', ...pkgName.split('/')),
    path.join(rootNodeModules, ...pkgName.split('/')),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(path.join(cand, 'package.json'))) {
      return fs.realpathSync(cand);
    }
  }
  return null;
}

function collectRuntimeDeps(rootPkgNames) {
  const visited = new Map();
  const queue = rootPkgNames.map((name) => ({ name, fromDir: repoRoot }));

  while (queue.length > 0) {
    const { name, fromDir } = queue.shift();
    if (name.startsWith('@scideveloper/')) continue;
    if (visited.has(name)) continue;

    const dir = resolvePkgDir(name, fromDir);
    if (!dir) continue;
    visited.set(name, dir);

    const pkgJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const deps = Object.keys(pkgJson.dependencies ?? {});
    for (const dep of deps) {
      queue.push({ name: dep, fromDir: dir });
    }
  }
  return visited;
}

function buildStage() {
  console.log('[package-win] Preparing clean staging directory:', stageDir);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  // 1. Desktop main & preload (preload emitted as .cjs for sandboxed Electron under type:module)
  copyRecursive(path.join(repoRoot, 'apps/desktop/dist/main.js'), path.join(stageDir, 'desktop/main.js'));
  copyRecursive(path.join(repoRoot, 'apps/desktop/dist/preload.js'), path.join(stageDir, 'desktop/preload.cjs'));

  // 2. Compiled server, web UI, skills, and icon
  copyRecursive(path.join(repoRoot, 'apps/server/dist'), path.join(stageDir, 'server/dist'));
  copyRecursive(path.join(repoRoot, 'apps/web/dist'), path.join(stageDir, 'web'));
  copyRecursive(path.join(repoRoot, 'skills'), path.join(stageDir, 'skills'));
  copyRecursive(path.join(repoRoot, 'apps/desktop/assets/icon.ico'), path.join(stageDir, 'icon.ico'));
  copyRecursive(path.join(repoRoot, 'apps/desktop/assets/icon.png'), path.join(stageDir, 'icon.png'));

  // 3. Copy compiled @scideveloper/* workspace packages into server_deps/ (mapped to server/node_modules)
  const internalPkgs = ['shared', 'provenance', 'skills', 'mcp-connectors', 'compute', 'agents'];
  for (const pkg of internalPkgs) {
    const srcPkg = path.join(repoRoot, 'packages', pkg);
    const dstPkg = path.join(stageDir, 'server_deps', '@scideveloper', pkg);
    copyRecursive(path.join(srcPkg, 'package.json'), path.join(dstPkg, 'package.json'));
    copyRecursive(path.join(srcPkg, 'dist'), path.join(dstPkg, 'dist'));
    const pyDir = path.join(srcPkg, 'python');
    if (fs.existsSync(pyDir)) {
      copyRecursive(pyDir, path.join(dstPkg, 'python'));
    }
    const rDir = path.join(srcPkg, 'r');
    if (fs.existsSync(rDir)) {
      copyRecursive(rDir, path.join(dstPkg, 'r'));
    }
  }

  // 4. Copy production runtime dependencies of @scideveloper/server
  const serverPkgJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'apps/server/package.json'), 'utf8')
  );
  const prodDeps = collectRuntimeDeps(Object.keys(serverPkgJson.dependencies ?? {}));
  console.log(`[package-win] Bundling ${prodDeps.size} production npm runtime packages...`);
  for (const [pkgName, realDir] of prodDeps.entries()) {
    const dest = path.join(stageDir, 'server_deps', ...pkgName.split('/'));
    copyRecursive(realDir, dest);
  }

  // 5. Write afterPack hook to embed custom teal flask icon.ico & metadata into SciDeveloper.exe via rcedit
  // (Avoids electron-builder's winCodeSign symlink error on Windows without Developer Mode!)
  const rceditEntryUrl = new URL('../node_modules/rcedit/lib/index.js', import.meta.url).href;
  const iconAbsPath = path.join(repoRoot, 'apps', 'desktop', 'assets', 'icon.ico');
  const afterPackHook = `
const path = require('node:path');
const fs = require('node:fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exePath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe');
  if (!fs.existsSync(exePath)) return;
  try {
    const { rcedit } = await import(${JSON.stringify(rceditEntryUrl)});
    await rcedit(exePath, {
      icon: ${JSON.stringify(iconAbsPath)},
      'file-version': '0.5.0',
      'product-version': '0.5.0',
      'version-string': {
        CompanyName: 'SciDeveloper',
        FileDescription: 'SciDeveloper — Local-first AI Scientific Research Workbench',
        ProductName: 'SciDeveloper',
        OriginalFilename: 'SciDeveloper.exe',
      },
    });
    console.log('[afterPack] Embedded custom icon.ico & version metadata into', exePath);
  } catch (err) {
    console.warn('[afterPack] rcedit warning (continuing without exe icon patch):', err && err.message ? err.message : err);
  }
};
`;
  fs.writeFileSync(path.join(stageDir, 'after-pack.cjs'), afterPackHook, 'utf8');

  // 6. Write staged package.json + electron-builder configuration
  const electronPkg = JSON.parse(
    fs.readFileSync(path.join(rootNodeModules, 'electron', 'package.json'), 'utf8')
  );
  const stagedPkg = {
    name: 'scideveloper',
    productName: 'SciDeveloper',
    version: '0.5.0',
    description: 'SciDeveloper — Local-first AI Scientific Research Workbench',
    author: 'SciDeveloper',
    type: 'module',
    main: 'desktop/main.js',
    devDependencies: {
      electron: electronPkg.version,
    },
    build: {
      appId: 'io.scideveloper.workbench',
      productName: 'SciDeveloper',
      asar: false,
      afterPack: path.join(stageDir, 'after-pack.cjs'),
      directories: {
        output: path.join(repoRoot, 'release'),
      },
      files: [
        'desktop/**/*',
        'server/**/*',
        'web/**/*',
        'skills/**/*',
        'icon.ico',
        'icon.png',
        'package.json',
        {
          from: 'server_deps',
          to: 'server/node_modules',
          filter: ['**/*'],
        },
      ],
      win: {
        target: [
          { target: 'dir', arch: ['x64'] },
          { target: 'portable', arch: ['x64'] },
          { target: 'nsis', arch: ['x64'] },
        ],
        icon: 'icon.ico',
        signAndEditExecutable: false,
      },
      portable: {
        artifactName: 'SciDeveloper-${version}-Portable.exe',
      },
      nsis: {
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: 'SciDeveloper',
        artifactName: 'SciDeveloper-Setup-${version}.exe',
      },
    },
  };
  fs.writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify(stagedPkg, null, 2), 'utf8');
}

function runElectronBuilder() {
  const builderBin = path.join(
    rootNodeModules,
    '.bin',
    process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
  );
  if (!fs.existsSync(builderBin)) {
    throw new Error('electron-builder not found. Run npm install first.');
  }

  fs.rmSync(releaseDir, { recursive: true, force: true });
  console.log('[package-win] Running electron-builder for Windows x64 (dir + portable + nsis)...');
  execFileSync(builderBin, ['--win', '--x64', '--projectDir', stageDir], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  });

  console.log('\n[package-win] Packaging complete! Outputs in:', releaseDir);
  for (const entry of fs.readdirSync(releaseDir)) {
    const full = path.join(releaseDir, entry);
    const stat = fs.statSync(full);
    const sizeMb = stat.isFile() ? ` (${(stat.size / (1024 * 1024)).toFixed(1)} MB)` : ' [dir]';
    console.log(' -', entry + sizeMb);
  }
}

buildStage();
runElectronBuilder();
