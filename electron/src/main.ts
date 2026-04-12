import {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  screen,
  ipcMain,
  nativeImage,
  dialog,
  systemPreferences,
} from 'electron';
import path from 'path';
import net from 'node:net';
import { spawn, ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { parse as parseDotenv } from 'dotenv';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isOverlayMode = true;
let serverProcess: ChildProcess | null = null;
let serverManaged = false; // true if we spawned the server ourselves

const HOTKEY = 'CommandOrControl+Shift+V'; // Global hotkey to toggle overlay
const SERVER_URL = 'http://localhost:3001';
const SERVER_HEALTH_URL = `${SERVER_URL}/health`;
const SERVER_PORT = 3001;
/** Retries before spawning embedded server (manual server may still be booting / tsx cold start). */
const HEALTH_BOOT_RETRIES = 30;
const HEALTH_BOOT_INTERVAL_MS = 400;
const TCP_PROBE_TIMEOUT_MS = 800;

/** Dev-only: Vite writes `.vite-dev-port` with the actual port (see vite.config.ts). */
function getViteDevServerUrl(): string {
  const fromEnv = process.env.VITE_DEV_SERVER_URL?.trim();
  if (fromEnv) return fromEnv;

  if (process.env.NODE_ENV === 'development') {
    const portFile = path.join(__dirname, '..', '.vite-dev-port');
    try {
      if (existsSync(portFile)) {
        const port = readFileSync(portFile, 'utf8').trim();
        if (/^\d+$/.test(port)) {
          return `http://localhost:${port}`;
        }
      }
    } catch {
      // fall through
    }
  }
  return 'http://localhost:5173';
}

// ── Server Management ──────────────────────────────────────────────

type EmbeddedServerStatus =
  | 'starting'
  | 'ready'
  | 'crashed'
  | 'port_busy';

function sendServerStatus(status: EmbeddedServerStatus) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('server-status', status);
  }
}

