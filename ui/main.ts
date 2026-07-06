/**
 * Electron main process: window creation plus a thin IPC layer over the core
 * porter library. All heavy lifting (parsing, closure, emission) lives in
 * src/; nothing here touches map internals.
 */
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { join } from 'path';
import { PorterError } from '../src/formats';
import { inspect } from '../src/inspect';
import { PortOptions, port } from '../src/porter';

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

function wrap<T>(fn: () => T): IpcResult<T> {
  try {
    return { ok: true, data: fn() };
  } catch (e) {
    if (e instanceof PorterError) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: `Unexpected error: ${(e as Error).message}` };
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 860,
    minHeight: 600,
    autoHideMenuBar: true,
    title: 'WC3 Object Porter',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(join(__dirname, 'index.html'));
}

ipcMain.handle('pick-map', async (_event, title: string) => {
  const result = await dialog.showOpenDialog({
    title,
    properties: ['openFile'],
    filters: [
      { name: 'Warcraft III maps & campaigns', extensions: ['w3x', 'w3m', 'w3n'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle('pick-dir', async (_event, title: string) => {
  const result = await dialog.showOpenDialog({
    title,
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle('inspect-map', (_event, path: string) => wrap(() => inspect(path)));

ipcMain.handle('run-port', (_event, options: PortOptions) => wrap(() => port(options)));

ipcMain.handle('open-path', (_event, path: string) => shell.openPath(path));

ipcMain.handle('show-in-folder', (_event, path: string) => {
  shell.showItemInFolder(path);
});

// Used by CI to confirm the packaged main process boots.
if (process.argv.includes('--smoke-test')) {
  void app.whenReady().then(() => {
    console.log('SMOKE_OK');
    app.exit(0);
  });
} else {
  void app.whenReady().then(() => {
    createWindow();
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
}
