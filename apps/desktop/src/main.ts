import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';

const preferredPort = Number(process.env.SCIDEV_PORT ?? process.env.PORT ?? 4318);
const explicitPort = Boolean(process.env.SCIDEV_PORT || process.env.PORT);
const expectedServerVersion = app.isPackaged ? app.getVersion() : '0.5.0';
let activePort = preferredPort;
let serverUrl = `http://127.0.0.1:${activePort}`;
const currentDir = path.dirname(fileURLToPath(import.meta.url));

function resolveRuntimePaths() {
  const preloadCjs = path.join(currentDir, 'preload.cjs');
  const preloadJs = path.join(currentDir, 'preload.js');
  const preload = existsSync(preloadCjs) ? preloadCjs : preloadJs;

  if (app.isPackaged) {
    const appRoot = app.getAppPath();
    const userDataDir = path.join(app.getPath('userData'), 'data');
    const workspaceRoot = path.join(app.getPath('documents'), 'SciDeveloper');
    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    return {
      preload,
      serverEntry: path.join(appRoot, 'server', 'dist', 'index.js'),
      skillsDir: path.join(appRoot, 'skills'),
      webDistDir: path.join(appRoot, 'web'),
      dataDir: userDataDir,
      workspaceRoot,
      iconPath: path.join(appRoot, 'icon.ico'),
    };
  }

  const repoRoot = path.resolve(currentDir, '../../..');
  const iconCandidate = path.join(repoRoot, 'apps', 'desktop', 'assets', 'icon.ico');
  return {
    preload,
    serverEntry: path.join(repoRoot, 'apps', 'server', 'dist', 'index.js'),
    skillsDir: path.join(repoRoot, 'skills'),
    webDistDir: path.join(repoRoot, 'apps', 'web', 'dist'),
    dataDir: path.join(repoRoot, '.scideveloper'),
    workspaceRoot: repoRoot,
    iconPath: existsSync(iconCandidate) ? iconCandidate : undefined,
  };
}

let mainWindow: BrowserWindow | undefined;
let serverChild: ChildProcess | undefined;
let opening: Promise<void> | undefined;
let quitting = false;
let stoppingServer = false;

function resolveDpapiVaultKey(dataDir: string): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return undefined;
  mkdirSync(dataDir, { recursive: true });
  const keyPath = path.join(dataDir, '.vault.dpapi');
  const readKey = () => {
    const key = safeStorage.decryptString(readFileSync(keyPath));
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('The desktop vault master key is invalid');
    return key;
  };
  if (existsSync(keyPath)) return readKey();
  const key = crypto.randomBytes(32).toString('hex');
  try {
    writeFileSync(keyPath, safeStorage.encryptString(key), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readKey();
    throw error;
  }
  return key;
}

async function probeServerHealth(targetUrl: string): Promise<{ ok: boolean; version?: string; pythonAvailable?: boolean } | null> {
  try {
    const response = await fetch(targetUrl + '/api/health', {
      redirect: 'error',
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    const health = (await response.json()) as {
      ok?: boolean;
      version?: string;
      pythonAvailable?: boolean;
    };
    if (health.ok === true && typeof health.version === 'string' && typeof health.pythonAvailable === 'boolean') {
      return { ok: true, version: health.version, pythonAvailable: health.pythonAvailable };
    }
    return null;
  } catch {
    return null;
  }
}

async function isPortFree(portNum: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(portNum, '127.0.0.1');
  });
}

async function findAvailablePort(startPort: number): Promise<number> {
  for (let p = startPort; p < startPort + 50; p += 1) {
    if (await isPortFree(p)) return p;
  }
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const chosen = typeof addr === 'object' && addr ? addr.port : startPort + 51;
      srv.close(() => resolve(chosen));
    });
  });
}

async function serverIsReady(): Promise<boolean> {
  const health = await probeServerHealth(serverUrl);
  return Boolean(health?.ok && health.version === expectedServerVersion);
}

