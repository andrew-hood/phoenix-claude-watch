# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Electron app that wraps Phoenix LiveDashboard in an iframe alongside a Claude Code sidebar panel. Split-pane layout — Phoenix on the left, Claude panel on the right with command execution, streaming output, and analysis history. No Phoenix modification required.

## Commands

```bash
npm install          # install deps
npm start            # run the app (requires Phoenix at localhost:6006)
npm run dev          # run with DevTools open (NODE_ENV=development)
```

No test framework is configured.

## Architecture

**Main process** (`src/main.js`): Electron app, IPC handlers, spawns `claude -p --output-format stream-json --verbose` CLI subprocess with streaming output. Loads command definitions from `commands/*.json` at runtime. Manages a single `activeProcess` for cancellation. Handles config persistence at `~/.phoenix-claude-shell/config.json`. Registers auth interceptor to inject `Authorization` header for Phoenix API requests.

**Preload** (`src/preload.js`): contextBridge exposes `window.claudeShell` API to the renderer. Methods for command execution, config, analysis CRUD, frame context, theme, and streaming subscriptions.

**Shell UI** (`src/shell.html` + `shell.js` + `shell.css`): Split-pane layout with Phoenix iframe (left) and Claude panel (right). Draggable divider persists width. Panel has three tabs: Observe (command pills, context bar, streaming output, recent history), History (full analysis list), and Schedules (placeholder). Phoenix iframe URL polled every 2s for context detection.

**Analysis store** (`src/analysis-store.js`): File-based persistence at `~/.phoenix-claude-shell/analyses/`. Each analysis gets a directory with `metadata.json` and `output.md`. Supports context-aware filtering (spanId > traceId > projectId). See `docs/analysis-persistence.md`.

**Commands** (`commands/*.json`): Declarative command definitions with `name`, `description`, `icon`, `prompt`, `model`, `workingDir`, and `context` (controls when commands appear based on Phoenix navigation state). Supports `{{templateVar}}` interpolation. Current commands: `phoenix-trace`, `phoenix-span`, `phoenix-batch`, `phoenix-session`. See `docs/commands.md`.

**Phoenix scripts** (`scripts/phoenix/`): Node CLI utilities for fetching data from the Phoenix API — traces, spans, batches, sessions, projects. Used by command prompts. See `docs/phoenix-scripts.md`.

## Key Patterns

- Model aliases in `main.js`: `sonnet` → `claude-sonnet-4-6`, `opus` → `claude-opus-4-6`, `haiku` → `claude-haiku-4-5`
- Structured JSON streaming — Claude CLI outputs NDJSON, renderer deduplicates assistant messages by ID and renders tool calls, thinking blocks, and token usage
- Phoenix context awareness — iframe URL is parsed to extract projectId/traceId/spanId/sessionId, commands filter by `context` field
- Output rendered as markdown via `marked` library, debounced at 50ms for smooth streaming
- Auto-save analyses on command completion (configurable)
- `PHOENIX_URL`, `PHOENIX_API_KEY`, `CLAUDE_BIN`, `CLAUDE_TIMEOUT_MS` env vars configure runtime behavior

## Conventions

- Plain JavaScript (no TypeScript, no bundler, no framework)
- All renderer UI is built via DOM manipulation in shell.js (IIFE)
- Vendored libs: `marked.umd.js`, `lucide.min.js` in `src/`
- No build step — source files run directly