async function checkServerHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(SERVER_HEALTH_URL, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(maxWaitMs = 20000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await checkServerHealth()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Wait for /health while a manually started server may still be compiling. */
async function waitForHealthDuringBoot(): Promise<boolean> {
  for (let i = 0; i < HEALTH_BOOT_RETRIES; i++) {
    if (await checkServerHealth()) return true;
    await new Promise((r) => setTimeout(r, HEALTH_BOOT_INTERVAL_MS));
  }
  return false;
}

/** Single-host TCP probe (used for 127.0.0.1 and ::1). */
function tcpProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, TCP_PROBE_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** True if something is accepting TCP on the port (IPv4 and/or IPv6 loopback). */
async function tcpPortListening(port: number): Promise<boolean> {
  if (await tcpProbe('127.0.0.1', port)) return true;
  if (await tcpProbe('::1', port)) return true;
  return false;
}

let eaddrRecoveryInFlight = false;

async function recoverFromEmbeddedServerEaddrInUse(): Promise<void> {
  if (eaddrRecoveryInFlight) return;
  eaddrRecoveryInFlight = true;
  try {
    console.log(
      '[Electron] Embedded server hit EADDRINUSE — port',
      SERVER_PORT,
      'already in use. Stopping the duplicate embedded process only (your existing server is not targeted).',
    );
    serverManaged = false;
    const proc = serverProcess;
    serverProcess = null;
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
    }
    await new Promise((r) => setTimeout(r, 600));
    if (await waitForServer(20000)) {
      console.log('[Electron] Using existing server at', SERVER_URL);
      sendServerStatus('ready');
    } else {
      sendServerStatus('crashed');
    }
  } finally {
    eaddrRecoveryInFlight = false;
  }
}

async function startServer(): Promise<void> {
  if (await waitForHealthDuringBoot()) {
    console.log('[Electron] Server already running at', SERVER_URL);
    sendServerStatus('ready');
    return;
  }

  const skipEmbeddedEnv =
    process.env.KLARO_SKIP_EMBEDDED_SERVER ??
    process.env.RCY_SKIP_EMBEDDED_SERVER;
  const skipEmbedded =
    skipEmbeddedEnv === '1' || skipEmbeddedEnv === 'true';
  if (skipEmbedded) {
    console.log(
      '[Electron] KLARO_SKIP_EMBEDDED_SERVER is set — will not spawn embedded server; waiting for /health only.',
    );
    sendServerStatus('starting');
    if (await waitForServer(60000)) {
      console.log('[Electron] External server ready at', SERVER_URL);
      sendServerStatus('ready');
    } else {
      console.error(
        '[Electron] No server on',
        SERVER_URL,
        'within 60s. Start `cd server && npm run dev` or unset KLARO_SKIP_EMBEDDED_SERVER.',
      );
      sendServerStatus('crashed');
    }
    return;
  }

  sendServerStatus('starting');

  const portInUse = await tcpPortListening(SERVER_PORT);
  if (portInUse) {
    if (await checkServerHealth()) {
      console.log('[Electron] Server became ready at', SERVER_URL);
      sendServerStatus('ready');
      return;
    }
    console.error(
      '[Electron] Port',
      SERVER_PORT,
      'is in use but /health did not succeed — not spawning a second server.',
    );
    sendServerStatus('port_busy');
    return;
  }

  // Last chance: external server may have finished booting during the port-free window.
  for (let i = 0; i < 12; i++) {
    if (await checkServerHealth()) {
      console.log('[Electron] Server became ready before spawn — using', SERVER_URL);
      sendServerStatus('ready');
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  // Race guard: something may have bound 3001 after our last probe (e.g. `npm run dev` in server/).
  await new Promise((r) => setTimeout(r, 150));
  if (await tcpPortListening(SERVER_PORT)) {
    if (await checkServerHealth()) {
      console.log('[Electron] Server is now listening — using', SERVER_URL);
      sendServerStatus('ready');
      return;
    }
    console.error(
      '[Electron] Port',
      SERVER_PORT,
      'became busy before spawn but /health failed — not starting a second server.',
    );
    sendServerStatus('port_busy');
    return;
  }

  console.log('[Electron] Starting embedded server...');

  const serverDir = path.resolve(__dirname, '../../server');
  if (!existsSync(path.join(serverDir, 'package.json'))) {
    console.error('[Electron] Server directory not found at', serverDir);
    sendServerStatus('crashed');
    return;
  }

  const envPath = path.join(serverDir, '.env');
  let serverEnv: Record<string, string> = {};
  if (existsSync(envPath)) {
    try {
      serverEnv = parseDotenv(readFileSync(envPath));
    } catch (err) {
      console.warn('[Electron] Failed to parse server .env:', err);
    }
  }

  const mergedEnv = { ...process.env, ...serverEnv };

  serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: mergedEnv,
    stdio: 'pipe',
    detached: false,
  });
  serverManaged = true;

  serverProcess.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(`[Server] ${data.toString()}`);
  });

  serverProcess.stderr?.on('data', (data: Buffer) => {
    const chunk = data.toString();
    process.stderr.write(`[Server:err] ${chunk}`);
    if (chunk.includes('EADDRINUSE')) {
      void recoverFromEmbeddedServerEaddrInUse();
    }
  });

  serverProcess.on('exit', (code) => {
    console.log(`[Electron] Server process exited with code ${code}`);
    if (serverManaged) {
      sendServerStatus('crashed');
      serverProcess = null;
    }
  });

  let ready = await waitForServer();
  if (!ready) {
    await new Promise((r) => setTimeout(r, 1500));
    ready = await checkServerHealth();
  }
  if (ready) {
    console.log('[Electron] Server is ready');
    sendServerStatus('ready');
  } else {
    console.error('[Electron] Server failed to start within timeout');
    sendServerStatus('crashed');
  }
}

function killServer() {
  if (serverProcess && !serverProcess.killed) {
    console.log('[Electron] Killing server process...');
    serverManaged = false;
    serverProcess.kill('SIGTERM');
    // Force kill after 3s if still alive
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
    }, 3000);
    serverProcess = null;
  }
}

// ── Accessibility Check ────────────────────────────────────────────

function checkAccessibilityPermission() {
  if (process.platform !== 'darwin') return;

  const trusted = systemPreferences.isTrustedAccessibilityClient(false);
  if (!trusted) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Accessibility Permission Required',
      message:
        'Klaro needs Accessibility permission for desktop automation (opening apps, controlling windows).',
      detail:
        'Please go to System Settings → Privacy & Security → Accessibility and add this app.',
      buttons: ['Open System Settings', 'Later'],
      defaultId: 0,
    }).then((result) => {
      if (result.response === 0) {
        // Prompt macOS to show the accessibility permission dialog
        systemPreferences.isTrustedAccessibilityClient(true);
      }
    });
  } else {
    console.log('[Electron] Accessibility permission: granted');
  }
}

