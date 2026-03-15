/**
 * Shared utilities for Phoenix trace analysis scripts.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_PATH = path.join(os.homedir(), ".phoenix-claude-shell", "config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

const _config = loadConfig();
const PHOENIX_URL = _config.phoenixUrl || process.env.PHOENIX_URL || "http://localhost:6006";
const PHOENIX_API_KEY = _config.phoenixApiKey || process.env.PHOENIX_API_KEY || "";

// Cost per 1M tokens (USD)
const MODEL_PRICING = {
  "gpt-4o": { prompt: 2.5, completion: 10.0 },
  "gpt-4o-mini": { prompt: 0.15, completion: 0.6 },
  "gpt-4o-2024-11-20": { prompt: 2.5, completion: 10.0 },
  "gpt-4o-2024-08-06": { prompt: 2.5, completion: 10.0 },
  "gpt-4o-mini-2024-07-18": { prompt: 0.15, completion: 0.6 },
  "gpt-4.1": { prompt: 2.0, completion: 8.0 },
  "gpt-4.1-mini": { prompt: 0.4, completion: 1.6 },
  "gpt-4.1-nano": { prompt: 0.1, completion: 0.4 },
};

class PhoenixClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = (baseUrl || PHOENIX_URL).replace(/\/+$/, "");
    this.apiKey = apiKey || PHOENIX_API_KEY;
    this.headers = { Accept: "application/json" };
    if (this.apiKey) {
      this.headers.Authorization = `Bearer ${this.apiKey}`;
    }
  }

  async _fetch(path, params) {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null) {
          if (Array.isArray(v)) {
            v.forEach((item) => url.searchParams.append(k, item));
          } else {
            url.searchParams.set(k, String(v));
          }
        }
      }
    }
    const resp = await fetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText} for ${path}`);
    }
    return resp.json();
  }

  async getSpans(projectId, { limit = 100, cursor, startTime, endTime } = {}) {
    const params = { limit };
    if (cursor) params.cursor = cursor;
    if (startTime) params.start_time = startTime;
    if (endTime) params.end_time = endTime;
    return this._fetch(`/v1/projects/${projectId}/spans`, params);
  }

  async getSpanAnnotations(projectId, spanIds) {
    try {
      const data = await this._fetch(
        `/v1/projects/${projectId}/span_annotations`,
        { span_ids: spanIds },
      );
      return data.data || [];
    } catch (e) {
      if (e.message.includes("404")) return [];
      throw e;
    }
  }

  async paginateSpans(
    projectId,
    { limit = 100, maxPages = 5, startTime, endTime } = {},
  ) {
    const allSpans = [];
    let cursor;
    for (let i = 0; i < maxPages; i++) {
      const result = await this.getSpans(projectId, {
        limit,
        cursor,
        startTime,
        endTime,
      });
      const spans = result.data || [];
      if (!spans.length) break;
      allSpans.push(...spans);
      cursor = result.next_cursor;
      if (!cursor) break;
    }
    return allSpans;
  }
}

function stripSpan(raw) {
  const attrs = raw.attributes || {};
  const ctx = raw.context || {};

  const start = parseTime(raw.start_time);
  const end = parseTime(raw.end_time);
  const durationMs = start && end ? Math.round((end - start) / 1) / 1 : null;

  const systemPromptName = extractPromptName(attrs);

  // Count input messages
  let inputMsgCount = 0;
  for (const key of Object.keys(attrs)) {
    const m = key.match(/^llm\.input_messages\.(\d+)\./);
    if (m) inputMsgCount = Math.max(inputMsgCount, parseInt(m[1]) + 1);
  }

  // Response preview
  const responsePreview = truncate(
    attrs["llm.output_messages.0.message.content"] || "",
    200,
  );

  // Tool calls requested
  const toolCalls = [];
  for (const [key, val] of Object.entries(attrs)) {
    if (
      /^llm\.output_messages\.\d+\.message\.tool_calls\.\d+\.tool_call\.function\.name$/.test(
        key,
      )
    ) {
      toolCalls.push(val);
    }
  }

  // LLM params
  let llmParams = null;
  const invParamsStr = attrs["llm.invocation_parameters"] || "";
  if (invParamsStr) {
    try {
      const inv = JSON.parse(invParamsStr);
      const params = {};
      if ("temperature" in inv) params.temperature = inv.temperature;
      if ("max_tokens" in inv) params.max_tokens = inv.max_tokens;
      if (Object.keys(params).length) llmParams = params;
    } catch {}
  }

  // Token counts
  const tokens = {};
  for (const suffix of ["prompt", "completion", "total"]) {
    const val = attrs[`llm.token_count.${suffix}`];
    if (val != null) tokens[suffix] = val;
  }
  const cacheRead = attrs["llm.token_count.prompt_details.cache_read"];
  if (cacheRead) tokens.cache_read = cacheRead;

  // Events
  const events = (raw.events || []).map((evt) => ({
    name: evt.name || "",
    message: truncate(evt.message || "", 200),
  }));

  const result = {
    name: raw.name,
    span_kind: raw.span_kind,
    trace_id: ctx.trace_id,
    span_id: ctx.span_id,
    parent_id: raw.parent_id,
    status_code: raw.status_code,
    status_message: raw.status_message || null,
    start_time: raw.start_time,
    duration_ms: durationMs,
    tokens: Object.keys(tokens).length ? tokens : null,
    model: attrs["llm.model_name"],
    provider: attrs.provider || attrs["llm.provider"],
    system_prompt_name: systemPromptName,
    input_message_count: inputMsgCount || null,
    response_preview: responsePreview || null,
    tool_calls_requested: toolCalls.length ? toolCalls : null,
    session_id: attrs["session.id"],
    user_id: attrs["user.id"],
    llm_params: llmParams,
    events: events.length ? events : null,
  };

  // Remove null/undefined values
  return Object.fromEntries(
    Object.entries(result).filter(([, v]) => v != null),
  );
}

function buildSpanTree(spans) {
  const byId = {};
  for (const s of spans) {
    s.children = [];
    byId[s.span_id] = s;
  }

  const roots = [];
  for (const s of spans) {
    const parent = s.parent_id;
    if (parent && byId[parent]) {
      byId[parent].children.push(s);
    } else {
      roots.push(s);
    }
  }

  function sortChildren(node) {
    node.children.sort((a, b) =>
      (a.start_time || "").localeCompare(b.start_time || ""),
    );
    for (const child of node.children) sortChildren(child);
  }

  roots.sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));
  for (const r of roots) sortChildren(r);
  return roots;
}

function estimateCost(spans) {
  const byModel = {};
  for (const s of spans) {
    const model = s.model;
    const tokens = s.tokens;
    if (!model || !tokens) continue;
    if (s.span_kind && s.span_kind !== "LLM") continue;
    if (!byModel[model]) byModel[model] = { prompt: 0, completion: 0 };
    byModel[model].prompt += tokens.prompt || 0;
    byModel[model].completion += tokens.completion || 0;
  }

  let totalCost = 0;
  const breakdown = {};
  for (const [model, counts] of Object.entries(byModel)) {
    let pricing = MODEL_PRICING[model];
    if (!pricing) {
      const base = model.split("-2024")[0].split("-2025")[0].split("-2026")[0];
      pricing = MODEL_PRICING[base] || { prompt: 2.5, completion: 10.0 };
    }
    const cost =
      (counts.prompt / 1_000_000) * pricing.prompt +
      (counts.completion / 1_000_000) * pricing.completion;
    breakdown[model] = {
      prompt_tokens: counts.prompt,
      completion_tokens: counts.completion,
      cost_usd: Math.round(cost * 1_000_000) / 1_000_000,
    };
    totalCost += cost;
  }

  return {
    total_cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
    by_model: breakdown,
  };
}

function formatTree(roots, indent = 0) {
  const lines = [];
  for (const node of roots) {
    const prefix = "  ".repeat(indent) + (indent > 0 ? "├─ " : "");
    const kindTag = `[${node.span_kind || "?"}]`;
    const duration = node.duration_ms;
    const durStr = duration != null ? formatDuration(duration) : "?";
    const status = node.status_code || "?";
    const statusMark = status === "OK" ? "✓" : `✗ ${node.status_message || ""}`;
    let tokenStr = "";
    if (node.tokens && node.span_kind === "LLM") {
      const total = node.tokens.total || 0;
      tokenStr = ` [${total.toLocaleString()} tok]`;
    }
    const modelStr = node.model ? ` (${node.model})` : "";
    lines.push(
      `${prefix}${kindTag} ${node.name || "?"} (${durStr}) ${statusMark}${modelStr}${tokenStr}`,
    );

    if (node.tool_calls_requested) {
      const toolPrefix = "  ".repeat(indent + 1) + "→ tools: ";
      lines.push(`${toolPrefix}${node.tool_calls_requested.join(", ")}`);
    }

    const childTree = formatTree(node.children || [], indent + 1);
    if (childTree) lines.push(childTree);
  }
  return lines.join("\n");
}

function formatTable(rows, columns) {
  const header = columns.map(([, h, w]) => h.padEnd(w)).join(" | ");
  const sep = columns.map(([, , w]) => "-".repeat(w)).join("-+-");
  const lines = [header, sep];
  for (const row of rows) {
    const line = columns
      .map(([k, , w]) =>
        String(row[k] ?? "")
          .slice(0, w)
          .padEnd(w),
      )
      .join(" | ");
    lines.push(line);
  }
  return lines.join("\n");
}

function parseTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function extractPromptName(attrs) {
  const content = attrs["llm.input_messages.0.message.content"] || "";
  if (!content) return null;
  const m = content.match(/^---\s*\n[\s\S]*?name:\s*(.+?)(?:\n|$)/);
  return m ? m[1].trim().slice(0, 80) : null;
}

function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

module.exports = {
  PhoenixClient,
  stripSpan,
  buildSpanTree,
  estimateCost,
  formatTree,
  formatTable,
  formatDuration,
  parseTime,
  truncate,
  MODEL_PRICING,
};
