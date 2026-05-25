const state = {
  branch: "",
  counts: { changed: 0, new: 0, deleted: 0, total: 0, all: 0 },
  files: [],
  repo: "",
  tree: null,
  selectedPath: null,
  selectedFile: null,
  mode: "full",
  collapsed: new Set(),
};

const els = {
  explorerScreen: document.querySelector("#explorerScreen"),
  fileScreen: document.querySelector("#fileScreen"),
  repoPath: document.querySelector("#repoPath"),
  branchName: document.querySelector("#branchName"),
  summaryText: document.querySelector("#summaryText"),
  changedCount: document.querySelector("#changedCount"),
  newCount: document.querySelector("#newCount"),
  deletedCount: document.querySelector("#deletedCount"),
  fileList: document.querySelector("#fileList"),
  refreshButton: document.querySelector("#refreshButton"),
  backButton: document.querySelector("#backButton"),
  filePath: document.querySelector("#filePath"),
  statusLabel: document.querySelector("#statusLabel"),
  fullModeButton: document.querySelector("#fullModeButton"),
  diffModeButton: document.querySelector("#diffModeButton"),
  message: document.querySelector("#message"),
  codeView: document.querySelector("#codeView"),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload;
}

async function loadState() {
  const payload = await fetchJson("/api/state");
  state.repo = payload.repo;
  state.branch = payload.branch || "";
  state.counts = payload.counts || state.counts;
  state.files = payload.files || [];
  state.tree = payload.tree;
  renderExplorer();

  if (state.selectedPath && state.files.some((file) => file.path === state.selectedPath)) {
    await openFile(state.selectedPath, false);
  } else {
    showExplorer();
  }
}

function renderExplorer() {
  els.repoPath.textContent = basename(state.repo) || state.repo;
  els.branchName.textContent = state.branch ? state.branch : "";
  els.summaryText.textContent = `${state.counts.all || 0} files, ${state.counts.total || 0} changed`;
  els.changedCount.textContent = state.counts.changed || 0;
  els.newCount.textContent = state.counts.new || 0;
  els.deletedCount.textContent = state.counts.deleted || 0;

  if (!state.tree || !state.tree.children.length) {
    els.fileList.innerHTML = '<div class="empty-state">No files found.</div>';
    return;
  }

  els.fileList.innerHTML = renderTree(state.tree.children, 0);
  renderSelection();
}

function basename(path) {
  return String(path).split("/").filter(Boolean).pop() || "";
}

function renderTree(nodes, depth) {
  return nodes.map((node) => (node.type === "directory" ? renderDirectory(node, depth) : renderFile(node, depth))).join("");
}

function renderDirectory(node, depth) {
  const collapsed = state.collapsed.has(node.path);
  const status = statusLetter(node);
  return `
    <div class="tree-node">
      <button class="tree-row directory-row ${escapeHtml(node.category)}" type="button" data-folder="${escapeHtml(node.path)}" style="--depth: ${depth}">
        <span class="tree-chevron">${collapsed ? ">" : "v"}</span>
        <span class="tree-name">${escapeHtml(node.name)}</span>
        <span class="tree-status">${status}</span>
      </button>
      <div class="tree-children${collapsed ? " hidden" : ""}">
        ${collapsed ? "" : renderTree(node.children || [], depth + 1)}
      </div>
    </div>
  `;
}

function renderFile(node, depth) {
  const active = node.path === state.selectedPath ? " active" : "";
  const status = statusLetter(node);
  const oldPath = node.old_path ? `<span class="old-path">from ${escapeHtml(node.old_path)}</span>` : "";
  return `
    <button class="tree-row file-row ${escapeHtml(node.category)}${active}" type="button" data-path="${escapeHtml(node.path)}" style="--depth: ${depth}">
      <span class="tree-chevron"></span>
      <span class="tree-name">${escapeHtml(node.name)}</span>
      <span class="tree-status">${status}</span>
      ${oldPath}
    </button>
  `;
}

function statusLetter(node) {
  if (node.category === "modified") return "M";
  if (node.category === "new") return "A";
  if (node.category === "deleted") return "D";
  return "";
}

