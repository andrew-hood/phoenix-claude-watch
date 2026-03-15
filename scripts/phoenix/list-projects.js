#!/usr/bin/env node
/**
 * List all projects in a Phoenix instance.
 */

const { parseArgs } = require('node:util');
const { PhoenixClient } = require('./common');

async function listProjects(asJson = false) {
  const client = new PhoenixClient();
  const data = await client._fetch('/v1/projects');
  const projects = data.data || [];

  if (!projects.length) {
    console.log('No projects found.');
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }

  console.log(`${'Name'.padEnd(30)} ${'ID'.padEnd(40)}`);
  console.log(`${'-'.repeat(30)} ${'-'.repeat(40)}`);
  for (const p of [...projects].sort((a, b) => (a.name || '').localeCompare(b.name || ''))) {
    console.log(`${(p.name || '?').padEnd(30)} ${(p.id || '?').padEnd(40)}`);
  }
}

const { values } = parseArgs({
  options: {
    json: { type: 'boolean', default: false },
  },
});

listProjects(values.json).catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
