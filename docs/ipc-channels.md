# IPC Channels

All communication between the renderer (shell.js) and main process (main.js) goes through Electron's IPC via the `window.claudeShell` contextBridge API.

## Request-Response (invoke)

| Channel                  | Payload                     | Returns                          | Purpose                          |
| ------------------------ | --------------------------- | -------------------------------- | -------------------------------- |
| `claude:run-command`     | `{ commandId, args, context }`| `{ success, output?, exitCode? }`| Execute a Claude command         |
| `claude:cancel`          | —                           | `{ cancelled, reason? }`        | Cancel running command           |
| `claude:list-commands`   | —                           | Command array                    | Get available commands           |
| `claude:health`          | —                           | `{ available, version?, error? }`| Check Claude CLI availability    |
| `claude:get-config`      | —                           | Config object                    | Read app configuration           |
| `claude:save-config`     | Config object               | Updated config                   | Write app configuration          |
| `claude:get-settings`    | —                           | Settings object                  | Legacy settings accessor         |
| `claude:save-settings`   | Settings object             | Updated settings                 | Legacy settings mutator          |
| `claude:pick-folder`     | —                           | `{ canceled?, path? }`          | Native folder picker dialog      |
| `claude:get-frame-url`   | —                           | URL string                       | Get current Phoenix iframe URL   |
| `claude:save-analysis`   | Analysis data               | Saved metadata                   | Persist analysis to disk         |
| `claude:list-analyses`   | `{ limit?, offset?, context? }`| Metadata array                  | List saved analyses              |
| `claude:load-analysis`   | `{ analysisId }`            | Full analysis + output           | Load a specific analysis         |
| `claude:delete-analysis` | `{ analysisId }`            | `{ success }`                   | Delete an analysis               |

## Events (send → renderer)

| Channel                  | Payload                                  | Purpose                              |
| ------------------------ | ---------------------------------------- | ------------------------------------ |
| `claude:output-chunk`    | `{ commandId, chunk?, type?, event? }`   | Stream CLI output to renderer        |
| `claude:analysis-saved`  | Metadata object                          | Notify renderer of auto-saved result |
| `claude:frame-navigated` | `{ url }`                                | Phoenix iframe navigation event      |
| `claude:theme-changed`   | `{ theme }` (`"dark"` or `"light"`)      | System theme change notification     |

### Output Chunk Types

The `type` field in `claude:output-chunk` events:

| Type          | Content                                                    |
| ------------- | ---------------------------------------------------------- |
| `stdout`      | Raw stdout text                                            |
| `stderr`      | Raw stderr text                                            |
| `meta`        | Status messages (CLI invocation, working directory)         |
| `error`       | Error messages (timeout, spawn failure)                    |
| `json-event`  | Structured NDJSON event from `--output-format stream-json` |

### Structured JSON Events

When using `--output-format stream-json`, the `event` field contains typed objects:

- **`assistant`** — Assistant message with content blocks (text, tool_use, thinking)
- **`result`** — Final result with token usage stats
- **`tool_result`** — Tool execution output
