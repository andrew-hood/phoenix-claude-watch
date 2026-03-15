const fs = require("fs");
const path = require("path");
const os = require("os");

const ANALYSES_DIR = path.join(
  os.homedir(),
  ".phoenix-claude-shell",
  "analyses",
);

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function ensureDir() {
  fs.mkdirSync(ANALYSES_DIR, { recursive: true });
}

function generateId(commandId) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = commandId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `${ts}_${safe}`;
}

function saveAnalysis({ commandId, prompt, model, cwd, output, exitCode, startedAt, completedAt, context }) {
  ensureDir();
  const id = generateId(commandId);
  const dir = path.join(ANALYSES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const metadata = {
    id,
    commandId,
    prompt,
    model: model || null,
    cwd: cwd || null,
    exitCode,
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    preview: (output || "").slice(0, 80).replace(/\n/g, " "),
    context: context || null,
  };

  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(metadata, null, 2));
  fs.writeFileSync(path.join(dir, "output.md"), output || "");

  return metadata;
}

function listAnalyses({ limit = 20, offset = 0, context } = {}) {
  ensureDir();

  let dirs;
  try {
    dirs = fs.readdirSync(ANALYSES_DIR).filter((d) => {
      return fs.statSync(path.join(ANALYSES_DIR, d)).isDirectory();
    });
  } catch {
    return [];
  }

  // Reverse chronological (ISO timestamp prefix sorts naturally)
  dirs.sort().reverse();

  let items = dirs.map((d) => {
    try {
      const raw = fs.readFileSync(path.join(ANALYSES_DIR, d, "metadata.json"), "utf-8");
      return JSON.parse(raw);
    } catch {
      return { id: d, commandId: "unknown", preview: "(corrupt)" };
    }
  });

  // Filter by context hierarchically: spanId > traceId > projectId
  if (context) {
    items = items.filter((item) => {
      const c = item.context;
      if (!c) return false;
      if (context.spanId) return c.spanId === context.spanId;
      if (context.traceId) return c.traceId === context.traceId;
      if (context.projectId) return c.projectId === context.projectId;
      return true;
    });
  }

  return items.slice(offset, offset + limit);
}

function loadAnalysis(id) {
  if (!SAFE_ID_PATTERN.test(id) && !id.includes("_")) {
    // Allow IDs with underscores (our format) but block path traversal
    return null;
  }
  if (id.includes("..") || id.includes("/")) return null;

  const dir = path.join(ANALYSES_DIR, id);
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf-8"));
    const output = fs.readFileSync(path.join(dir, "output.md"), "utf-8");
    return { ...metadata, output };
  } catch {
    return null;
  }
}

function deleteAnalysis(id) {
  if (id.includes("..") || id.includes("/")) return false;

  const dir = path.join(ANALYSES_DIR, id);
  try {
    fs.rmSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { saveAnalysis, listAnalyses, loadAnalysis, deleteAnalysis };
