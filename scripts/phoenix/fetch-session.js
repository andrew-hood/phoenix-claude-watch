#!/usr/bin/env node
/**
 * Fetch and summarize Phoenix traces for a specific session.
 */

const { parseArgs } = require('node:util');
const { PhoenixClient, stripSpan, estimateCost, formatTable, formatDuration } = require('./common');

async function fetchSession(project, sessionId, hours, limit, asJson = false) {
  const client = new PhoenixClient();

  // Decode sessionId variants for flexible matching
  let decodedId = sessionId;
  try {
    decodedId = decodeURIComponent(sessionId);
  } catch {}
  let base64Decoded = null;
  try {
    base64Decoded = Buffer.from(decodedId, 'base64').toString('utf-8');
  } catch {}

  const candidates = [decodedId, sessionId];
  if (base64Decoded && base64Decoded !== decodedId) candidates.push(base64Decoded);
  // Also try partial match (prefix)
  const candidateSet = new Set(candidates);

  const startTime = new Date(Date.now() - hours * 3600000).toISOString();
  const maxPages = Math.min(20, Math.max(1, Math.floor(limit / 5)));

  const allSpans = await client.paginateSpans(project, { limit: 100, maxPages, startTime });

  if (!allSpans.length) {
    console.log(`No spans found in the last ${hours}h.`);
    process.exit(1);
  }

  // Filter spans by session.id match
  const stripped = allSpans.map(stripSpan);
  const sessionSpans = stripped.filter((s) => {
    const sid = s.session_id;
    if (!sid) return false;
    if (candidateSet.has(sid)) return true;
    // Partial/prefix match
    for (const c of candidateSet) {
      if (sid.startsWith(c) || c.startsWith(sid)) return true;
    }
    return false;
  });

  if (!sessionSpans.length) {
    console.log(`No spans found for session "${decodedId}" in the last ${hours}h.`);
    console.log(`Total spans scanned: ${stripped.length}`);
    const sessionIds = [...new Set(stripped.filter((s) => s.session_id).map((s) => s.session_id))];
    if (sessionIds.length) {
      console.log(`Available sessions: ${sessionIds.slice(0, 10).join(', ')}${sessionIds.length > 10 ? ` (+${sessionIds.length - 10} more)` : ''}`);
    }
    process.exit(1);
  }

  // Group by trace
  const byTrace = {};
  for (const s of sessionSpans) {
    const tid = s.trace_id || '';
    if (tid) (byTrace[tid] ||= []).push(s);
  }

  const traceIds = Object.keys(byTrace)
    .sort((a, b) => {
      const maxA = byTrace[a].reduce((m, s) => (s.start_time || '') > m ? s.start_time : m, '');
      const maxB = byTrace[b].reduce((m, s) => (s.start_time || '') > m ? s.start_time : m, '');
      return maxB.localeCompare(maxA);
    })
    .slice(0, limit);

  const traceSummaries = traceIds.map((tid) => summarizeTrace(tid, byTrace[tid]));

  if (asJson) {
    console.log(JSON.stringify({
      session_id: decodedId,
      hours,
      trace_count: traceSummaries.length,
      span_count: sessionSpans.length,
      traces: traceSummaries,
      aggregates: computeAggregates(traceSummaries),
    }, null, 2));
    return;
  }

  printReport(traceSummaries, decodedId, hours, sessionSpans.length);
}