// ── Window Management ──────────────────────────────────────────────

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  // Extra padding around glass for border/shadow effects
  const windowWidth = 740;
  const windowHeight = 390;
  const windowX = Math.floor((screenWidth - windowWidth) / 2);
  const windowY = Math.floor((screenHeight - windowHeight) / 2);

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: windowX,
    y: windowY,
    transparent: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    minWidth: 500,
    minHeight: 300,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0f1117',
    hasShadow: true,
    roundedCorners: true,
  });

  // Load the renderer
  if (process.env.NODE_ENV === 'development') {
    const devUrl = getViteDevServerUrl();
    console.log('[Electron] Loading renderer from', devUrl);
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Enable click-through in overlay mode
  if (isOverlayMode) {
    enableOverlayMode();
  }
}

function enableOverlayMode() {
  if (!mainWindow) return;

  // Make the window click-through except for interactive elements
  // The renderer will handle making specific elements interactive
  mainWindow.setIgnoreMouseEvents(false); // Start with normal interaction
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setSkipTaskbar(true);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  isOverlayMode = true;
}

function disableOverlayMode() {
  if (!mainWindow) return;

  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setSkipTaskbar(false);
  mainWindow.setVisibleOnAllWorkspaces(false);

  isOverlayMode = false;
}

function toggleOverlayMode() {
  if (isOverlayMode) {
    disableOverlayMode();
  } else {
    enableOverlayMode();
  }
}

function toggleWindow() {
  if (!mainWindow) return;

  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray() {
  // Create a simple tray icon
  // For macOS, we can use nativeImage to create a template icon
  const iconPath = path.join(__dirname, 'assets/tray-icon.png');

  // Try to load icon, fallback to creating a simple one
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);

    // If icon doesn't exist or failed to load, create a simple template
    if (trayIcon.isEmpty()) {
      // Create a simple 16x16 icon with a dot in the center
      const size = 16;
      const canvas = Buffer.alloc(size * size * 4);
      // Fill with transparent
      for (let i = 0; i < canvas.length; i += 4) {
        canvas[i] = 0;     // R
        canvas[i + 1] = 0; // G
        canvas[i + 2] = 0; // B
        canvas[i + 3] = 0; // A
      }
      // Draw a simple circle in the center
      const centerX = Math.floor(size / 2);
      const centerY = Math.floor(size / 2);
      const radius = 3;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = x - centerX;
          const dy = y - centerY;
          if (dx * dx + dy * dy <= radius * radius) {
            const idx = (y * size + x) * 4;
            canvas[idx] = 255;     // R
            canvas[idx + 1] = 255; // G
            canvas[idx + 2] = 255; // B
            canvas[idx + 3] = 255; // A
          }
        }
      }
      trayIcon = nativeImage.createFromBuffer(canvas, { width: size, height: size });
    }
  } catch (err) {
    console.error('Failed to create tray icon:', err);
    // Use empty icon as last resort
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide',
      click: toggleWindow,
    },
    {
      label: isOverlayMode ? 'Disable Overlay Mode' : 'Enable Overlay Mode',
      click: toggleOverlayMode,
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Klaro');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    toggleWindow();
  });
}

// ── App Lifecycle ──────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Start server first, then create the window
  await startServer();

  createWindow();
  createTray();

  // Check accessibility permission for desktop agent
  checkAccessibilityPermission();

  // Register global hotkey
  const registered = globalShortcut.register(HOTKEY, () => {
    toggleWindow();
  });

  if (!registered) {
    console.error('Hotkey registration failed');
  }

  console.log(`Global hotkey registered: ${HOTKEY}`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killServer();
});

app.on('will-quit', () => {
  // Unregister all shortcuts
  globalShortcut.unregisterAll();
  killServer();
});

// Handle IPC for overlay control (optional - for renderer to control overlay)
ipcMain.on('toggle-overlay', () => {
  toggleOverlayMode();
});

ipcMain.on('set-click-through', (_, enabled: boolean) => {
  if (!mainWindow) return;
  mainWindow.setIgnoreMouseEvents(enabled, { forward: true });
});
