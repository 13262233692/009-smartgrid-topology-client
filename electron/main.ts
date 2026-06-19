import { app, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

let mainWindow: BrowserWindow | null = null;
let sidecarProcess: ChildProcess | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0a0e17',
    title: '智能电网变电站诊断工具 - IEC 61850',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const indexPath = path.join(__dirname, '..', 'renderer', 'index.html');
  mainWindow.loadFile(indexPath);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startSidecar(): void {
  const binaryName = process.platform === 'win32' ? 'rust-core.exe' : 'rust-core';
  const binaryPath = path.join(__dirname, '..', '..', 'rust-core', 'target', 'release', binaryName);

  try {
    sidecarProcess = spawn(binaryPath, ['--mode', 'simulate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    sidecarProcess.on('error', (err) => {
      console.error('Failed to start sidecar:', err.message);
    });

    sidecarProcess.stdout?.on('data', (data: Buffer) => {
      console.log('[sidecar]', data.toString().trim());
    });

    sidecarProcess.stderr?.on('data', (data: Buffer) => {
      console.error('[sidecar]', data.toString().trim());
    });

    sidecarProcess.on('exit', (code) => {
      console.log(`Sidecar exited with code ${code}`);
      sidecarProcess = null;
    });
  } catch (err) {
    console.error('Sidecar spawn error:', err);
  }
}

function killSidecar(): void {
  if (sidecarProcess) {
    try {
      sidecarProcess.kill('SIGTERM');
    } catch {
      // process may already be dead
    }
    sidecarProcess = null;
  }
}

app.on('ready', () => {
  startSidecar();
  createWindow();
});

app.on('window-all-closed', () => {
  killSidecar();
  app.quit();
});

app.on('before-quit', () => {
  killSidecar();
});
