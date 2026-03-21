(async function phoenixClaudeShell() {
  "use strict";

  // --- State ---
  let commands = [];
  let isHealthy = false;
  let isSettingsOpen = false;
  let currentOutput = "";
  let toolCallCount = 0;
  let isRunning = false;
  let userScrolled = false;
  let swarmMode = false;
  let specialistState = new Map(); // id -> { name, icon, output, tabBtn, panel, markdownEl, statusEl, status, debounceTimer, renderedBlockCounts }
  let swarmTabBar = null;
  let swarmTabPanels = null;
  let activeSwarmTabId = null;
  let currentContext = { type: "global", params: {}, path: "" };
  let activeTab = "observe";
  let currentSwarmSessionId = null;
  let availableSpecialists = [];
  const config = await window.claudeShell.getConfig();
  let phoenixUrl = config.phoenixUrl || "http://localhost:6006";
  const projectCache = {};

  // --- DOM refs ---
  const $ = (sel) => document.querySelector(sel);
  const frame = $("#phoenix-frame");
  const panel = $("#claude-panel");
  const outputEl = $("#output-content");
  const scrollIndicator = $("#scroll-indicator");
  const settingsOverlay = $("#settings-overlay");
  const btnSettings = $("#btn-settings");
  const toolbarStatus = $("#toolbar-status");
  const btnCancel = $("#btn-cancel");
  const btnCopy = $("#btn-copy");
  const btnClear = $("#btn-clear");
  const collapseBtn = $("#panel-collapse");
  const fullHistoryList = $("#full-history-list");
  const dragHandle = $("#drag-handle");
  const dragOverlay = $("#drag-overlay");
  const contextBar = $("#context-bar");
  const contextIcon = $("#context-icon");
  const contextLabel = $("#context-label");
  const contextDetail = $("#context-detail");
  const contextAction = $("#context-action");
  const outputEmpty = $("#output-empty");
  const commandPills = $("#command-pills");
  const progressBar = $("#progress-bar");
  const btnCopyText = $("#btn-copy-text");

  // --- Lucide Icon Helper ---
  function icon(name, size = 16) {
    const iconData = lucide.icons[name];
    if (!iconData) return name;
    const inner = iconData
      .map(([tag, attrs]) => {
        const a = Object.entries(attrs)
          .map(([k, v]) => `${k}="${v}"`)
          .join(" ");
        return `<${tag} ${a}/>`;
      })
      .join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  }

  // --- Command Pills ---
  function renderCommandPills() {
    const cmds = getContextCommands();
    commandPills.innerHTML = cmds
      .map(
        (cmd) =>
          `<button class="command-pill" data-command="${cmd.id}" title="${escapeHtml(cmd.description || '')}">
            ${icon(cmd.icon || 'play', 13)}
            ${escapeHtml(cmd.name)}
          </button>`,
      )
      .join("");

    commandPills.querySelectorAll(".command-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!isRunning) runCommand(btn.dataset.command);
      });
    });
  }

  function showEmptyState() {
    outputEmpty.classList.remove("hidden");
    outputEl.classList.add("hidden");
  }

  function hideEmptyState() {
    outputEmpty.classList.add("hidden");
    outputEl.classList.remove("hidden");
  }

  // --- Phoenix URL → Context Parsing ---
  // Phoenix LiveDashboard URL patterns:
  //   /projects                           → projects
  //   /projects/:projectId                → project
  //   /projects/:projectId/traces/:traceId → trace
  //   /projects/:projectId/spans/:spanId  → span
  //   Query: ?selectedSpanNodeId=xxx

  function parsePhoenixUrl(url) {
    if (!url) return { type: "global", params: {}, path: "" };

    let pathname, searchParams;
    try {
      const parsed = new URL(url);
      pathname = parsed.pathname;
      searchParams = parsed.searchParams;
    } catch {
      return { type: "global", params: {}, path: "" };
    }

    const params = {};
    const segments = pathname.split("/").filter(Boolean);

    // Extract project ID
    const projIdx = segments.indexOf("projects");
    if (projIdx !== -1 && segments[projIdx + 1]) {
      params.projectId = segments[projIdx + 1];
    }

    // Extract trace ID
    const traceIdx = segments.indexOf("traces");
    if (traceIdx !== -1 && segments[traceIdx + 1]) {
      params.traceId = segments[traceIdx + 1];
    }

    // Extract span ID
    const spanIdx = segments.indexOf("spans");
    if (spanIdx !== -1 && segments[spanIdx + 1]) {
      params.spanId = segments[spanIdx + 1];
    }

    // Extract session ID
    const sessIdx = segments.indexOf("sessions");
    if (sessIdx !== -1 && segments[sessIdx + 1]) {
      params.sessionId = segments[sessIdx + 1];
    }

    // Query params
    const selectedSpan = searchParams.get("selectedSpanNodeId");
    if (selectedSpan) params.spanNodeId = selectedSpan;

    // Determine context type
    let type = "global";
    if (spanIdx !== -1 && params.spanId) {
      type = "span";
    } else if (traceIdx !== -1 && params.traceId) {
      type = "trace";
    } else if (sessIdx !== -1 && params.sessionId) {
      type = "session";
    } else if (projIdx !== -1 && params.projectId) {
      type = "project";
    } else if (projIdx !== -1) {
      type = "projects";
    }

    return { type, params, path: pathname };
  }

  const CONTEXT_META = {
    global: { icon: "Globe", label: "Dashboard" },
    projects: { icon: "ClipboardList", label: "Projects" },
    project: { icon: "Folder", label: "Project" },
    trace: { icon: "Search", label: "Trace" },
    span: { icon: "Microscope", label: "Span" },
    session: { icon: "Users", label: "Session" },
  };

  async function updateContext(url) {
    const ctx = parsePhoenixUrl(url);
    // Skip if nothing changed
    if (ctx.type === currentContext.type && ctx.path === currentContext.path)
      return;
    currentContext = ctx;

    // Pass project ID directly for script --project flag
    if (ctx.params.projectId) {
      ctx.params.project = ctx.params.projectId;
    }
    // In span context, spanId is the same value as traceId
    if (ctx.type === "span" && ctx.params.spanId) {
      ctx.params.traceId = ctx.params.spanId;
    }
    // Pass session ID directly for script --session flag
    if (ctx.params.sessionId) {
      ctx.params.session = ctx.params.sessionId;
    }

    // Update context bar
    const meta = CONTEXT_META[ctx.type] || CONTEXT_META.global;
    contextIcon.innerHTML = icon(meta.icon, 14);
    contextLabel.textContent = meta.label;

    // Build detail string from extracted params
    const details = [];
    if (ctx.params.projectId) details.push(ctx.params.projectId);
    if (ctx.params.traceId)
      details.push(`trace:${ctx.params.traceId.slice(0, 8)}...`);
    if (ctx.params.spanId)
      details.push(`span:${ctx.params.spanId.slice(0, 8)}...`);
    if (ctx.params.sessionId)
      details.push(`session:${ctx.params.sessionId.slice(0, 8)}...`);
    if (ctx.params.spanNodeId)
      details.push(`node:${ctx.params.spanNodeId.slice(0, 8)}...`);
    contextDetail.textContent = details.join(" / ");

    // Show/hide lightning button, context bar, and history based on context commands
    const contextCmds = getContextCommands().filter(
      (cmd) => !(cmd.context || ["global"]).includes("global"),
    );
    const hasCmd = contextCmds.length > 0;
    contextBar.classList.toggle("hidden", !hasCmd);
    contextAction.classList.toggle("hidden", !hasCmd);
    if (hasCmd) {
      contextAction.innerHTML = `${icon("Zap", 14)}<span>${escapeHtml(contextCmds[0].name)}</span>`;
      contextAction.title = `Run: ${contextCmds[0].name} — ${contextCmds[0].description}`;
      contextAction.dataset.commandId = contextCmds[0].id;
    }
    renderCommandPills();

    console.log(`[Context] ${ctx.type}`, ctx.params);
  }

  // Get commands matching current context
  function getContextCommands() {
    return commands.filter((cmd) => {
      const ctx = cmd.context || ["global"];
      return ctx.includes(currentContext.type) || ctx.includes("global");
    });
  }

  // Build auto-populated args from current context params
  function getContextArgs() {
    return { ...currentContext.params };
  }

  // Resolve a Phoenix project ID to its human-readable name
  async function resolveProjectName(projectId) {
    if (projectCache[projectId]) return projectCache[projectId];
    try {
      const resp = await fetch(`${phoenixUrl}/v1/projects`);
      if (!resp.ok) return projectId;
      const { data } = await resp.json();
      for (const proj of data) {
        projectCache[proj.id] = proj.name;
      }
      return projectCache[projectId] || projectId;
    } catch {
      return projectId;
    }
  }

  // --- Init ---
  async function init() {
    // Load config and set Phoenix URL
    const config = await window.claudeShell.getConfig();
    phoenixUrl = config.phoenixUrl || "http://localhost:6006";
    frame.src = phoenixUrl;

    // Theme — sync with system (matches Phoenix LiveDashboard's prefers-color-scheme)
    const theme = await window.claudeShell.getTheme();
    document.documentElement.setAttribute("data-theme", theme);
    window.claudeShell.onThemeChanged(({ theme }) => {
      document.documentElement.setAttribute("data-theme", theme);
    });

    // Health check
    const health = await window.claudeShell.health();
    isHealthy = health.available;
    $("#health-status").classList.toggle("healthy", isHealthy);
    $("#health-status").classList.toggle("unhealthy", !isHealthy);
    $("#health-status").title = isHealthy ? "Connected" : "CLI not found";
    if (health.version) {
      $("#cli-version").textContent = health.version;
    }

    // Load commands
    commands = await window.claudeShell.listCommands();
    renderCommandPills();

    // Streaming output — structured JSON events + legacy fallback
    window.claudeShell.onOutputChunk((data) => {
      const { chunk, type, event, specialistId } = data;

      // Swarm lifecycle events
      if (type === "swarm-fetch-start") {
        return; // fetch is implicit, no UI needed
      }
      if (type === "swarm-fetch-error") {
        appendOutput(`Fetch error: ${data.error}\n`, "error");
        return;
      }
      if (type === "swarm-summary-start") {
        handleSwarmSummaryStart(data.swarmSessionId, data.specialists);
        return;
      }
      if (type === "swarm-summary-complete") {
        handleSwarmSummaryComplete(data.swarmSessionId, data.exitCode);
        return;
      }
      if (type === "swarm-start") {
        handleSwarmStart(data.specialists);
        return;
      }
      if (type === "swarm-complete") {
        handleSwarmComplete(data.results);
        return;
      }

      // Route to specialist (summary or real specialist) if in swarm mode
      if ((swarmMode || specialistId === "summary") && specialistId) {
        if (type === "json-event" && event) {
          renderSpecialistEvent(specialistId, event);
        } else if (chunk) {
          appendSpecialistOutput(specialistId, chunk);
        }
        return;
      }

      // Default single-agent path
      if (type === "json-event" && event) {
        renderStructuredEvent(event);
      } else {
        currentOutput += chunk;
        appendOutput(chunk, type || "stdout");
      }
    });

    // Auto-save notification
    window.claudeShell.onAnalysisSaved(() => {});

    // Frame navigation — context-aware panel updates
    window.claudeShell.onFrameNavigated(({ url }) => {
      updateContext(url);
    });

    // Poll iframe URL as fallback (LiveView pushState may not trigger frame events)
    setInterval(async () => {
      const url = await window.claudeShell.getFrameUrl();
      if (url) updateContext(url);
    }, 2000);

    // Wire up toolbar
    btnCancel.addEventListener("click", cancelCommand);
    btnCopy.addEventListener("click", () => {
      let text = currentOutput;
      if (specialistState.size > 0) {
        text = Array.from(specialistState.values())
          .map((s) => `## ${s.name}\n\n${s.output}`)
          .join("\n\n---\n\n");
      }
      navigator.clipboard.writeText(text);
      btnCopyText.textContent = "Copied!";
      setTimeout(() => { btnCopyText.textContent = "Copy"; }, 1500);
    });
    btnClear.addEventListener("click", clearOutput);
    collapseBtn?.addEventListener("click", toggleCollapse);

    // Settings modal
    btnSettings.innerHTML = icon("Settings", 16);
    btnSettings.addEventListener("click", openSettings);
    settingsOverlay.addEventListener("click", (e) => {
      if (e.target === settingsOverlay) closeSettings();
    });
    $("#settings-close").addEventListener("click", closeSettings);
    $("#settings-cancel").addEventListener("click", closeSettings);
    $("#settings-save").addEventListener("click", saveSettingsModal);
    $("#setting-browse").addEventListener("click", async () => {
      const result = await window.claudeShell.pickFolder();
      if (!result.canceled) $("#setting-working-dir").value = result.path;
    });

    // Model toggle buttons
    document.querySelectorAll(".settings-model-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".settings-model-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });

    // Theme toggle buttons
    document.querySelectorAll(".settings-theme-btn[data-theme-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".settings-theme-btn[data-theme-mode]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });

    // Escape to close settings
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isSettingsOpen) closeSettings();
    });

    // Scroll detection for auto-scroll indicator
    outputEl.addEventListener("scroll", () => {
      const atBottom =
        outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 40;
      userScrolled = !atBottom;
      scrollIndicator.classList.toggle("hidden", atBottom);
    });
    scrollIndicator.addEventListener("click", () => {
      outputEl.scrollTop = outputEl.scrollHeight;
      scrollIndicator.classList.add("hidden");
      userScrolled = false;
    });

    // Drag handle
    setupDragHandle(config);

    // Apply saved panel width
    if (config.panelWidth) {
      panel.style.width = config.panelWidth + "px";
    }

    // Tab buttons
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    // Replace static <i data-lucide> elements with SVGs
    lucide.createIcons();

    console.log(
      `[Claude Shell] Ready. CLI: ${isHealthy}, Commands: ${commands.length}`,
    );
  }

  // --- Context Action (lightning bolt) ---
  contextAction.addEventListener("click", () => {
    const cmdId = contextAction.dataset.commandId;
    if (cmdId && !isRunning) runCommand(cmdId);
  });

  // --- Settings Modal ---
  async function openSettings() {
    const cfg = await window.claudeShell.getConfig();
    $("#setting-phoenix-url").value = cfg.phoenixUrl || "";
    $("#setting-api-key").value = cfg.phoenixApiKey || "";
    $("#setting-working-dir").value = cfg.workingDir || "";
    $("#setting-auto-save").checked = cfg.autoSaveAnalyses !== false;

    // Model toggle
    const activeModel = cfg.defaultModel || "sonnet";
    document.querySelectorAll(".settings-model-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.model === activeModel);
    });

    // Theme toggle
    const activeMode = cfg.themeMode || "system";
    document.querySelectorAll(".settings-theme-btn[data-theme-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.themeMode === activeMode);
    });

    settingsOverlay.classList.remove("hidden");
    isSettingsOpen = true;
    setTimeout(() => $("#setting-phoenix-url").focus(), 50);
  }

  function closeSettings() {
    settingsOverlay.classList.add("hidden");
    isSettingsOpen = false;
  }

  async function saveSettingsModal() {
    const cfg = await window.claudeShell.getConfig();
    const newUrl = $("#setting-phoenix-url").value.trim();
    const activeThemeBtn = document.querySelector(".settings-theme-btn[data-theme-mode].active");
    const newApiKey = $("#setting-api-key").value.trim();
    const activeModelBtn = document.querySelector(".settings-model-btn.active");
    const newConfig = {
      ...cfg,
      phoenixUrl: newUrl || cfg.phoenixUrl,
      phoenixApiKey: newApiKey || null,
      workingDir: $("#setting-working-dir").value.trim() || null,
      autoSaveAnalyses: $("#setting-auto-save").checked,
      defaultModel: activeModelBtn ? activeModelBtn.dataset.model : "sonnet",
      themeMode: activeThemeBtn ? activeThemeBtn.dataset.themeMode : "system",
    };
    await window.claudeShell.saveConfig(newConfig);

    // Reload iframe if URL changed
    if (newUrl && newUrl !== phoenixUrl) {
      phoenixUrl = newUrl;
      frame.src = phoenixUrl;
    }

    closeSettings();
  }

  // --- Markdown Rendering ---
  const md = marked.marked || marked;
  md.setOptions({
    breaks: true,
    gfm: true,
  });

  let markdownContainer = null; // reusable container for streaming markdown
  let renderDebounceTimer = null;

  function renderMarkdown(text) {
    if (!markdownContainer) {
      markdownContainer = document.createElement("div");
      markdownContainer.className = "output-markdown";
      outputEl.appendChild(markdownContainer);
    }
    markdownContainer.innerHTML = md.parse(text);
    if (!userScrolled) {
      outputEl.scrollTop = outputEl.scrollHeight;
    }
  }

  function scheduleMarkdownRender() {
    if (renderDebounceTimer) clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(() => {
      renderMarkdown(currentOutput);
      renderDebounceTimer = null;
    }, 50);
  }

  // --- Output ---
  function appendOutput(chunk, type) {
    if (type === "stdout") {
      // Accumulate and render as markdown
      scheduleMarkdownRender();
    } else {
      // Non-stdout (stderr, meta, error) rendered as plain spans
      const span = document.createElement("span");
      span.className = `output-${type}`;
      span.textContent = chunk;
      outputEl.appendChild(span);
      if (!userScrolled) {
        outputEl.scrollTop = outputEl.scrollHeight;
      }
    }
  }

  function clearOutput() {
    outputEl.innerHTML = "";
    currentOutput = "";
    toolCallCount = 0;
    markdownContainer = null;
    if (renderDebounceTimer) clearTimeout(renderDebounceTimer);
    renderDebounceTimer = null;
    userScrolled = false;
    scrollIndicator.classList.add("hidden");
    renderedBlockCounts.clear();
    // Clear swarm state
    for (const state of specialistState.values()) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
    }
    specialistState.clear();
    swarmMode = false;
    currentSwarmSessionId = null;
    availableSpecialists = [];
    swarmTabBar = null;
    swarmTabPanels = null;
    activeSwarmTabId = null;
    showEmptyState();
  }

  function setStatus(type, message) {
    toolbarStatus.className = `toolbar-status ${type}`;
    toolbarStatus.textContent = message;
  }

  // --- Run Command ---
  async function runCommand(commandId, explicitArgs = {}) {
    if (isSettingsOpen) closeSettings();

    // Merge context-extracted args with any explicit args
    const args = { ...getContextArgs(), ...explicitArgs };

    currentOutput = "";
    toolCallCount = 0;
    outputEl.innerHTML = "";
    markdownContainer = null;
    renderedBlockCounts.clear();
    hideEmptyState();
    progressBar.classList.remove("hidden");
    setStatus("running", `Running: ${commandId}...`);
    btnCancel.classList.remove("hidden");
    isRunning = true;

    try {
      const result = await window.claudeShell.runCommand(commandId, args, {
        ...currentContext.params,
        phoenixPath: currentContext.path || null,
      });
      if (result.success) {
        setStatus("success", `Done (exit ${result.exitCode})`);
      } else {
        setStatus("error", `Failed: ${result.error}`);
      }
    } catch (err) {
      setStatus("error", `Error: ${err.message}`);
    } finally {
      btnCancel.classList.add("hidden");
      progressBar.classList.add("hidden");
      isRunning = false;
    }
  }

  async function cancelCommand() {
    const result = await window.claudeShell.cancel();
    if (result.cancelled) {
      setStatus("error", "Cancelled");
      btnCancel.classList.add("hidden");
      isRunning = false;
    }
  }

  // --- History ---
  async function loadHistoryItem(id) {
    const analysis = await window.claudeShell.loadAnalysis(id);
    if (!analysis) return;

    outputEl.innerHTML = "";
    toolCallCount = 0;
    markdownContainer = null;
    renderedBlockCounts.clear();
    for (const state of specialistState.values()) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
    }
    specialistState.clear();
    swarmMode = false;
    hideEmptyState();
    currentOutput = analysis.output;

    // Detect swarm output by section headers and restore as tabs
    const swarmSections = parseSwarmOutput(currentOutput);
    if (swarmSections.length > 1) {
      const tabContainer = document.createElement("div");
      tabContainer.className = "swarm-tabs";

      swarmTabBar = document.createElement("div");
      swarmTabBar.className = "swarm-tab-bar";
      tabContainer.appendChild(swarmTabBar);

      swarmTabPanels = document.createElement("div");
      swarmTabPanels.className = "swarm-tab-panels";
      tabContainer.appendChild(swarmTabPanels);

      swarmTabBar.addEventListener("click", (e) => {
        const btn = e.target.closest(".swarm-tab");
        if (!btn) return;
        switchSwarmTab(btn.dataset.tabId);
      });

      swarmSections.forEach((sec, i) => {
        const tabId = `history-${i}`;
        const tabBtn = document.createElement("button");
        tabBtn.className = `swarm-tab${i === 0 ? " active" : ""}`;
        tabBtn.dataset.tabId = tabId;
        tabBtn.innerHTML = `
          <span class="specialist-icon">${icon("Zap", 14)}</span>
          <span class="specialist-name">${escapeHtml(sec.name)}</span>
          <span class="specialist-status done">Done</span>
        `;
        swarmTabBar.appendChild(tabBtn);

        const panel = document.createElement("div");
        panel.className = `swarm-tab-panel${i === 0 ? " active" : ""}`;
        panel.dataset.tabId = tabId;
        const mdEl = document.createElement("div");
        mdEl.className = "output-markdown";
        mdEl.innerHTML = md.parse(sec.content);
        panel.appendChild(mdEl);
        swarmTabPanels.appendChild(panel);
      });

      activeSwarmTabId = "history-0";
      outputEl.appendChild(tabContainer);
    } else {
      renderMarkdown(currentOutput);
    }

    const badge = analysis.exitCode === 0 ? "Done" : "Failed";
    setStatus(
      analysis.exitCode === 0 ? "success" : "error",
      `${badge} — ${analysis.commandId}`,
    );

    // Navigate Phoenix iframe to the context this analysis was run against
    if (analysis.context && analysis.context.phoenixPath) {
      const target = new URL(analysis.context.phoenixPath, phoenixUrl).href;
      if (frame.src !== target) {
        frame.src = target;
      }
    }
  }

  function relativeTime(ts) {
    if (!ts) return "";
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // Parse swarm combined output (## Name sections separated by ---)
  function parseRecommendedSpecialists(output) {
    const match = output.match(/<recommended_specialists>\s*([\s\S]*?)\s*<\/recommended_specialists>/);
    if (!match) return null;
    return match[1].trim().split(/\s+/).filter(Boolean);
  }

  function parseSwarmOutput(text) {
    const sections = [];
    const parts = text.split(/\n---\n/);
    for (const part of parts) {
      const match = part.match(/^##\s+(.+)\n\n([\s\S]*)$/);
      if (match) {
        sections.push({ name: match[1].trim(), content: match[2].trim() });
      }
    }
    return sections;
  }

  // --- Tabs ---
  function switchTab(tabName) {
    activeTab = tabName;
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });
    document.querySelectorAll(".tab-content").forEach((el) => {
      el.classList.toggle("hidden", el.id !== `tab-${tabName}`);
    });
    if (tabName === "history") refreshFullHistory();
  }

  async function refreshFullHistory() {
    const analyses = await window.claudeShell.listAnalyses({ limit: 100 });
    if (analyses.length === 0) {
      fullHistoryList.innerHTML =
        `<div class="history-empty">
          <span class="history-empty-icon">${icon('clock', 20)}</span>
          <span>No analyses yet</span>
        </div>`;
      return;
    }

    fullHistoryList.innerHTML = analyses
      .map((a) => {
        const badgeIcon =
          a.exitCode === 0 ? icon("CheckCircle", 14) : icon("XCircle", 14);
        const badgeClass = a.exitCode === 0 ? "badge-success" : "badge-error";
        const time = relativeTime(a.completedAt);
        return `
        <div class="history-item" data-id="${a.id}" data-command="${a.commandId}">
          <div class="history-item-header">
            <span class="history-badge ${badgeClass}">${badgeIcon}</span>
            <span class="history-name">${a.commandId}</span>
            <span class="history-time">${time}</span>
            <button class="history-delete" data-id="${a.id}" title="Delete">${icon('Trash2', 14)}</button>
          </div>
          <div class="history-preview">${escapeHtml(a.preview || "")}</div>
        </div>`;
      })
      .join("");

    fullHistoryList.querySelectorAll(".history-item").forEach((el) => {
      el.addEventListener("click", () => {
        loadHistoryItem(el.dataset.id);
        switchTab("observe");
      });
    });
    fullHistoryList.querySelectorAll(".history-delete").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await window.claudeShell.deleteAnalysis(btn.dataset.id);
        refreshFullHistory();
      });
    });
  }

  // --- Panel Collapse ---
  function toggleCollapse() {
    const collapsed = panel.classList.toggle("collapsed");
    collapseBtn.innerHTML = collapsed
      ? icon("ChevronRight", 14)
      : icon("ChevronLeft", 14);
    dragHandle.style.display = collapsed ? "none" : "";
  }

  // --- Drag Handle ---
  function setupDragHandle(config) {
    let startX, startWidth;

    dragHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = panel.offsetWidth;
      dragHandle.classList.add("active");
      dragOverlay.classList.remove("hidden");

      function onMove(e) {
        const delta = startX - e.clientX;
        const newWidth = Math.min(600, Math.max(280, startWidth + delta));
        panel.style.width = newWidth + "px";
      }

      function onUp() {
        dragHandle.classList.remove("active");
        dragOverlay.classList.add("hidden");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);

        // Persist width
        window.claudeShell.saveConfig({
          ...config,
          panelWidth: panel.offsetWidth,
        });
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // --- Structured Event Rendering ---
  // Track rendered block counts per message ID for incremental dedup
  const renderedBlockCounts = new Map();

  function renderStructuredEvent(event) {
    if (event.type === "assistant" && event.message?.content) {
      renderAssistantMessage(event.message);
    } else if (event.type === "result") {
      // Result can be a string (final text response) or object with content blocks
      if (typeof event.result === "string") {
        currentOutput += event.result;
        scheduleMarkdownRender();
      } else if (event.result?.content) {
        renderContentBlocks(event.result.content, "result");
      }
      // Usage may be at top level or nested under result
      const usage = event.usage || event.result?.usage;
      if (usage) {
        const u = usage;
        const stats = `[${u.input_tokens || 0} in / ${u.output_tokens || 0} out tokens]`;
        appendOutput(`\n${stats}\n`, "meta");
      }
    }
  }

  function renderAssistantMessage(message) {
    const msgId = message.id || "unknown";
    const blocks = message.content || [];
    const alreadyRendered = renderedBlockCounts.get(msgId) || 0;

    // Only render new blocks (assistant events re-emit full message each update)
    const newBlocks = blocks.slice(alreadyRendered);
    if (newBlocks.length === 0) return;

    for (const block of newBlocks) {
      renderContentBlock(block);
    }
    renderedBlockCounts.set(msgId, blocks.length);
  }

  function renderContentBlocks(blocks) {
    for (const block of blocks) {
      renderContentBlock(block);
    }
  }

  function renderContentBlock(block) {
    switch (block.type) {
      case "text":
        if (block.text) {
          currentOutput += block.text;
          scheduleMarkdownRender();
        }
        break;
      case "thinking":
        if (block.thinking) {
          renderThinking(block.thinking);
        }
        break;
      case "tool_use":
        renderToolCall(block);
        break;
      case "tool_result":
        renderToolResult(block);
        break;
    }
  }

  function renderToolCall(block) {
    toolCallCount++;
    let counter = outputEl.querySelector(".tool-call-counter");
    if (!counter) {
      counter = document.createElement("div");
      counter.className = "tool-call-counter";
      outputEl.appendChild(counter);
    }
    counter.textContent = `\u{1F527} ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}`;
    if (!userScrolled) outputEl.scrollTop = outputEl.scrollHeight;
  }

  function renderThinking(text) {
    const details = document.createElement("details");
    details.className = "output-thinking";

    const summary = document.createElement("summary");
    summary.textContent = "Thinking...";
    details.appendChild(summary);

    const content = document.createElement("div");
    content.className = "output-thinking-content";
    content.textContent = text;
    details.appendChild(content);

    outputEl.appendChild(details);
    if (!userScrolled) outputEl.scrollTop = outputEl.scrollHeight;
  }

  function renderToolResult(block) {
    // Suppressed — tool results are noise without visible tool call blocks
    return;
  }

  // --- Swarm Rendering ---

  function switchSwarmTab(tabId) {
    if (!swarmTabBar || !swarmTabPanels) return;
    activeSwarmTabId = tabId;
    swarmTabBar.querySelectorAll(".swarm-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tabId === tabId);
    });
    swarmTabPanels.querySelectorAll(".swarm-tab-panel").forEach((p) => {
      p.classList.toggle("active", p.dataset.tabId === tabId);
    });
  }

  function handleSwarmSummaryStart(swarmSessionId, specialists) {
    currentSwarmSessionId = swarmSessionId;
    availableSpecialists = specialists;

    // Create tab container (persists across summary + specialists)
    const tabContainer = document.createElement("div");
    tabContainer.className = "swarm-tabs";

    swarmTabBar = document.createElement("div");
    swarmTabBar.className = "swarm-tab-bar";
    tabContainer.appendChild(swarmTabBar);

    swarmTabPanels = document.createElement("div");
    swarmTabPanels.className = "swarm-tab-panels";
    tabContainer.appendChild(swarmTabPanels);

    outputEl.appendChild(tabContainer);

    // Tab click handler (event delegation)
    swarmTabBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".swarm-tab");
      if (!btn) return;
      switchSwarmTab(btn.dataset.tabId);
    });

    // Create summary tab
    const tabBtn = document.createElement("button");
    tabBtn.className = "swarm-tab active";
    tabBtn.dataset.tabId = "summary";
    tabBtn.innerHTML = `
      <span class="specialist-icon">${icon("FileSearch", 14)}</span>
      <span class="specialist-name">Summary</span>
      <span class="specialist-status running">Running...</span>
    `;
    swarmTabBar.appendChild(tabBtn);

    const panel = document.createElement("div");
    panel.className = "swarm-tab-panel active";
    panel.dataset.tabId = "summary";
    const mdEl = document.createElement("div");
    mdEl.className = "output-markdown";
    panel.appendChild(mdEl);
    swarmTabPanels.appendChild(panel);

    activeSwarmTabId = "summary";

    specialistState.set("summary", {
      name: "Summary",
      icon: "FileSearch",
      output: "",
      tabBtn: tabBtn,
      panel: panel,
      markdownEl: mdEl,
      statusEl: tabBtn.querySelector(".specialist-status"),
      status: "running",
      debounceTimer: null,
      renderedBlockCounts: new Map(),
    });

    if (!userScrolled) outputEl.scrollTop = outputEl.scrollHeight;
  }

  function handleSwarmSummaryComplete(swarmSessionId, exitCode) {
    const state = specialistState.get("summary");
    if (state) {
      const success = exitCode === 0;
      state.statusEl.textContent = success ? "Done" : "Failed";
      state.statusEl.className = `specialist-status ${success ? "done" : "failed"}`;
      state.status = success ? "done" : "failed";
    }

    // Parse specialist recommendations from summary output
    const recommendedIds = state ? parseRecommendedSpecialists(state.output) : null;

    // Render specialist picker with recommendations
    renderSpecialistPicker(recommendedIds);
  }

  function renderSpecialistPicker(recommendedIds) {
    const picker = document.createElement("div");
    picker.className = "specialist-picker";

    const header = document.createElement("div");
    header.className = "specialist-picker-header";
    header.textContent = "Select analyses to run:";
    picker.appendChild(header);

    const options = document.createElement("div");
    options.className = "specialist-picker-options";

    for (const spec of availableSpecialists) {
      const label = document.createElement("label");
      label.className = "specialist-option";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = spec.id;
      checkbox.checked = recommendedIds ? recommendedIds.includes(spec.id) : true;

      const iconSpan = document.createElement("span");
      iconSpan.className = "specialist-option-icon";
      iconSpan.innerHTML = icon(spec.icon || "Zap", 14);

      const nameSpan = document.createElement("span");
      nameSpan.className = "specialist-option-name";
      nameSpan.textContent = spec.name;

      label.appendChild(checkbox);
      label.appendChild(iconSpan);
      label.appendChild(nameSpan);
      options.appendChild(label);
    }

    picker.appendChild(options);

    const runBtn = document.createElement("button");
    runBtn.className = "specialist-run-btn";
    const initialCount = recommendedIds
      ? availableSpecialists.filter(s => recommendedIds.includes(s.id)).length
      : availableSpecialists.length;
    runBtn.textContent = `Run Selected (${initialCount})`;
    picker.appendChild(runBtn);

    // Update button count on checkbox change
    options.addEventListener("change", () => {
      const count = options.querySelectorAll("input:checked").length;
      runBtn.textContent = `Run Selected (${count})`;
    });

    // Run button click
    runBtn.addEventListener("click", async () => {
      const checked = Array.from(options.querySelectorAll("input:checked"))
        .map((cb) => cb.value);
      if (checked.length === 0) return;

      // Remove picker, set running state
      picker.remove();
      isRunning = true;
      btnCancel.classList.remove("hidden");
      progressBar.classList.remove("hidden");
      setStatus("running", "Running specialists...");

      try {
        const result = await window.claudeShell.runSpecialists(currentSwarmSessionId, checked);
        if (result.success) {
          setStatus("success", `Done (exit ${result.exitCode})`);
        } else {
          setStatus("error", `Failed: ${result.error}`);
        }
      } catch (err) {
        setStatus("error", `Error: ${err.message}`);
      } finally {
        btnCancel.classList.add("hidden");
        progressBar.classList.add("hidden");
        isRunning = false;
      }
    });

    outputEl.appendChild(picker);
    if (!userScrolled) outputEl.scrollTop = outputEl.scrollHeight;
  }

  function handleSwarmStart(specialists) {
    swarmMode = true;
    // Keep summary state, clear specialist entries only
    const summaryState = specialistState.get("summary");
    specialistState.clear();
    if (summaryState) specialistState.set("summary", summaryState);

    let firstId = null;
    for (const spec of specialists) {
      if (!firstId) firstId = spec.id;

      const tabBtn = document.createElement("button");
      tabBtn.className = "swarm-tab";
      tabBtn.dataset.tabId = spec.id;
      tabBtn.innerHTML = `
        <span class="specialist-icon">${icon(spec.icon || "Zap", 14)}</span>
        <span class="specialist-name">${escapeHtml(spec.name)}</span>
        <span class="specialist-status running">Running...</span>
      `;
      swarmTabBar.appendChild(tabBtn);

      const panel = document.createElement("div");
      panel.className = "swarm-tab-panel";
      panel.dataset.tabId = spec.id;
      const mdEl = document.createElement("div");
      mdEl.className = "output-markdown";
      panel.appendChild(mdEl);
      swarmTabPanels.appendChild(panel);

      specialistState.set(spec.id, {
        name: spec.name,
        icon: spec.icon,
        output: "",
        tabBtn: tabBtn,
        panel: panel,
        markdownEl: mdEl,
        statusEl: tabBtn.querySelector(".specialist-status"),
        status: "running",
        debounceTimer: null,
        renderedBlockCounts: new Map(),
      });
    }

    // Auto-switch to first specialist tab
    if (firstId) switchSwarmTab(firstId);

    if (!userScrolled) outputEl.scrollTop = outputEl.scrollHeight;
  }

  function renderSpecialistEvent(specialistId, event) {
    const state = specialistState.get(specialistId);
    if (!state) return;

    if (event.type === "assistant" && event.message?.content) {
      const msgId = event.message.id || "unknown";
      const blocks = event.message.content || [];
      const alreadyRendered = state.renderedBlockCounts.get(msgId) || 0;
      const newBlocks = blocks.slice(alreadyRendered);
      if (newBlocks.length === 0) return;

      for (const block of newBlocks) {
        if (block.type === "text" && block.text) {
          state.output += block.text;
          scheduleSpecialistRender(specialistId);
        } else if (block.type === "tool_use") {
          renderSpecialistToolCall(state, block);
        } else if (block.type === "thinking" && block.thinking) {
          renderSpecialistThinking(state, block.thinking);
        }
      }
      state.renderedBlockCounts.set(msgId, blocks.length);
    } else if (event.type === "result") {
      if (typeof event.result === "string") {
        state.output += event.result;
        scheduleSpecialistRender(specialistId);
      }
      const usage = event.usage || event.result?.usage;
      if (usage) {
        const stats = `\n\n*[${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out tokens]*\n`;
        state.output += stats;
        scheduleSpecialistRender(specialistId);
      }
    }
  }

  function appendSpecialistOutput(specialistId, chunk) {
    const state = specialistState.get(specialistId);
    if (!state) return;
    state.output += chunk;
    scheduleSpecialistRender(specialistId);
  }

  function scheduleSpecialistRender(specialistId) {
    const state = specialistState.get(specialistId);
    if (!state) return;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.markdownEl.innerHTML = md.parse(state.output);
      state.debounceTimer = null;
      if (!userScrolled) outputEl.scrollTop = outputEl.scrollHeight;
    }, 50);
  }

  function renderSpecialistToolCall(state, block) {
    if (!state.toolCallCount) state.toolCallCount = 0;
    state.toolCallCount++;
    let counter = state.panel.querySelector(".tool-call-counter");
    if (!counter) {
      counter = document.createElement("div");
      counter.className = "tool-call-counter";
      state.panel.appendChild(counter);
    }
    counter.textContent = `\u{1F527} ${state.toolCallCount} tool call${state.toolCallCount === 1 ? "" : "s"}`;
    if (!userScrolled) outputEl.scrollTop = outputEl.scrollHeight;
  }

  function renderSpecialistThinking(state, text) {
    const details = document.createElement("details");
    details.className = "output-thinking";
    const summary = document.createElement("summary");
    summary.textContent = "Thinking...";
    details.appendChild(summary);
    const content = document.createElement("div");
    content.className = "output-thinking-content";
    content.textContent = text;
    details.appendChild(content);
    state.panel.appendChild(details);
    if (!userScrolled) outputEl.scrollTop = outputEl.scrollHeight;
  }

  function handleSwarmComplete(results) {
    for (const r of results) {
      const state = specialistState.get(r.specialistId);
      if (!state) continue;
      const success = r.exitCode === 0;
      state.statusEl.textContent = success ? "Done" : "Failed";
      state.statusEl.className = `specialist-status ${success ? "done" : "failed"}`;
      state.status = success ? "done" : "failed";
    }
    swarmMode = false;
  }

  // --- Boot ---
  init();
})();
