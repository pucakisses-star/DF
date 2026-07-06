import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('porter', {
  pickMap: (title: string) => ipcRenderer.invoke('pick-map', title),
  pickDir: (title: string) => ipcRenderer.invoke('pick-dir', title),
  inspectMap: (path: string) => ipcRenderer.invoke('inspect-map', path),
  runPort: (options: unknown) => ipcRenderer.invoke('run-port', options),
  openPath: (path: string) => ipcRenderer.invoke('open-path', path),
  showInFolder: (path: string) => ipcRenderer.invoke('show-in-folder', path),
});
