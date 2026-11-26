// Sandboxed Electron preloads run as scripts with a restricted require implementation.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

function getPlatformInfo() {
  return ipcRenderer.invoke('app:getInfo') as Promise<{
    serverUrl: string;
    platform: string;
    arch: string;
    versions: NodeJS.ProcessVersions;
  }>;
}

contextBridge.exposeInMainWorld('scideveloperDesktop', {
  getServerUrl: async () => (await getPlatformInfo()).serverUrl,
  selectWorkspaceDir: () => ipcRenderer.invoke('dialog:selectWorkspace') as Promise<string | null>,
  openPath: (targetPath: string) => ipcRenderer.invoke('shell:openPath', targetPath) as Promise<string>,
  getPlatformInfo,
});