function summarizeTrace(traceId, spans) {
  const spanIdSet = new Set(spans.map((s) => s.span_id));
  const rootSpans = spans.filter((s) => !s.parent_id || !spanIdSet.has(s.parent_id));
  const root = rootSpans[0] || spans[0];

  const llmSpans = spans.filter((s) => s.span_kind === 'LLM');
  const totalTokens = llmSpans.reduce((sum, s) => sum + ((s.tokens || {}).total || 0), 0);
  const promptTokens = llmSpans.reduce((sum, s) => sum + ((s.tokens || {}).prompt || 0), 0);
  const completionTokens = llmSpans.reduce((sum, s) => sum + ((s.tokens || {}).completion || 0), 0);

  const errors = spans.filter((s) => !['OK', 'UNSET'].includes(s.status_code) && s.status_code != null);
  const errorMessages = errors.map((s) => `${s.name}: ${s.status_message || ''}`);

  const agentType = extractAgentType(root.name || '');

  const allTools = [];
  for (const s of spans) {
    if (s.tool_calls_requested) allTools.push(...s.tool_calls_requested);
  }

  const cost = estimateCost(spans);

  return {
    trace_id: traceId,
    trace_id_short: traceId.slice(0, 12),
    root_name: root.name || '?',
    start_time: root.start_time || '',
    duration_ms: Math.max(...spans.map((s) => s.duration_ms || 0)),
    span_count: spans.length,
    total_tokens: totalTokens,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    error_count: errors.length,
    errors: errorMessages,
    agent_type: agentType,
    tool_calls: allTools,
    cost_usd: cost.total_cost_usd,
    status: errors.length ? 'ERROR' : 'OK',
  };
}

function extractAgentType(name) {
  const m = name.match(/^U:\d+:P:\d+:(\w+)/);
  if (m) return m[1];
  if (name.includes('ChatCompletion')) return 'llm_call';
  return name.split('(')[0].trim() || 'unknown';
}

function computeAggregates(summaries) {
  if (!summaries.length) return {};

  const durations = summaries.filter((s) => s.duration_ms).map((s) => s.duration_ms);
  const tokens = summaries.map((s) => s.total_tokens);
  const costs = summaries.map((s) => s.cost_usd);
  const errorCount = summaries.filter((s) => s.error_count > 0).length;

  const durationsSorted = [...durations].sort((a, b) => a - b);
  const n = durationsSorted.length;

  const byType = {};
  for (const s of summaries) {
    (byType[s.agent_type] ||= []).push(s);
  }

  const typeStats = {};
  for (const [atype, traces] of Object.entries(byType)) {
    typeStats[atype] = {
      count: traces.length,
      avg_duration_ms: Math.round(traces.reduce((sum, t) => sum + t.duration_ms, 0) / traces.length),
      avg_tokens: Math.round(traces.reduce((sum, t) => sum + t.total_tokens, 0) / traces.length),
      error_rate: Math.round((traces.filter((t) => t.error_count > 0).length / traces.length) * 100) / 100,
    };
  }

  const allErrors = summaries.flatMap((s) => s.errors);
  const errorCounts = {};
  for (const e of allErrors) errorCounts[e] = (errorCounts[e] || 0) + 1;
  const topErrors = Object.fromEntries(
    Object.entries(errorCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)
  );

  return {
    trace_count: summaries.length,
    avg_duration_ms: n ? Math.round(durations.reduce((a, b) => a + b, 0) / n) : 0,
    p50_duration_ms: n ? durationsSorted[Math.floor(n / 2)] : 0,
    p95_duration_ms: n ? durationsSorted[Math.floor(n * 0.95)] : 0,
    total_tokens: tokens.reduce((a, b) => a + b, 0),
    avg_tokens: tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : 0,
    total_cost_usd: Math.round(costs.reduce((a, b) => a + b, 0) * 10000) / 10000,
    error_rate: summaries.length ? Math.round((errorCount / summaries.length) * 100) / 100 : 0,
    by_agent_type: typeStats,
    top_errors: topErrors,
  };
}