async function ensureServer(): Promise<void> {
  if (quitting) return;
  const existing = await probeServerHealth(serverUrl);
  if (existing?.ok && existing.version === expectedServerVersion) {
    return;
  }

  // If the preferred port is occupied by an older SciDeveloper version (e.g. v0.1.0) or another service,
  // automatically pick a clean free loopback port rather than attaching to an incompatible server.
  if (!serverChild && !(await isPortFree(activePort))) {
    if (explicitPort) {
      throw new Error(
        `Port ${activePort} is already in use by ${existing?.version ? `SciDeveloper v${existing.version} (expected v${expectedServerVersion})` : 'another process'}. Close the older process or unset SCIDEV_PORT.`
      );
    }
    activePort = await findAvailablePort(activePort + 1);
    serverUrl = `http://127.0.0.1:${activePort}`;
  }

  const paths = resolveRuntimePaths();
  let childError: Error | undefined;
  let stderrTail = '';

  if (!serverChild) {
    if (!existsSync(paths.serverEntry)) {
      throw new Error('Server entry not found at ' + paths.serverEntry);
    }
    const execBin = app.isPackaged ? process.execPath : (process.env.npm_node_execpath ?? process.execPath);
    const vaultKey = resolveDpapiVaultKey(paths.dataDir);
    const child = spawn(execBin, [paths.serverEntry], {
      cwd: paths.workspaceRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(activePort),
        SCIDEV_DATA_DIR: paths.dataDir,
        SCIDEV_SKILLS_DIR: paths.skillsDir,
        SCIDEV_WEB_DIST_DIR: paths.webDistDir,
        SCIDEV_WORKSPACE_ROOT: paths.workspaceRoot,
        SCIDEV_VAULT_KEY: vaultKey,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    serverChild = child;
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-1200);
    });
    child.once('error', (error) => {
      childError = error;
    });
    child.once('exit', (code, signal) => {
      if (serverChild === child) serverChild = undefined;
      childError = new Error(
        `The local server exited (${code ?? signal}).${stderrTail ? '\n' + stderrTail.trim() : ''}`
      );
    });
  }

  const deadline = Date.now() + 20_000;
  while (!quitting && Date.now() < deadline) {
    if (await serverIsReady()) return;
    if (childError) throw childError;
    await delay(200);
  }
  if (!quitting) {
    throw new Error('The local server did not become ready at ' + serverUrl + (stderrTail ? '\n' + stderrTail : ''));
  }
}

function trustedUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === 'http:' && parsed.origin === serverUrl;
}

function registerIpc(): void {
  const handle = (channel: string, action: (window: BrowserWindow, input: unknown) => unknown) => {
    ipcMain.handle(channel, (event, input) => {
      const frame = event.senderFrame;
      if (!mainWindow || event.sender !== mainWindow.webContents || !frame || frame.parent || !trustedUrl(frame.url)) {
        throw new Error('Untrusted desktop request');
      }
      return action(mainWindow, input);
    });
  };

  handle('dialog:selectWorkspace', async (window) => {
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('shell:openPath', (_window, targetPath) => {
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath) || targetPath.includes('\0')) {
      throw new Error('Expected an absolute filesystem path');
    }
    return shell.openPath(targetPath);
  });
  handle('app:getInfo', () => ({
    serverUrl,
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
  }));
}

function openWorkbench(): Promise<void> {
  if (mainWindow || quitting) return Promise.resolve();
  opening ??= (async () => {
    await ensureServer();
    if (quitting) return;
    const paths = resolveRuntimePaths();
    const window = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 1024,
      minHeight: 680,
      title: 'SciDeveloper — AI Scientific Research Workbench',
      icon: paths.iconPath && existsSync(paths.iconPath) ? paths.iconPath : undefined,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: paths.preload,
      },
    });
    mainWindow = window;
    window.on('closed', () => {
      mainWindow = undefined;
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (!trustedUrl(url)) event.preventDefault();
    });
    window.webContents.on('will-redirect', (event, url) => {
      if (!trustedUrl(url)) event.preventDefault();
    });
    await window.loadURL(serverUrl);
  })().finally(() => {
    opening = undefined;
  });
  return opening;
}

function showStartupError(error: unknown): void {
  if (quitting) return;
  dialog.showErrorBox('Could not start SciDeveloper', error instanceof Error ? error.message : String(error));
  app.quit();
}

void app
  .whenReady()
  .then(() => {
    registerIpc();
    app.on('activate', () => {
      void openWorkbench().catch(showStartupError);
    });
    return openWorkbench();
  })
  .catch(showStartupError);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  quitting = true;
  const child = serverChild;
  if (!child?.pid) return;
  event.preventDefault();
  if (stoppingServer) return;
  stoppingServer = true;

  const deadline = setTimeout(() => {
    child.kill();
  }, 8000);
  child.once('exit', () => {
    clearTimeout(deadline);
    app.quit();
  });
  if (child.connected) child.disconnect();
});
