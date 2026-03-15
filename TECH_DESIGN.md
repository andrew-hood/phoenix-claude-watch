# Phoenix Claude Shell v2

**Technical Design Document**

| Field    | Value                                |
| -------- | ------------------------------------ |
| Document | Tech Design: Phoenix Claude Shell v2 |
| Author   | Andrew Hood                          |
| Date     | 13 March 2026                        |
| Status   | Draft                                |
| Project  | phoenix-claude-shell                 |

---

## 1. Overview

Phoenix Claude Shell is an Electron application that wraps the Phoenix LiveDashboard (localhost:6006) and augments it with Claude Code integration. The current v1 implementation overlays a floating command palette and output panel on top of the Phoenix UI via DOM injection.

This v2 redesign introduces a persistent split-pane layout, a dedicated Claude sidebar panel, and a file-based analysis persistence layer that captures and organises Claude Code outputs for later reference.

---

## 2. Goals

- **Split-pane layout:** Replace the overlay model with a first-class two-panel architecture where Phoenix and the Claude panel coexist as peers.
- **Analysis persistence:** Save every Claude Code output to the filesystem with metadata, enabling a browsable history of analyses.
- **Minimal Phoenix coupling:** Keep Phoenix completely unmodified. The Electron shell owns all custom UI.
- **Fast iteration:** Ship a working prototype quickly, then refine. Favour simplicity over abstraction.

---

## 3. Architecture

### 3.1 Layout Model

The current v1 approach injects a FAB, command palette, and output panel directly into the Phoenix DOM. This is fragile — Phoenix re-renders can clobber injected elements, and the overlay competes with Phoenix's own UI for z-index and focus.

V2 moves to a single-window shell architecture. The Electron BrowserWindow loads a local shell.html file that owns the entire viewport. The layout is a CSS flexbox split:

```
┌─────────────────────────────────┬──────────────────────┐
│                                 │  Claude Panel        │
│                                 │                      │
│  Phoenix UI (iframe)            │  Header + Health     │
│  localhost:6006                 │  Command List        │
│                                 │  ────────────────    │
│  65–70% width                   │  Output Stream       │
│                                 │  (scrollable)        │
│                                 │                      │
│                                 │  Analysis History    │
│                                 │  [Cancel] [Copy]     │
└─────────────────────────────────┴──────────────────────┘
```

### 3.2 Component Breakdown

| Component      | Technology         | Responsibility                                                                                    |
| -------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| shell.html     | HTML/CSS           | Root layout. Flexbox split with iframe (left) and Claude panel (right). Draggable divider.        |
| Phoenix iframe | iframe             | Loads localhost:6006. Fully sandboxed — no injection needed.                                      |
| Claude Panel   | HTML/CSS/JS        | Rendered directly in shell.html. Owns command list, output stream, analysis history, and toolbar. |
| Main Process   | Node.js (Electron) | IPC handlers, Claude CLI spawning, file I/O for analysis persistence.                             |
| Preload        | contextBridge      | Exposes claudeShell API to the renderer (shell.html).                                             |

### 3.3 Chrome Extension Mental Model

The v2 architecture simplifies the Chrome Extension analogy. Since the Claude panel is now native to the shell (not injected into Phoenix), fewer extension concepts apply:

| Chrome Extension Concept   | v1 (Overlay)               | v2 (Split Pane)                     |
| -------------------------- | -------------------------- | ----------------------------------- |
| Content Script             | phoenix-overlay.js (heavy) | ⌘K shortcut listener only (minimal) |
| Background Script          | main.js                    | main.js (unchanged)                 |
| Popup / Sidebar            | Floating palette + output  | Claude Panel (native sidebar)       |
| chrome.runtime.sendMessage | ipcRenderer.invoke         | ipcRenderer.invoke (unchanged)      |

---

## 4. Split-Pane Implementation

### 4.1 Why iframe Over BrowserView