function printReport(summaries, sessionId, hours, totalSpans) {
  const agg = computeAggregates(summaries);

  console.log(`═══ SESSION ANALYSIS: ${sessionId} (${summaries.length} traces, ${totalSpans} spans, last ${hours}h) ═══`);
  console.log();

  // Trace list table
  console.log('─── Traces ───');
  const columns = [
    ['trace_id_short', 'Trace ID', 12],
    ['agent_type', 'Agent Type', 14],
    ['start_time_short', 'Time', 20],
    ['duration_str', 'Duration', 10],
    ['total_tokens', 'Tokens', 8],
    ['status', 'Status', 8],
    ['cost_str', 'Cost', 8],
  ];
  const rows = summaries.map((s) => ({
    ...s,
    start_time_short: s.start_time ? new Date(s.start_time).toISOString().slice(0, 19).replace('T', ' ') : '?',
    duration_str: formatDur(s.duration_ms),
    cost_str: `$${s.cost_usd.toFixed(4)}`,
  }));
  console.log(formatTable(rows, columns));
  console.log();

  // Aggregates
  console.log('─── Aggregates ───');
  console.log(`Avg duration: ${formatDur(agg.avg_duration_ms || 0)}`);
  console.log(`P50 duration: ${formatDur(agg.p50_duration_ms || 0)}`);
  console.log(`P95 duration: ${formatDur(agg.p95_duration_ms || 0)}`);
  console.log(`Total tokens: ${(agg.total_tokens || 0).toLocaleString()}`);
  console.log(`Avg tokens/trace: ${(agg.avg_tokens || 0).toLocaleString()}`);
  console.log(`Total cost: $${(agg.total_cost_usd || 0).toFixed(4)}`);
  console.log(`Error rate: ${Math.round((agg.error_rate || 0) * 100)}%`);
  console.log();

  // Timeline
  if (summaries.length > 1) {
    console.log('─── Timeline ───');
    const sorted = [...summaries].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
    for (const s of sorted) {
      const time = s.start_time ? new Date(s.start_time).toISOString().slice(11, 19) : '??:??:??';
      const bar = '█'.repeat(Math.min(20, Math.max(1, Math.round(s.duration_ms / (agg.avg_duration_ms || 1) * 5))));
      console.log(`  ${time} ${s.trace_id_short} ${bar} ${formatDur(s.duration_ms)} ${s.status === 'ERROR' ? '✗' : '✓'}`);
    }
    console.log();
  }

  // Agent type breakdown
  const byType = agg.by_agent_type || {};
  if (Object.keys(byType).length) {
    console.log('─── By Agent Type ───');
    const typeRows = Object.entries(byType)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([atype, stats]) => ({
        type: atype,
        count: stats.count,
        avg_dur: formatDur(stats.avg_duration_ms),
        avg_tok: stats.avg_tokens.toLocaleString(),
        err_rate: `${Math.round(stats.error_rate * 100)}%`,
      }));
    const typeColumns = [
      ['type', 'Type', 14],
      ['count', 'Count', 6],
      ['avg_dur', 'Avg Dur', 10],
      ['avg_tok', 'Avg Tok', 10],
      ['err_rate', 'Err Rate', 8],
    ];
    console.log(formatTable(typeRows, typeColumns));
    console.log();
  }

  // Top errors
  const topErrors = agg.top_errors || {};
  if (Object.keys(topErrors).length) {
    console.log('─── Top Errors ───');
    for (const [err, count] of Object.entries(topErrors)) {
      console.log(`  (${count}x) ${err}`);
    }
    console.log();
  }

  // Outliers
  if (summaries.length) {
    const slowest = summaries.reduce((a, b) => a.duration_ms > b.duration_ms ? a : b);
    const mostTokens = summaries.reduce((a, b) => a.total_tokens > b.total_tokens ? a : b);
    console.log('─── Outliers ───');
    console.log(`Slowest: ${slowest.trace_id_short} (${formatDur(slowest.duration_ms)}) - ${slowest.root_name}`);
    console.log(`Most tokens: ${mostTokens.trace_id_short} (${mostTokens.total_tokens.toLocaleString()} tok) - ${mostTokens.root_name}`);
    console.log();
  }
}

function formatDur(ms) {
  if (!ms) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

const { values } = parseArgs({
  options: {
    session: { type: 'string' },
    project: { type: 'string' },
    hours: { type: 'string', default: '24' },
    limit: { type: 'string', default: '50' },
    json: { type: 'boolean', default: false },
  },
});

if (!values.project || !values.session) {
  console.error('Usage: node fetch-session.js --project <id> --session <sessionId> [--hours N] [--limit N] [--json]');
  process.exit(1);
}

fetchSession(values.project, values.session, parseInt(values.hours), parseInt(values.limit), values.json).catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
