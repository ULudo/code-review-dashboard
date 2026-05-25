const state = {
  repo: null,
  files: [],
  selectedPath: null,
  selectedFile: null,
  mode: "full",
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
  return value
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
  state.files = payload.files;
  renderState(payload);

  if (state.selectedPath && state.files.some((file) => file.path === state.selectedPath)) {
    await openFile(state.selectedPath, false);
  } else if (state.files.length) {
    await openFile(state.files[0].path, false);
  } else {
    state.selectedPath = null;
    state.selectedFile = null;
    showEmpty("No uncommitted changes found.");
  }
}

function renderState(payload) {
  els.repoPath.textContent = payload.repo;
  els.branchName.textContent = payload.branch ? `Branch ${payload.branch}` : "";
  els.summaryText.textContent = `${payload.counts.total} file${payload.counts.total === 1 ? "" : "s"}`;
  els.changedCount.textContent = payload.counts.changed;
  els.newCount.textContent = payload.counts.new;
  els.deletedCount.textContent = payload.counts.deleted;

  if (!payload.files.length) {
    els.fileList.innerHTML = '<div class="empty-state">Working tree is clean.</div>';
    return;
  }

  els.fileList.innerHTML = payload.files
    .map((file) => {
      const active = file.path === state.selectedPath ? " active" : "";
      const oldPath = file.old_path ? `<div class="file-name">from ${escapeHtml(file.old_path)}</div>` : "";
      return `
        <button class="file-row${active}" type="button" data-path="${escapeHtml(file.path)}">
          <span class="badge ${escapeHtml(file.category)}">${escapeHtml(file.label)}</span>
          <span>
            <span class="file-name">${escapeHtml(file.path)}</span>
            ${oldPath}
          </span>
        </button>
      `;
    })
    .join("");
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
      const number = line.number === null || line.number === undefined ? "−" : line.number;
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