Electron's BrowserView API provides better isolation but introduces complexity around z-ordering, focus management, and resizing. For a prototype, a single BrowserWindow loading shell.html with an iframe is simpler and sufficient. The iframe loads Phoenix at localhost:6006 and the Claude panel renders as a sibling div.

### 4.2 shell.html Structure

The shell is a minimal HTML file with a three-part flexbox layout:

1. **Phoenix iframe** — flex-grow container, takes remaining space (default ~67%).
2. **Drag handle** — a 4px-wide div that listens for mousedown/mousemove to resize the split.
3. **Claude panel** — fixed initial width (380px), contains all Claude UI.

### 4.3 Draggable Divider

A small JS handler on the drag handle tracks mouse position and updates the flex-basis of the Claude panel. During drag, an overlay div covers the iframe to prevent it from swallowing mouse events. The split ratio is persisted to a local config file so it survives restarts.

### 4.4 ⌘K Command Palette

The command palette remains a global overlay triggered by ⌘K (Ctrl+K on Linux). It renders as an absolutely positioned modal over the entire shell, not scoped to either panel. This is the only piece of UI that overlays both panels.

The keyboard shortcut is registered in shell.html's own JS, not injected into Phoenix. This eliminates the need for any Phoenix DOM injection.

---

## 5. Claude Panel Design

### 5.1 Panel Sections

The Claude panel is divided into four vertical sections, top to bottom:

| Section       | Height         | Content                                                                                                                                       |
| ------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Header        | Fixed (~48px)  | App title, Claude CLI version, health indicator (green/red dot), collapse toggle.                                                             |
| Command List  | Fixed (~120px) | Compact list of available commands from /commands/\*.json. Each row shows icon, name, and a run button. Scrolls if many commands.             |
| Output Stream | Flex-grow      | Streaming Claude Code output. Color-coded: white for stdout, yellow for stderr, grey italic for meta, red for errors. Auto-scrolls to bottom. |
| Toolbar       | Fixed (~40px)  | Action buttons: Cancel (during run), Copy Output, Clear, Save Analysis. Status text on the left.                                              |

### 5.2 Output Stream Details

The output area uses a container div (not a pre tag) with individual span elements for each chunk. Each span has a CSS class based on its type (stdout, stderr, meta, error) for color-coding. The container auto-scrolls unless the user has manually scrolled up, in which case a "scroll to bottom" indicator appears.

Before each command execution, the output area displays a meta line showing the exact CLI invocation and working directory. This aids debugging when commands fail.

### 5.3 Analysis History Tab

Below the output stream (or as a togglable tab), an analysis history section lists previously saved analyses. Each entry shows the command name, timestamp, and a preview of the first line. Clicking an entry loads its full output into the stream area for review.

---

## 6. Analysis Persistence

### 6.1 Design Philosophy

Every Claude Code execution produces an analysis that may be worth revisiting. Rather than treating outputs as ephemeral, v2 captures them to the filesystem with structured metadata. This creates a local knowledge base of analyses that can be browsed, searched, and referenced.

### 6.2 Storage Location

Analyses are stored under a configurable base directory, defaulting to:

```
~/.phoenix-claude-shell/analyses/
```

This keeps analysis data separate from the application code and survives app updates.

### 6.3 Directory Structure

Each analysis is saved as a directory containing the output and a metadata JSON file:

```
~/.phoenix-claude-shell/
  analyses/
    2026-03-13T06-08-41_analyze-traces/
      metadata.json
      output.md
    2026-03-13T06-15-22_code-review/
      metadata.json
      output.md
    2026-03-13T07-00-01_generate-tests/
      metadata.json
      output.md
  config.json
```

### 6.4 Metadata Schema

Each metadata.json captures everything needed to understand and reproduce the analysis:

