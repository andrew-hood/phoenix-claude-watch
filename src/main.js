require("dotenv").config();
// Restore full shell PATH when launched from macOS Finder (which provides minimal PATH)
if (process.platform === "darwin") {
  try {
    const { execFileSync } = require("child_process");
    const shell = process.env.SHELL || "/bin/zsh";
    const shellPath = execFileSync(shell, ["-ilc", "echo -n $PATH"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (shellPath) process.env.PATH = shellPath;
  } catch {}
}
const { app, BrowserWindow, ipcMain, session, dialog, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const analysisStore = require("./analysis-store");

// --- Config ---
const CONFIG_DIR = path.join(os.homedir(), ".phoenix-claude-shell");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const LEGACY_SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const DEFAULT_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || "300000", 10);

// Resolve resource paths for both dev and packaged app
const isPackaged = app.isPackaged;
const COMMANDS_DIR = isPackaged
  ? path.join(process.resourcesPath, "commands")
  : path.join(__dirname, "..", "commands");
const RESOURCES_DIR = isPackaged
  ? process.resourcesPath
  : path.join(__dirname, "..");

// Model alias map
const MODEL_ALIASES = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
  haiku: "claude-haiku-4-5",
};

// --- Config Persistence ---
function loadConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    // Migrate from legacy settings if config doesn't exist
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_SETTINGS_PATH, "utf-8"));
      const config = {
        phoenixUrl: process.env.PHOENIX_URL || "http://localhost:6006",
        phoenixApiKey: process.env.PHOENIX_API_KEY || null,
        workingDir: legacy.workingDir || null,
        autoSaveAnalyses: true,
        defaultModel: "sonnet",
        panelWidth: 380,
        themeMode: "system",
      };
      saveConfig(config);
      return config;
    } catch {
      const config = {
        phoenixUrl: process.env.PHOENIX_URL || "http://localhost:6006",
        phoenixApiKey: process.env.PHOENIX_API_KEY || null,
        workingDir: null,
        autoSaveAnalyses: true,
        defaultModel: "sonnet",
        panelWidth: 380,
        themeMode: "system",
      };
      saveConfig(config);
      return config;
    }
  }
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Legacy settings support
function loadSettings() {
  const config = loadConfig();
  return { workingDir: config.workingDir };
}

function saveSettings(settings) {
  const config = loadConfig();
  if (settings.workingDir !== undefined) config.workingDir = settings.workingDir;
  saveConfig(config);
}

let mainWindow = null;
let activeProcess = null;

// Register (or re-register) the auth header interceptor for Phoenix requests
function registerAuthInterceptor(apiKey) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const ses = mainWindow.webContents.session;
  // Remove any existing interceptor before registering a new one
  ses.webRequest.onBeforeSendHeaders(null);
  if (!apiKey) return;
  const config = loadConfig();
  try {
    const phoenixOrigin = new URL(config.phoenixUrl).origin;
    ses.webRequest.onBeforeSendHeaders(
      { urls: [`${phoenixOrigin}/*`] },
      (details, callback) => {
        details.requestHeaders["Authorization"] = `Bearer ${apiKey}`;
        callback({ requestHeaders: details.requestHeaders });
      }
    );
  } catch {
    // Invalid URL — skip interceptor
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    title: "Claude Observe",
    icon: path.join(RESOURCES_DIR, 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(RESOURCES_DIR, 'resources', 'icon.png'));
  }

  // Inject Authorization header for Phoenix requests
  const config = loadConfig();
  registerAuthInterceptor(config.phoenixApiKey);

  // Load the shell HTML (iframe-based layout)
  mainWindow.loadFile(path.join(__dirname, "shell.html"));

  // Track iframe (Phoenix) URL changes and forward to renderer
  mainWindow.webContents.on("did-frame-navigate", (_event, url, _httpCode, _httpStatus, isMainFrame) => {
    if (!isMainFrame) {
      sendToRenderer("claude:frame-navigated", { url });
    }
  });
  mainWindow.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!isMainFrame) {
      sendToRenderer("claude:frame-navigated", { url });
    }
  });

  // Forward system theme changes to renderer
  nativeTheme.on("updated", () => {
    const config = loadConfig();
    if ((config.themeMode || "system") === "system") {
      sendToRenderer("claude:theme-changed", {
        theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      });
    }
  });

  // Deny all new window creation
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Open DevTools in dev mode
  if (process.env.NODE_ENV === "development") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

// --- IPC Handlers ---

