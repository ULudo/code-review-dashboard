const state = {
  repo: null,
  files: [],
  tree: null,
  selectedPath: null,
  selectedFile: null,
  mode: "full",
  collapsed: new Set(),
};

const els = {
  repoPath: document.querySelector("#repoPath"),
  branchName: document.querySelector("#branchName"),
  summaryText: document.querySelector("#summaryText"),
  changedCount: document.querySelector("#changedCount"),
  newCount: document.querySelector("#newCount"),
  deletedCount: document.querySelector("#deletedCount"),
  fileList: document.querySelector("#fileList"),
  refreshButton: document.querySelector("#refreshButton"),
  emptyState: document.querySelector("#emptyState"),
  fileViewer: document.querySelector("#fileViewer"),
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
  state.files = payload.files || [];
  state.tree = payload.tree;
  renderState(payload);

  const visibleSelected = state.selectedPath && state.files.some((file) => file.path === state.selectedPath);
  if (visibleSelected) {
    await openFile(state.selectedPath, false);
  } else if (state.files.length) {
    await openFile(state.files[0].path, false);
  } else {
    state.selectedPath = null;
    state.selectedFile = null;
    showEmpty("No files found in this repository.");
  }
}

function renderState(payload) {
  els.repoPath.textContent = payload.repo;
  els.branchName.textContent = payload.branch ? `Branch ${payload.branch}` : "";
  const allCount = payload.counts.all ?? payload.files.length;
  els.summaryText.textContent = `${allCount} file${allCount === 1 ? "" : "s"} - ${payload.counts.total} changed`;
  els.changedCount.textContent = payload.counts.changed;
  els.newCount.textContent = payload.counts.new;
  els.deletedCount.textContent = payload.counts.deleted;

  if (!payload.tree || !payload.tree.children.length) {
    els.fileList.innerHTML = '<div class="empty-state">No files found.</div>';
    return;
  }

  els.fileList.innerHTML = renderTree(payload.tree.children, 0);
  renderFileListSelection();
}

function renderTree(nodes, depth) {
  return nodes
    .map((node) => {
      if (node.type === "directory") {
        return renderDirectory(node, depth);
      }
      return renderFileNode(node, depth);
    })
    .join("");
}

function renderDirectory(node, depth) {
  const collapsed = state.collapsed.has(node.path);
  const children = collapsed ? "" : renderTree(node.children || [], depth + 1);
  const badge = node.category === "clean" ? "" : `<span class="tree-badge ${escapeHtml(node.category)}">${escapeHtml(node.label)}</span>`;
  return `
    <div class="tree-node">
      <button class="tree-row directory-row ${escapeHtml(node.category)}" type="button" data-folder="${escapeHtml(node.path)}" style="--depth: ${depth}">
        <span class="twisty">${collapsed ? ">" : "v"}</span>
        <span class="tree-icon">[]</span>
        <span class="tree-name">${escapeHtml(node.name)}</span>
        ${badge}
      </button>
      <div class="tree-children${collapsed ? " hidden" : ""}">
        ${children}
      </div>
    </div>
  `;
}

function renderFileNode(node, depth) {
  const active = node.path === state.selectedPath ? " active" : "";
  const badge = node.category === "clean" ? "" : `<span class="tree-badge ${escapeHtml(node.category)}">${escapeHtml(node.label)}</span>`;
  const oldPath = node.old_path ? `<span class="old-path">from ${escapeHtml(node.old_path)}</span>` : "";
  return `
    <button class="tree-row file-row ${escapeHtml(node.category)}${active}" type="button" data-path="${escapeHtml(node.path)}" style="--depth: ${depth}">
      <span class="twisty"></span>
      <span class="tree-icon">-</span>
      <span class="tree-name">${escapeHtml(node.name)}</span>
      ${badge}
      ${oldPath}
    </button>
  `;
}

async function openFile(path, updateHash = true) {
  state.selectedPath = path;
  state.mode = state.mode || "full";
  renderFileListSelection();

  const payload = await fetchJson(`/api/file?path=${encodeURIComponent(path)}`);
  state.selectedFile = payload;
  els.emptyState.classList.add("hidden");
  els.fileViewer.classList.remove("hidden");
  els.filePath.textContent = payload.path;
  els.statusLabel.textContent = `${payload.status.label || "File"} ${payload.status.xy || ""}`;
  renderModeButtons();
  renderCode();

  if (updateHash) {
    history.replaceState(null, "", `#${encodeURIComponent(path)}`);
  }
}

function renderFileListSelection() {
  document.querySelectorAll(".file-row").forEach((row) => {
    row.classList.toggle("active", row.dataset.path === state.selectedPath);
  });
}

function showEmpty(text) {
  els.emptyState.textContent = text;
  els.emptyState.classList.remove("hidden");
  els.fileViewer.classList.add("hidden");
}

function renderModeButtons() {
  els.fullModeButton.classList.toggle("active", state.mode === "full");
  els.diffModeButton.classList.toggle("active", state.mode === "diff");
}

function renderCode() {
  const file = state.selectedFile;
  if (!file) {
    return;
  }

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
          <span class="line-number">${escapeHtml(String(number))}</span>
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
    renderState({ repo: state.repo, files: state.files, tree: state.tree, counts: currentCounts(), branch: els.branchName.textContent.replace(/^Branch /, "") });
    return;
  }

  const row = event.target.closest(".file-row");
  if (!row) return;
  openFile(row.dataset.path).catch(showError);
});

els.refreshButton.addEventListener("click", () => {
  loadState().catch(showError);
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

function currentCounts() {
  return {
    changed: Number(els.changedCount.textContent) || 0,
    new: Number(els.newCount.textContent) || 0,
    deleted: Number(els.deletedCount.textContent) || 0,
    total: state.files.filter((file) => file.category !== "clean").length,
    all: state.files.length,
  };
}

function showError(error) {
  showEmpty(error.message || String(error));
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
