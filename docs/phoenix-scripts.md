# Phoenix Scripts

Node CLI utilities in `scripts/phoenix/` that fetch and format data from the Phoenix API. These are invoked by command prompts (e.g., `node scripts/phoenix/fetch-trace.js {{traceId}}`).

## Configuration

Scripts load config from `~/.phoenix-claude-shell/config.json` with env var overrides:

| Variable         | Default                  | Purpose                    |
| ---------------- | ------------------------ | -------------------------- |
| `PHOENIX_URL`    | `http://localhost:6006`  | Phoenix API base URL       |
| `PHOENIX_API_KEY`| (optional)               | Bearer token for auth      |

## Scripts

### `list-projects.js`

List all Phoenix projects.

```bash
node scripts/phoenix/list-projects.js [--json]
```

### `fetch-trace.js`

Fetch and format a single trace with span tree, token summary, tool calls, errors, and annotations.

```bash
node scripts/phoenix/fetch-trace.js <trace_id|latest> --project <project_id> [--json]
```

### `fetch-span.js`

Fetch full span detail as raw JSON — useful for inspecting prompts and responses.

```bash
node scripts/phoenix/fetch-span.js <span_id> --project <project_id>
```

### `fetch-batch.js`

Batch analysis of recent traces with aggregated stats (avg/p50/p95 duration, token totals, cost estimates, agent type breakdown).

```bash
node scripts/phoenix/fetch-batch.js --project <project_id> [--hours 24] [--limit 20] [--json]
```

### `fetch-session.js`

Fetch and analyze traces within a Phoenix session — timeline visualization, aggregates, error patterns, and outliers.

```bash
node scripts/phoenix/fetch-session.js --project <project_id> --session <session_id> [--hours 24] [--limit 50] [--json]
```

Supports URL-decoded, base64-decoded, and prefix-match session ID variants for flexible matching.

## Common Module (`common.js`)

Shared utilities used by all scripts:

- **`PhoenixClient`** — HTTP client for Phoenix API v1 (projects, spans, trace annotations)
- **`stripSpan()`** — Extracts key fields from raw span data (name, duration, tokens, model, tool calls)
- **`buildSpanTree()`** — Builds parent-child span hierarchy
- **`estimateCost()`** — USD cost estimation from token counts using hardcoded model pricing (GPT-4o, GPT-4o-mini, etc.)
- **`formatTree()`** — ASCII tree visualization of span hierarchy
- **`formatTable()`** — Simple column-aligned table printer
- **`formatDuration()`** — Human-readable duration formatting
- **`extractPromptName()`** — Parses YAML frontmatter from first input message
- **`truncate()`** — Text truncation helper