// Execute a predefined Claude Code command
ipcMain.handle("claude:run-command", async (event, { commandId, args = {}, context }) => {
  const command = loadCommand(commandId);
  if (!command) {
    return { success: false, error: `Unknown command: ${commandId}` };
  }

  try {
    const result = await executeClaudeCommand(command, args, context);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// List available predefined commands
ipcMain.handle("claude:list-commands", async () => {
  return listCommands();
});

// Get Claude Code version / health check
ipcMain.handle("claude:health", async () => {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, ["--version"]);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      resolve({
        available: code === 0,
        version: stdout.trim(),
        error: code !== 0 ? stderr.trim() : null,
      });
    });
    proc.on("error", (err) => {
      resolve({ available: false, version: null, error: err.message });
    });
  });
});

// Cancel a running Claude process
ipcMain.handle("claude:cancel", async () => {
  if (activeProcess && !activeProcess.killed) {
    activeProcess.kill("SIGTERM");
    activeProcess = null;
    return { cancelled: true };
  }
  return { cancelled: false, reason: "No active process" };
});

// Config
ipcMain.handle("claude:get-config", async () => loadConfig());
ipcMain.handle("claude:save-config", async (_event, config) => {
  saveConfig(config);
  // Re-register auth interceptor with updated key/URL
  registerAuthInterceptor(config.phoenixApiKey);
  // Push updated theme to renderer
  const mode = config.themeMode || "system";
  const theme = mode === "system"
    ? (nativeTheme.shouldUseDarkColors ? "dark" : "light")
    : mode;
  sendToRenderer("claude:theme-changed", { theme });
  return { success: true };
});

// Theme detection
ipcMain.handle("claude:get-theme", async () => {
  const config = loadConfig();
  const override = config.themeMode || "system";
  if (override !== "system") return override;
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
});

// Legacy settings
ipcMain.handle("claude:get-settings", async () => loadSettings());
ipcMain.handle("claude:save-settings", async (_event, settings) => {
  saveSettings(settings);
  return { success: true };
});

// Pick folder via native dialog
ipcMain.handle("claude:pick-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Select Agent Source Repository",
  });
  if (result.canceled) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
});

// Get iframe URL (fallback for LiveView pushState navigation)
ipcMain.handle("claude:get-frame-url", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    const frames = mainWindow.webContents.mainFrame.frames;
    if (frames.length > 0) {
      return frames[0].url;
    }
  } catch {}
  return null;
});

// Analysis CRUD
ipcMain.handle("claude:save-analysis", async (_event, data) => {
  return analysisStore.saveAnalysis(data);
});

ipcMain.handle("claude:list-analyses", async (_event, opts) => {
  return analysisStore.listAnalyses(opts);
});

ipcMain.handle("claude:load-analysis", async (_event, id) => {
  return analysisStore.loadAnalysis(id);
});

ipcMain.handle("claude:delete-analysis", async (_event, id) => {
  return analysisStore.deleteAnalysis(id);
});

// --- Command Loading ---

function loadCommand(commandId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(commandId)) {
    return null;
  }

  const commandPath = path.join(COMMANDS_DIR, `${commandId}.json`);

  try {
    const raw = fs.readFileSync(commandPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function listCommands() {
  const commandsDir = COMMANDS_DIR;

  try {
    const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith(".json"));
    return files.map((f) => {
      const raw = fs.readFileSync(path.join(commandsDir, f), "utf-8");
      const cmd = JSON.parse(raw);
      return {
        id: f.replace(".json", ""),
        name: cmd.name,
        description: cmd.description,
        icon: cmd.icon || "Zap",
        context: cmd.context || ["global"],
      };
    });
  } catch {
    return [];
  }
}

// --- Output Extraction ---

function extractCleanOutput(rawStdout) {
  const lines = rawStdout.split("\n");
  const parts = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            parts.push(block.text);
          }
        }
      } else if (event.type === "result" && event.result) {
        parts.push(event.result);
      }
    } catch {
      // not JSON, skip
    }
  }

  return parts.length > 0 ? parts[parts.length - 1] : rawStdout.trim();
}

// --- Claude Code Execution ---