```json
{
  "id": "2026-03-13T06-08-41_analyze-traces",
  "commandId": "analyze-traces",
  "commandName": "Analyze Traces",
  "prompt": "Analyze the recent traces...",
  "model": "claude-sonnet-4-6",
  "workingDir": "/Users/ahood/projects/ai-agent",
  "startedAt": "2026-03-13T06:08:41.000Z",
  "completedAt": "2026-03-13T06:09:12.000Z",
  "durationMs": 31000,
  "exitCode": 0,
  "status": "success",
  "outputSizeBytes": 2847,
  "tags": [],
  "notes": "",
  "trigger": "manual"
}
```

The `trigger` field indicates whether the analysis was run manually, via ⌘K, or via a scheduled cron job.

### 6.5 File Naming Convention

Directory names use the pattern `{ISO timestamp}_{command-id}`, with colons replaced by hyphens for filesystem compatibility. The timestamp prefix ensures natural chronological sorting in file explorers and ls output.

### 6.6 Output Format

The output.md file contains the raw Claude Code output as markdown. This format is chosen because Claude Code's output is typically markdown-formatted, making .md the natural storage format. It renders well in any editor and is easy to grep.

### 6.7 Auto-Save vs Manual Save

Two save modes are supported:

- **Auto-save (default):** Every completed command execution is automatically saved. Failed executions are also saved with a status of "failed" or "timeout" to preserve the error context.
- **Manual save:** Users can toggle auto-save off in config.json. In manual mode, a "Save" button appears in the toolbar after each execution.

### 6.8 Listing and Browsing Analyses

The Claude panel's history section reads the analyses directory and presents entries in reverse chronological order. The listing is loaded on app start and refreshed after each new analysis is saved.

Each list entry displays:

- Command icon and name
- Relative timestamp (e.g. "5 minutes ago", "yesterday")
- Status badge (success/failed/timeout)
- First 80 characters of the output as a preview

Clicking an entry loads the full output.md into the output stream area. A "Re-run" button allows re-executing the same command with the original parameters.

### 6.9 IPC API for Persistence

The main process exposes four new IPC handlers for analysis management:

| IPC Channel            | Direction       | Payload                           | Description                                              |
| ---------------------- | --------------- | --------------------------------- | -------------------------------------------------------- |
| claude:save-analysis   | Renderer → Main | `{ commandId, output, metadata }` | Save a completed analysis to disk.                       |
| claude:list-analyses   | Renderer → Main | `{ limit?, offset? }`             | Return paginated list of saved analyses (metadata only). |
| claude:load-analysis   | Renderer → Main | `{ analysisId }`                  | Load full output.md content for a specific analysis.     |
| claude:delete-analysis | Renderer → Main | `{ analysisId }`                  | Delete an analysis directory from disk.                  |

---

## 7. Configuration

Application configuration is stored in `~/.phoenix-claude-shell/config.json`:

```json
{
  "phoenixUrl": "http://localhost:6006",
  "claudeBin": "claude",
  "timeoutMs": 120000,
  "autoSaveAnalyses": true,
  "panelWidth": 380,
  "analysesDir": "~/.phoenix-claude-shell/analyses",
  "schedules": []
}
```

The `panelWidth` field persists the user's drag-handle position. The `schedules` array holds cron schedule definitions (see section 10). All fields have sensible defaults and the file is created on first launch if it doesn't exist.

---

## 8. File Changes from v1

### 8.1 New Files

| File                  | Purpose                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| src/shell.html        | Root HTML shell with flexbox split layout, iframe for Phoenix, and Claude panel markup.                                              |
| src/shell.css         | Styles for the shell layout, Claude panel, drag handle, command list, output stream, and history.                                    |
| src/shell.js          | Client-side JS for the Claude panel: command list rendering, output streaming, analysis history, drag handle, ⌘K palette.            |
| src/analysis-store.js | Main-process module for reading/writing analyses to the filesystem. Handles directory creation, metadata serialisation, and listing. |

### 8.2 Modified Files

