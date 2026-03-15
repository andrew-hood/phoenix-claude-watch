# Analysis Persistence

Every Claude command execution is saved to disk as an "analysis" with structured metadata and raw output.

## Storage Layout

```
~/.phoenix-claude-shell/
  config.json                              # App config (panelWidth, autoSave, etc.)
  analyses/
    2026-03-13T06-08-41_analyze-traces/
      metadata.json                        # Structured metadata
      output.md                            # Raw Claude output
```

## Directory Naming

Pattern: `{ISO-timestamp}_{command-id}` — colons replaced with hyphens for filesystem compatibility. ISO prefix ensures natural chronological sorting.

## Metadata Schema

```json
{
  "id": "2026-03-13T06-08-41_analyze-traces",
  "commandId": "analyze-traces",
  "prompt": "The full prompt sent to Claude...",
  "model": "claude-sonnet-4-6",
  "cwd": "/Users/you/project",
  "exitCode": 0,
  "startedAt": "2026-03-13T06:08:41.000Z",
  "completedAt": "2026-03-13T06:09:12.000Z",
  "durationMs": 31000,
  "preview": "First 80 characters of output...",
  "context": { "projectId": "...", "traceId": "...", "spanId": "..." }
}
```

## Auto-Save vs Manual

- **Auto-save** (default, `autoSaveAnalyses: true` in config): Every completed execution is saved automatically, including failures
- **Manual**: Toggle `autoSaveAnalyses: false` in config — a Save button appears in the toolbar after each execution

## Context-Aware Filtering

Analyses store the Phoenix context (projectId, traceId, spanId, sessionId) at save time. When listing, results can be filtered hierarchically — the most specific match wins (spanId > traceId > projectId).

## History UI

The Claude panel shows the last 20 analyses in reverse chronological order (filtered by current context when on a specific project/trace/span) with:
- Relative timestamps ("5m ago", "2h ago")
- Status badge (green = success, red = error)
- First-line preview

Click to load the full output and navigate the Phoenix iframe to the original context.

## Security

Analysis IDs are validated against `/^[a-zA-Z0-9_-]+$/` and path traversal (`..`, `/`) is blocked.

## IPC API

| Channel                | Direction       | Payload                  | Returns                    |
| ---------------------- | --------------- | ------------------------ | -------------------------- |
| `claude:save-analysis` | Renderer → Main | `{ commandId, output, …}`| Saved metadata             |
| `claude:list-analyses` | Renderer → Main | `{ limit?, offset? }`    | Array of metadata objects  |
| `claude:load-analysis` | Renderer → Main | `{ analysisId }`         | Full analysis with output  |
| `claude:delete-analysis`| Renderer → Main| `{ analysisId }`         | `{ success }`              |
