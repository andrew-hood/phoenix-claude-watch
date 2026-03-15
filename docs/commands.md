# Commands

Commands are declarative JSON files in `commands/`. Drop a new `.json` file to add a command — no code changes needed.

## Schema

```json
{
  "name": "Analyze Trace",
  "description": "Fetch and analyze a single trace",
  "icon": "Activity",
  "prompt": "Run: node scripts/phoenix/fetch-trace.js {{traceId}} --project {{projectId}}\n\nAnalyze the output...",
  "model": "sonnet",
  "workingDir": null,
  "context": ["trace"]
}
```

| Field        | Required | Description                                                                 |
| ------------ | -------- | --------------------------------------------------------------------------- |
| `name`       | Yes      | Display name shown in command list and palette                              |
| `description`| Yes      | Short help text                                                             |
| `icon`       | No       | Lucide icon name (e.g. `Activity`, `Microscope`)                            |
| `prompt`     | Yes      | Full prompt sent to Claude CLI. Supports `{{templateVar}}` interpolation    |
| `model`      | No       | Model alias (`sonnet`, `opus`, `haiku`) or full model ID. Defaults to sonnet|
| `workingDir` | No       | Override working directory. `null` uses the configured default              |
| `context`    | No       | Array of contexts where this command appears. Omit to show everywhere       |

## Template Variables

Prompts support `{{variableName}}` placeholders. These are populated from:

1. **Phoenix context** (auto-populated from iframe URL): `projectId`, `traceId`, `spanId`, `spanNodeId`, `sessionId`, `project` (alias for projectId)
2. **Explicit args** passed via `runCommand(commandId, args)`
3. **Default args** via `{{args}}` — commands can accept free-form arguments (e.g., `--hours 72 --limit 5`)

Example: `"prompt": "Analyze trace {{traceId}} in project {{projectId}}"` — both values are extracted from the current Phoenix URL automatically.

## Context Filtering

The `context` field controls when a command appears in the UI based on the user's current Phoenix navigation state:

| Context    | When Active                          |
| ---------- | ------------------------------------ |
| `global`   | Always                               |
| `projects` | Viewing the projects list            |
| `project`  | Inside a specific project            |
| `trace`    | Viewing a specific trace             |
| `span`     | Viewing a specific span              |
| `session`  | Viewing a specific session           |

Commands without a `context` field appear in all contexts.

## Existing Commands

| File                   | Name            | Context  | Purpose                                      |
| ---------------------- | --------------- | -------- | -------------------------------------------- |
| `phoenix-trace.json`   | Analyze Trace   | trace    | Analyze a single trace                       |
| `phoenix-span.json`    | Analyze Span    | span     | Inspect a specific span (prompts, responses) |
| `phoenix-batch.json`   | Analyze Project | project  | Batch analysis over recent traces            |
| `phoenix-session.json` | Analyze Session | session  | Analyze traces within a session              |
