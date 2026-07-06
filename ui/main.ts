/**
 * Electron main process: window creation plus a thin IPC layer over the core
 * porter library. All heavy lifting (parsing, closure, emission) lives in
 * src/; nothing here touches map internals.
 */
import { BrowserWindow, app, dialog, ipcMain, net, shell } from 'electron';
import { statSync } from 'fs';
import { join } from 'path';
import { PorterError } from '../src/formats';
import { inspect } from '../src/inspect';
import { PortOptions, port } from '../src/porter';
import { FolderData } from '../src/source';
import { folderObjectDefaults } from '../src/folderobjects';

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
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
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

ipcMain.handle('inspect-folder', (_event, path: string) =>
  wrap(() => {
    const folder = new FolderData(path);
    return {
      name: folder.name,
      models: folder.filesWithExtension('.mdx', '.mdl'),
      icons: folder.filesWithExtension('.blp', '.dds', '.tga', '.jpg'),
      defaults: {
        units: folderObjectDefaults('units'),
        items: folderObjectDefaults('items'),
        doodads: folderObjectDefaults('doodads'),
        destructables: folderObjectDefaults('destructables'),
      },
    };
  }),
);

ipcMain.handle('run-port', (_event, options: PortOptions) => wrap(() => port(options)));

// Drag & drop: decide what a dropped path is.
ipcMain.handle('classify-path', (_event, path: string) => {
  try {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      return { kind: 'folder' as const, path };
    }
    if (stats.isFile() && /\.(w3x|w3m|w3n)$/i.test(path)) {
      return { kind: 'map' as const, path };
    }
    return { kind: 'unknown' as const, path };
  } catch {
    return { kind: 'unknown' as const, path };
  }
});

ipcMain.handle('open-path', (_event, path: string) => shell.openPath(path));

ipcMain.handle('show-in-folder', (_event, path: string) => {
  shell.showItemInFolder(path);
});

// --- Model preview file resolution ------------------------------------------

/**
 * Sources stay open for preview texture requests (a model triggers several).
 * The cache is small and re-validated only by path; re-adding a changed map
 * means re-picking it in the UI, which recreates the entry via inspect below.
 */
import { MapData } from '../src/mapdata';

const previewCache = new Map<string, MapData | FolderData>();
const hiveCache = new Map<string, Uint8Array | null>();

function previewSource(kind: 'map' | 'folder', path: string): MapData | FolderData {
  const key = `${kind}:${path}`;
  let source = previewCache.get(key);
  if (!source) {
    source = kind === 'map' ? new MapData(path) : new FolderData(path);
    previewCache.set(key, source);
  }
  return source;
}

/** Stock Blizzard assets: fetch from Hive Workshop's game-data mirror. */
async function fetchFromHive(filePath: string): Promise<Uint8Array | null> {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  const cached = hiveCache.get(norm);
  if (cached !== undefined) {
    return cached;
  }
  let bytes: Uint8Array | null = null;
  try {
    const response = await net.fetch(`https://www.hiveworkshop.com/casc-contents?path=${encodeURIComponent(norm)}`);
    if (response.ok) {
      const type = response.headers.get('content-type') ?? '';
      if (!type.includes('text/html')) {
        bytes = new Uint8Array(await response.arrayBuffer());
      }
    }
  } catch {
    bytes = null; // Offline or blocked: preview degrades to untextured.
  }
  hiveCache.set(norm, bytes);
  return bytes;
}

/** Candidate paths for a file reference: the game swaps .mdl/.mdx at load time. */
function pathCandidates(filePath: string): string[] {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.mdl') || lower.endsWith('.mdx')) {
    const swapped = filePath.slice(0, -1) + (lower.endsWith('.mdl') ? 'x' : 'l');
    // Prefer the binary .mdx variant.
    return lower.endsWith('.mdl') ? [swapped, filePath] : [filePath, swapped];
  }
  return [filePath];
}

ipcMain.handle(
  'preview-file',
  async (_event, source: { kind: 'map' | 'folder'; path: string } | null, filePath: string) => {
    const candidates = pathCandidates(filePath);
    if (source) {
      try {
        const data = previewSource(source.kind, source.path);
        for (const candidate of candidates) {
          const bytes = data.getFileBytes(candidate);
          if (bytes) {
            return bytes;
          }
        }
      } catch {
        // Fall through to the Hive fallback.
      }
    }
    for (const candidate of candidates) {
      const bytes = await fetchFromHive(candidate);
      if (bytes) {
        return bytes;
      }
    }
    return null;
  },
);

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