function executeClaudeCommand(command, args, context) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    // Build the prompt — supports simple template interpolation
    let prompt = command.prompt;
    for (const [key, value] of Object.entries(args)) {
      if (typeof value !== "string" || value.length > 1000) continue;
      prompt = prompt.replaceAll(`{{${key}}}`, value);
    }

    // Resolve model alias — fall back to config default when command doesn't specify
    const config = loadConfig();
    const modelKey = command.model || config.defaultModel || "sonnet";
    const resolvedModel = MODEL_ALIASES[modelKey] || modelKey;

    // Append source code cross-reference instruction when agent repo is configured
    if (config.workingDir) {
      prompt += `\n\nThe source code for the agent that generated these traces is available at ${config.workingDir}. When relevant, cross-reference trace data with the agent's source code to provide specific, actionable code recommendations (e.g., prompt improvements, tool configuration changes, error handling fixes). Reference specific files and line numbers when possible.`;
    }

    // Build CLI args: claude -p --output-format stream-json --verbose [--model X] "prompt"
    const cliArgs = ["-p", "--output-format", "stream-json", "--verbose"];
    if (resolvedModel) {
      cliArgs.push("--model", resolvedModel);
    }
    if (config.workingDir) {
      cliArgs.push("--add-dir", config.workingDir);
    }

    // Pre-approve tools declared by the command (avoids interactive permission prompts)
    const allowedTools = [...(command.allowedTools || [])];
    if (config.workingDir) {
      allowedTools.push("Read", "Grep");
    }
    for (const tool of allowedTools) {
      cliArgs.push("--allowedTools", tool);
    }

    // Run from the app's resource dir so relative paths in prompts resolve to bundled scripts
    const cwd = command.workingDir || RESOURCES_DIR;

    // Resolve relative script paths to absolute so Claude CLI runs bundled scripts
    // regardless of its own working directory (e.g. when --add-dir points elsewhere)
    prompt = prompt.replaceAll('node scripts/', `node ${path.join(cwd, 'scripts')}/`);

    cliArgs.push("--", prompt);

    const timeoutMs = command.timeoutMs || DEFAULT_TIMEOUT_MS;

    console.log(`[Claude] Executing: ${CLAUDE_BIN} ${cliArgs.join(" ")}`);
    console.log(`[Claude] CWD: ${cwd} | Timeout: ${timeoutMs}ms`);

    const proc = spawn(CLAUDE_BIN, cliArgs, {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    console.log(`[Claude] Process spawned, PID: ${proc.pid}`);
    activeProcess = proc;

    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    const seenMessageIds = new Set();
    const cmdId = command.id || "unknown";

    const timeout = setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGTERM");
        sendToRenderer("claude:output-chunk", {
          commandId: cmdId,
          chunk: `\n[timeout] Timed out after ${timeoutMs / 1000}s — process killed.\n`,
          type: "error",
        });
        reject(new Error(`Timed out after ${timeoutMs / 1000}s`));
      }
    }, timeoutMs);

    function processNdjsonLine(line) {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        // Skip noisy system and rate limit events
        if (event.type === "system" || event.type === "rate_limit_event") return;

        // Deduplicate assistant messages (they re-emit the full message each update)
        if (event.type === "assistant" && event.message?.id) {
          const msgId = event.message.id;
          if (seenMessageIds.has(msgId)) {
            // Still send — renderer handles incremental dedup per message ID
          }
          seenMessageIds.add(msgId);
        }

        sendToRenderer("claude:output-chunk", {
          commandId: cmdId,
          event,
          type: "json-event",
        });
      } catch {
        // Not valid JSON — send as raw stdout
        sendToRenderer("claude:output-chunk", {
          commandId: cmdId,
          chunk: line + "\n",
          type: "stdout",
        });
      }
    }

    proc.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      lineBuffer += text;

      const lines = lineBuffer.split("\n");
      // Keep the last incomplete line in the buffer
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        processNdjsonLine(line);
      }
    });

    proc.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      sendToRenderer("claude:output-chunk", {
        commandId: cmdId,
        chunk: `[stderr] ${chunk}`,
        type: "stderr",
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      activeProcess = null;
      const completedAt = Date.now();
      console.log(`[Claude] Process exited with code ${code}`);

      // Flush remaining line buffer
      if (lineBuffer.trim()) {
        processNdjsonLine(lineBuffer);
        lineBuffer = "";
      }

      // Auto-save analysis
      if (config.autoSaveAnalyses !== false) {
        try {
          const metadata = analysisStore.saveAnalysis({
            commandId: command.id || command.name || "unknown",
            prompt,
            model: resolvedModel,
            cwd,
            output: extractCleanOutput(stdout),
            exitCode: code,
            startedAt,
            completedAt,
            context: context || null,
          });
          sendToRenderer("claude:analysis-saved", metadata);
        } catch (err) {
          console.error("[Claude] Failed to save analysis:", err.message);
        }
      }

      if (code === 0) {
        resolve({ output: stdout.trim(), exitCode: code });
      } else {
        reject(
          new Error(`Claude exited with code ${code}: ${stderr.trim() || stdout.trim()}`),
        );
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      activeProcess = null;
      console.error(`[Claude] Spawn error: ${err.message}`);
      reject(new Error(`Failed to spawn Claude: ${err.message}`));
    });
  });
}

// Helper — send IPC to renderer safely
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// --- App Lifecycle ---

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
