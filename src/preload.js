const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("claudeShell", {
  // Run a predefined command by ID
  runCommand: (commandId, args = {}, context) =>
    ipcRenderer.invoke("claude:run-command", { commandId, args, context }),

  // Cancel the currently running command
  cancel: () => ipcRenderer.invoke("claude:cancel"),

  // List all available commands
  listCommands: () => ipcRenderer.invoke("claude:list-commands"),

  // Health check — is Claude Code CLI available?
  health: () => ipcRenderer.invoke("claude:health"),

  // Settings (legacy)
  getSettings: () => ipcRenderer.invoke("claude:get-settings"),
  saveSettings: (settings) =>
    ipcRenderer.invoke("claude:save-settings", settings),
  pickFolder: () => ipcRenderer.invoke("claude:pick-folder"),

  // Config
  getConfig: () => ipcRenderer.invoke("claude:get-config"),
  saveConfig: (config) => ipcRenderer.invoke("claude:save-config", config),

  // Theme
  getTheme: () => ipcRenderer.invoke("claude:get-theme"),
  onThemeChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("claude:theme-changed", handler);
    return () => ipcRenderer.removeListener("claude:theme-changed", handler);
  },

  // Frame URL (for context detection)
  getFrameUrl: () => ipcRenderer.invoke("claude:get-frame-url"),
  onFrameNavigated: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("claude:frame-navigated", handler);
    return () => ipcRenderer.removeListener("claude:frame-navigated", handler);
  },

  // Analysis CRUD
  saveAnalysis: (data) => ipcRenderer.invoke("claude:save-analysis", data),
  listAnalyses: (opts) => ipcRenderer.invoke("claude:list-analyses", opts),
  loadAnalysis: (id) => ipcRenderer.invoke("claude:load-analysis", id),
  deleteAnalysis: (id) => ipcRenderer.invoke("claude:delete-analysis", id),

  // Subscribe to real-time output streaming
  onOutputChunk: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("claude:output-chunk", handler);
    return () => ipcRenderer.removeListener("claude:output-chunk", handler);
  },

  // Subscribe to analysis saved events
  onAnalysisSaved: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("claude:analysis-saved", handler);
    return () => ipcRenderer.removeListener("claude:analysis-saved", handler);
  },
});
