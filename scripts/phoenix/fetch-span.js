#!/usr/bin/env node
/**
 * Fetch full detail for a single Phoenix span (escape hatch for prompt inspection).
 */

const { parseArgs } = require('node:util');
const { PhoenixClient } = require('./common');

async function fetchSpan(spanId, project) {
  const client = new PhoenixClient();
  const projectId = project;

  const allSpans = await client.paginateSpans(projectId, { limit: 100, maxPages: 5 });
  const matching = allSpans.filter((s) => (s.context || {}).span_id === spanId);

  if (!matching.length) {
    console.log(`Span '${spanId}' not found in recent data.`);
    process.exit(1);
  }

  const cleaned = cleanSpan(matching[0]);
  console.log(JSON.stringify(cleaned, null, 2));
}

function cleanSpan(span) {
  const attrs = span.attributes || {};
  const cleanedAttrs = {};

  for (const [key, val] of Object.entries(attrs)) {
    if (key.includes('content_filter')) continue;
    if (key === 'system_fingerprint') continue;
    if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
      try {
        cleanedAttrs[key] = JSON.parse(val);
        continue;
      } catch {}
    }
    cleanedAttrs[key] = val;
  }

  return { ...span, attributes: cleanedAttrs };
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: 'string' },
  },
});

if (!positionals.length || !values.project) {
  console.error('Usage: node fetch-span.js <span_id> --project <id>');
  process.exit(1);
}

fetchSpan(positionals[0], values.project).catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