async function openFile(path, updateHash = true) {
  state.selectedPath = path;
  renderSelection();

  const payload = await fetchJson(`/api/file?path=${encodeURIComponent(path)}`);
  state.selectedFile = payload;
  els.filePath.textContent = payload.path;
  els.statusLabel.textContent = `${payload.status.label || "Clean"} ${payload.status.xy || ""}`.trim();
  renderModeButtons();
  renderCode();
  showFile();

  if (updateHash) {
    history.replaceState(null, "", `#${encodeURIComponent(path)}`);
  }
}

function showExplorer() {
  els.explorerScreen.classList.remove("hidden");
  els.fileScreen.classList.add("hidden");
}

function showFile() {
  els.explorerScreen.classList.add("hidden");
  els.fileScreen.classList.remove("hidden");
  requestAnimationFrame(() => {
    els.codeView.scrollTop = 0;
    els.codeView.scrollLeft = 0;
  });
}

function renderSelection() {
  document.querySelectorAll(".file-row").forEach((row) => {
    row.classList.toggle("active", row.dataset.path === state.selectedPath);
  });
}

function renderModeButtons() {
  els.fullModeButton.classList.toggle("active", state.mode === "full");
  els.diffModeButton.classList.toggle("active", state.mode === "diff");
}

function renderCode() {
  const file = state.selectedFile;
  if (!file) return;

  if (file.binary) {
    els.message.textContent = "Binary file; text preview is not available.";
    els.message.classList.remove("hidden");
  } else {
    els.message.classList.add("hidden");
  }

  if (state.mode === "diff") {
    renderDiff(file.diff || "");
  } else {
    renderFull(file.fullLines || []);
  }
}

function renderFull(lines) {
  if (!lines.length) {
    els.codeView.innerHTML = '<span class="code-line meta"><span class="line-number"></span><span class="line-text">No text content to display.</span></span>';
    return;
  }

  els.codeView.innerHTML = lines
    .map((line) => {
      const number = line.number === null || line.number === undefined ? "-" : line.number;
      const classes = ["code-line", line.kind || "context"];
      if (line.virtual) classes.push("virtual");
      return `
        <span class="${classes.join(" ")}">
          <span class="line-number">${escapeHtml(number)}</span>
          <span class="line-text">${escapeHtml(line.text)}</span>
        </span>
      `;
    })
    .join("");
}

function renderDiff(diff) {
  const lines = diff ? diff.split("\n") : ["No diff for this file."];
  els.codeView.innerHTML = lines
    .map((line, index) => {
      let cls = "code-line";
      if (line.startsWith("+") && !line.startsWith("+++")) cls += " diff-added";
      else if (line.startsWith("-") && !line.startsWith("---")) cls += " diff-deleted";
      else if (line.startsWith("@@")) cls += " diff-hunk";
      else if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) cls += " diff-meta";
      return `
        <span class="${cls}">
          <span class="line-number">${index + 1}</span>
          <span class="line-text">${escapeHtml(line)}</span>
        </span>
      `;
    })
    .join("");
}

els.fileList.addEventListener("click", (event) => {
  const folder = event.target.closest("[data-folder]");
  if (folder) {
    const path = folder.dataset.folder;
    if (state.collapsed.has(path)) {
      state.collapsed.delete(path);
    } else {
      state.collapsed.add(path);
    }
    renderExplorer();
    return;
  }

  const row = event.target.closest(".file-row");
  if (!row) return;
  openFile(row.dataset.path).catch(showError);
});

els.refreshButton.addEventListener("click", () => {
  loadState().catch(showError);
});

els.backButton.addEventListener("click", () => {
  history.replaceState(null, "", location.pathname);
  showExplorer();
});

els.fullModeButton.addEventListener("click", () => {
  state.mode = "full";
  renderModeButtons();
  renderCode();
});

els.diffModeButton.addEventListener("click", () => {
  state.mode = "diff";
  renderModeButtons();
  renderCode();
});

function showError(error) {
  els.fileList.innerHTML = `<div class="empty-state">${escapeHtml(error.message || String(error))}</div>`;
  showExplorer();
}

function initialPathFromHash() {
  if (!location.hash) return null;
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return null;
  }
}

state.selectedPath = initialPathFromHash();
loadState().catch(showError);
