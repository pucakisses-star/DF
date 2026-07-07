import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('porter', {
  pickMap: (title: string) => ipcRenderer.invoke('pick-map', title),
  pickDir: (title: string) => ipcRenderer.invoke('pick-dir', title),
  inspectMap: (path: string) => ipcRenderer.invoke('inspect-map', path),
  inspectFolder: (path: string, recursive?: boolean) => ipcRenderer.invoke('inspect-folder', path, recursive),
  suggestObject: (folderPath: string, recursive: boolean, modelPath: string, icons: string[]) =>
    ipcRenderer.invoke('suggest-object', folderPath, recursive, modelPath, icons),
  runPort: (options: unknown) => ipcRenderer.invoke('run-port', options),
  openPath: (path: string) => ipcRenderer.invoke('open-path', path),
  showInFolder: (path: string) => ipcRenderer.invoke('show-in-folder', path),
  previewFile: (source: { kind: string; path: string } | null, filePath: string) =>
    ipcRenderer.invoke('preview-file', source, filePath),
  /** Real filesystem path of a dropped File (sandboxed renderers can't see it). */
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  classifyPath: (path: string) => ipcRenderer.invoke('classify-path', path),
  saveProject: (json: string) => ipcRenderer.invoke('save-project', json),
  loadProject: (knownPath?: string) => ipcRenderer.invoke('load-project', knownPath),
  stockModelPath: (category: string, baseId: string) => ipcRenderer.invoke('stock-model-path', category, baseId),
});