| File           | Changes                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| src/main.js    | Load shell.html instead of Phoenix URL directly. Add IPC handlers for analysis CRUD. Add config loading/saving. Remove CSS/JS injection hooks (no longer needed). |
| src/preload.js | Extend contextBridge API with analysis methods: saveAnalysis, listAnalyses, loadAnalysis, deleteAnalysis.                                                         |
| package.json   | No dependency changes required — all new functionality uses Node.js built-ins (fs, path).                                                                         |

### 8.3 Removed Files

| File                               | Reason                                                   |
| ---------------------------------- | -------------------------------------------------------- |
| src/injections/phoenix-overlay.js  | All UI now lives in shell.html. No DOM injection needed. |
| src/injections/phoenix-overlay.css | Styles moved to shell.css.                               |

---

## 9. Data Flow

### 9.1 Command Execution Flow

1. User clicks a command in the sidebar list (or selects via ⌘K palette).
2. shell.js calls `window.claudeShell.runCommand(commandId, args)`.
3. Preload forwards to main process via `ipcRenderer.invoke('claude:run-command')`.
4. Main process resolves model alias, spawns `claude -p --model X "prompt"`.
5. stdout/stderr chunks are streamed to renderer via IPC (`claude:output-chunk`).
6. shell.js appends colour-coded spans to the output stream in real time.
7. On process exit, main process auto-saves the analysis (if enabled).
8. Main process sends `claude:analysis-saved` event to renderer with the new analysis metadata.
9. shell.js prepends the new entry to the history list.

### 9.2 Analysis Loading Flow

1. User clicks an entry in the analysis history list.
2. shell.js calls `window.claudeShell.loadAnalysis(analysisId)`.
3. Main process reads output.md from the analysis directory.
4. Content is returned to renderer and displayed in the output stream area.
5. Toolbar updates to show "Viewing saved analysis" with a Re-run button.

---

## 10. Future Considerations

### 10.1 Scheduled Analysis via Cron

The app should support scheduling commands to run on a recurring basis using cron expressions. This enables daily (or hourly, weekly, etc.) automated analysis runs — for example, a daily trace health check every morning before standup.

**Schedule definition** — stored in the `schedules` array in config.json:

```json
{
  "schedules": [
    {
      "id": "daily-trace-check",
      "commandId": "analyze-traces",
      "cron": "0 8 * * 1-5",
      "enabled": true,
      "args": {},
      "description": "Weekday morning trace analysis"
    }
  ]
}
```

**Implementation approach** — use `node-cron` (or `node-schedule`) in the main process to register cron jobs on app startup. When a scheduled job fires, it follows the same execution and persistence flow as a manual command, with `trigger: "scheduled"` in the metadata. If the app is not running when a schedule is due, the job is simply skipped (no catch-up logic in v2).

**UI considerations** — the Claude panel could include a "Schedules" section or a settings modal where users can create, edit, enable/disable, and delete schedules. Each schedule shows its cron expression in human-readable form (e.g. "Every weekday at 8:00 AM"), the command it runs, and the last run timestamp.

**Notification on completion** — when a scheduled analysis finishes, the app can surface a native macOS notification via Electron's `Notification` API so the user knows results are ready without needing the app in focus.

### 10.2 Other Future Ideas

- **Search across analyses:** Full-text search over output.md files using a simple grep-based approach or a lightweight index.
- **Tagging and filtering:** The metadata schema includes a tags array. A future UI could allow tagging analyses and filtering the history list.
- **Phoenix context injection:** Pipe Phoenix trace data (via the Phoenix API) as additional context into Claude prompts. This would make trace analysis commands significantly more useful.
- **Multi-command workflows:** Chain multiple commands together, with the output of one feeding into the prompt of the next.
- **Export and sharing:** Export analyses as PDF or share via a URL (requires a server component).
- **Tray icon with global shortcut:** Trigger commands from anywhere on the system without the app being focused.
- **BrowserView migration:** If iframe limitations become problematic (e.g. Phoenix sets X-Frame-Options), migrate to Electron's BrowserView for better isolation.
