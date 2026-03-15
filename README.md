# Phoenix Claude Shell

An Electron wrapper that overlays Claude Code integration onto the Phoenix LiveDashboard — without modifying Phoenix at all.

## Architecture

```
┌──────────────────────────────────────────┐
│           Electron App                   │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │    BrowserWindow (Renderer)        │  │
│  │    Phoenix UI @ localhost:6006     │  │
│  │    + Injected overlay (⌘K palette) │  │
│  └──────────┬─────────────────────────┘  │
│             │ IPC via contextBridge       │
│  ┌──────────▼─────────────────────────┐  │
│  │    Main Process (Node.js)          │  │
│  │    - Loads commands from /commands  │  │
│  │    - Spawns `claude --print`       │  │
│  │    - Streams output back via IPC   │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

### How it works (Chrome Extension mental model)

| Chrome Extension | Electron Equivalent (this project) |
|---|---|
| Content Script | `src/injections/phoenix-overlay.js` |
| Background Script | `src/main.js` (main process) |
| `chrome.runtime.sendMessage` | `ipcRenderer.invoke` via preload |
| Popup / Sidebar | Command palette (⌘K) |
| Manifest permissions | `webPreferences` in BrowserWindow |

## Quick Start

### Prerequisites

- Node.js 18+
- Phoenix running locally (`localhost:6006`)
- Claude Code CLI installed and in PATH (`claude --version`)

### Setup

```bash
cd phoenix-claude-shell
npm install
```

### Run

```bash
# Start Phoenix first (in your project)
# Then:
npm start

# With DevTools:
npm run dev
```

### Usage

1. The app opens Phoenix in an Electron window
2. Look for the ⚡ button in the bottom-right corner
   - Green dot = Claude CLI detected
   - Red dot = Claude CLI not found
3. Click the button or press **⌘K** (Ctrl+K on Linux) to open the command palette
4. Select a command to run
5. Output streams in real-time in the bottom panel

## Adding Commands

Drop a JSON file in the `commands/` directory:

```json
{
  "name": "My Command",
  "description": "What it does",
  "icon": "🚀",
  "prompt": "The prompt to send to Claude Code",
  "model": "sonnet",
  "workingDir": "/path/to/project"
}
```

### Template Variables

Use `{{variableName}}` in prompts — these are replaced at runtime:

```json
{
  "prompt": "Review the code in {{projectDir}}",
  "workingDir": "{{projectDir}}"
}
```

Pass args when calling: `window.claudeShell.runCommand('my-cmd', { projectDir: '/path' })`

### Included Example Commands

| Command | Description | Model |
|---|---|---|
| `analyze-traces` | Summarize Phoenix trace patterns | Sonnet |
| `generate-tests` | Generate tests for recent git changes | Sonnet |
| `code-review` | Review staged git changes | Sonnet |
| `project-status` | Quick git log + branch + TODOs | Haiku |

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `PHOENIX_URL` | `http://localhost:6006` | Phoenix dashboard URL |
| `CLAUDE_BIN` | `claude` | Path to Claude Code CLI binary |
| `NODE_ENV` | - | Set to `development` for DevTools |

## Project Structure

```
phoenix-claude-shell/
├── commands/               # Predefined command definitions (JSON)
│   ├── analyze-traces.json
│   ├── code-review.json
│   ├── generate-tests.json
│   └── project-status.json
├── src/
│   ├── main.js             # Electron main process (IPC + Claude spawning)
│   ├── preload.js          # Context bridge (safe API for renderer)
│   └── injections/
│       ├── phoenix-overlay.js   # Injected UI (command palette, FAB, output panel)
│       └── phoenix-overlay.css  # Injected styles
├── package.json
└── README.md
```

## Next Steps / Ideas

- [ ] Add argument prompting UI (modal that asks for `{{templateVars}}` before running)
- [ ] Persist command history / recent outputs
- [ ] Add a "custom prompt" freeform input in the palette
- [ ] WebSocket connection to stream Phoenix trace data as context into Claude prompts
- [ ] Tray icon with global shortcut for triggering commands from anywhere
- [ ] Auto-detect project directory from Phoenix trace metadata
