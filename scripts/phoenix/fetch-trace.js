#!/usr/bin/env node
/**
 * Fetch and analyze a single Phoenix trace with compact output.
 */

const { parseArgs } = require('node:util');
const { PhoenixClient, stripSpan, buildSpanTree, estimateCost, formatTree, formatDuration } = require('./common');

async function fetchTrace(traceId, project, asJson = false) {
  const client = new PhoenixClient();
  const projectId = project;

  let spans;
  if (traceId === 'latest') {
    spans = await fetchLatestTrace(client, projectId);
  } else {
    spans = await fetchByTraceId(client, projectId, traceId);
  }

  if (!spans.length) {
    console.log('No spans found for trace.');
    process.exit(1);
  }

  const stripped = spans.map(stripSpan);
  const actualTraceId = stripped[0].trace_id;

  const spanIds = spans.filter((s) => s.context).map((s) => s.context.span_id);
  let annotations = [];
  try {
    annotations = await client.getSpanAnnotations(projectId, spanIds);
  } catch {}

  if (asJson) {
    console.log(JSON.stringify({
      trace_id: actualTraceId,
      span_count: stripped.length,
      spans: stripped,
      cost: estimateCost(stripped),
      annotations,
    }, null, 2));
    return;
  }

  printReport(stripped, actualTraceId, annotations);
}

async function fetchLatestTrace(client, projectId) {
  const result = await client.getSpans(projectId, { limit: 100 });
  const spans = result.data || [];
  if (!spans.length) return [];

  const byTrace = {};
  for (const s of spans) {
    const tid = (s.context || {}).trace_id || '';
    if (tid) (byTrace[tid] ||= []).push(s);
  }

  let latestTid = null;
  let latestTime = '';
  for (const [tid, traceSpans] of Object.entries(byTrace)) {
    const maxTime = traceSpans.reduce((max, s) => {
      const t = s.start_time || '';
      return t > max ? t : max;
    }, '');
    if (maxTime > latestTime) {
      latestTime = maxTime;
      latestTid = tid;
    }
  }

  return byTrace[latestTid] || [];
}

async function fetchByTraceId(client, projectId, traceId) {
  for (const hours of [24, 72, 168]) {
    const startTime = new Date(Date.now() - hours * 3600000).toISOString();
    const allSpans = await client.paginateSpans(projectId, { limit: 100, maxPages: 5, startTime });
    const matching = allSpans.filter((s) => ((s.context || {}).trace_id || '').startsWith(traceId));
    if (matching.length) return matching;
  }
  return [];
}

function printReport(spans, traceId, annotations) {
  const firstTime = spans.reduce((min, s) => {
    const t = s.start_time || '';
    return !min || t < min ? t : min;
  }, '');
  const totalDuration = Math.max(...spans.map((s) => s.duration_ms || 0));

  const sessionId = spans.find((s) => s.session_id)?.session_id;
  const userId = spans.find((s) => s.user_id)?.user_id;

  console.log(`═══ TRACE: ${traceId} ═══`);
  console.log(`Time: ${firstTime}`);
  console.log(`Duration: ${formatDur(totalDuration)}`);
  console.log(`Spans: ${spans.length}`);
  if (sessionId) console.log(`Session: ${sessionId}`);
  if (userId) console.log(`User: ${userId}`);
  console.log();

  // Span tree
  const tree = buildSpanTree(spans);
  console.log('─── Span Tree ───');
  console.log(formatTree(tree));
  console.log();

  // Token summary (LLM spans only)
  const totalTokens = { prompt: 0, completion: 0, total: 0 };
  const byModel = {};
  for (const s of spans) {
    if (!s.tokens || s.span_kind !== 'LLM') continue;
    totalTokens.prompt += s.tokens.prompt || 0;
    totalTokens.completion += s.tokens.completion || 0;
    totalTokens.total += s.tokens.total || 0;
    const model = s.model || 'unknown';
    if (!byModel[model]) byModel[model] = { prompt: 0, completion: 0, total: 0 };
    byModel[model].prompt += s.tokens.prompt || 0;
    byModel[model].completion += s.tokens.completion || 0;
    byModel[model].total += s.tokens.total || 0;
  }

  if (totalTokens.total > 0) {
    console.log('─── Tokens ───');
    console.log(`Total: ${totalTokens.total.toLocaleString()} (prompt: ${totalTokens.prompt.toLocaleString()}, completion: ${totalTokens.completion.toLocaleString()})`);
    for (const [model, counts] of Object.entries(byModel)) {
      console.log(`  ${model}: ${counts.total.toLocaleString()} (p:${counts.prompt.toLocaleString()} c:${counts.completion.toLocaleString()})`);
    }
    const cost = estimateCost(spans);
    console.log(`Estimated cost: $${cost.total_cost_usd.toFixed(4)}`);
    console.log();
  }

  // Tool calls
  const allTools = [];
  for (const s of spans) {
    if (s.tool_calls_requested) allTools.push(...s.tool_calls_requested);
  }
  if (allTools.length) {
    console.log('─── Tool Calls ───');
    for (const t of allTools) console.log(`  • ${t}`);
    console.log();
  }

  // Errors
  const errors = spans.filter((s) => !['OK', 'UNSET'].includes(s.status_code) && s.status_code != null);
  if (errors.length) {
    console.log('─── Errors ───');
    for (const s of errors) console.log(`  ✗ [${s.name}] ${s.status_code}: ${s.status_message || ''}`);
    console.log();
  }

  // LLM response previews
  const llmSpans = spans.filter((s) => s.span_kind === 'LLM' && s.response_preview);
  if (llmSpans.length) {
    console.log('─── LLM Response Previews ───');
    for (const s of llmSpans) {
      const promptName = s.system_prompt_name || s.name || '?';
      console.log(`  [${promptName}] ${s.response_preview}`);
    }
    console.log();
  }

  // Annotations
  if (annotations.length) {
    console.log('─── Annotations ───');
    for (const a of annotations) {
      console.log(`  ${a.name || '?'}: ${a.label || ''} (score: ${a.score ?? 'N/A'})`);
      if (a.explanation) console.log(`    ${a.explanation.slice(0, 200)}`);
    }
    console.log();
  }
}

function formatDur(ms) {
  if (!ms) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

const traceId = positionals[0] || 'latest';

if (!values.project) {
  console.error('Usage: node fetch-trace.js [trace_id] --project <id> [--json]');
  process.exit(1);
}

fetchTrace(traceId, values.project, values.json).catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
