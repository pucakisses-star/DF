/**
 * Electron main process: window creation plus a thin IPC layer over the core
 * porter library. All heavy lifting (parsing, closure, emission) lives in
 * src/; nothing here touches map internals.
 */
import { BrowserWindow, app, dialog, ipcMain, net, shell } from 'electron';
import { readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PorterError } from '../src/formats';
import { inspect } from '../src/inspect';
import { PortOptions, port } from '../src/porter';
import { FolderData } from '../src/source';
import { folderObjectDefaults, suggestIcon, suggestName, suggestObjectFromModel } from '../src/folderobjects';
import { MappedData } from 'mdx-m3-viewer/dist/cjs/utils/mappeddata';

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

ipcMain.handle('pick-model', async (_event, title: string) => {
  const result = await dialog.showOpenDialog({
    title,
    properties: ['openFile'],
    filters: [
      { name: 'Warcraft III models', extensions: ['mdx', 'mdl'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle('inspect-map', (_event, path: string) => wrap(() => inspect(path)));

ipcMain.handle('inspect-folder', (_event, path: string, recursive?: boolean) =>
  wrap(() => {
    const folder = new FolderData(path, { recursive: recursive ?? true });
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

// Guess unit/building/doodad/destructible from a model's animations, and pick
// a sensible icon (BTN* convention).
ipcMain.handle('suggest-object', (_event, folderPath: string, recursive: boolean, modelPath: string, icons: string[]) =>
  wrap(() => {
    const folder = new FolderData(folderPath, { recursive });
    const bytes = folder.getFileBytes(modelPath);
    if (!bytes) {
      throw new PorterError(`${modelPath}: not found in the folder.`);
    }
    const suggestion = suggestObjectFromModel(bytes, `${modelPath} ${folder.name}`);
    return {
      ...suggestion,
      iconPath: suggestIcon(icons) ?? '',
      name: suggestName(suggestion.modelName, modelPath),
    };
  }),
);

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
    if (stats.isFile() && /\.(mdx|mdl)$/i.test(path)) {
      return { kind: 'model' as const, path };
    }
    if (stats.isFile() && /\.wc3port$/i.test(path)) {
      return { kind: 'project' as const, path };
    }
    return { kind: 'unknown' as const, path };
  } catch {
    return { kind: 'unknown' as const, path };
  }
});

// --- Project (save/load the whole porter list) -------------------------------

const PROJECT_FILTERS = [
  { name: 'WC3 Object Porter list', extensions: ['wc3port'] },
  { name: 'All files', extensions: ['*'] },
];

ipcMain.handle('save-project', async (_event, json: string) => {
  const result = await dialog.showSaveDialog({
    title: 'Save porter list',
    defaultPath: 'my-import.wc3port',
    filters: PROJECT_FILTERS,
  });
  if (result.canceled || !result.filePath) {
    return null;
  }
  writeFileSync(result.filePath, json);
  return result.filePath;
});

ipcMain.handle('load-project', async (_event, knownPath?: string) => {
  let path = knownPath;
  if (!path) {
    const result = await dialog.showOpenDialog({
      title: 'Load porter list',
      properties: ['openFile'],
      filters: PROJECT_FILTERS,
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    path = result.filePaths[0];
  }
  try {
    return { path, json: readFileSync(path, 'utf8') };
  } catch (e) {
    return { path, error: (e as Error).message };
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

function previewSource(kind: 'map' | 'folder', path: string, recursive: boolean): MapData | FolderData {
  const key = `${kind}:${recursive}:${path}`;
  let source = previewCache.get(key);
  if (!source) {
    source = kind === 'map' ? new MapData(path) : new FolderData(path, { recursive });
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
  async (_event, source: { kind: 'map' | 'folder'; path: string; recursive?: boolean } | null, filePath: string) => {
    const candidates = pathCandidates(filePath);
    if (source) {
      try {
        const data = previewSource(source.kind, source.path, source.recursive ?? true);
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

// --- Standard-object model lookup (game data tables streamed from Hive) ------

interface StockTables {
  units: MappedData;
  doodads: MappedData;
}

let stockTablesPromise: Promise<StockTables | null> | null = null;

function loadStockTables(): Promise<StockTables | null> {
  stockTablesPromise ??= (async () => {
    const fetchText = async (path: string): Promise<string | null> => {
      const bytes = await fetchFromHive(path);
      return bytes ? new TextDecoder().decode(bytes) : null;
    };
    const [unitData, unitUi, itemData, doodads, destructables] = await Promise.all([
      fetchText('Units\\UnitData.slk'),
      fetchText('Units\\unitUI.slk'),
      fetchText('Units\\ItemData.slk'),
      fetchText('Doodads\\Doodads.slk'),
      fetchText('Units\\DestructableData.slk'),
    ]);
    if (!unitUi && !doodads) {
      return null; // offline
    }
    const units = new MappedData();
    for (const text of [unitData, unitUi, itemData]) {
      if (text) {
        units.load(text);
      }
    }
    const doodadsData = new MappedData();
    for (const text of [doodads, destructables]) {
      if (text) {
        doodadsData.load(text);
      }
    }
    return { units, doodads: doodadsData };
  })();
  return stockTablesPromise;
}

const stockModelCache = new Map<string, string | null>();

ipcMain.handle('stock-model-path', async (_event, category: string, id: string) => {
  const cacheKey = `${category}:${id}`;
  const cached = stockModelCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  let result: string | null = null;
  try {
    const tables = await loadStockTables();
    if (tables) {
      const table =
        category === 'units' || category === 'items'
          ? tables.units
          : category === 'doodads' || category === 'destructables'
            ? tables.doodads
            : null;
      const row = table?.getRow(id);
      let file = row?.string('file');
      if (file) {
        if (/\.(mdl|mdx)$/i.test(file)) {
          file = file.slice(0, -4);
        }
        // Doodads with variations store a base name; variation 0 is a safe pick.
        for (const candidate of [`${file}.mdx`, `${file}0.mdx`]) {
          if (await fetchFromHive(candidate)) {
            result = candidate;
            break;
          }
        }
      }
    }
  } catch {
    result = null;
  }
  stockModelCache.set(cacheKey, result);
  return result;
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
