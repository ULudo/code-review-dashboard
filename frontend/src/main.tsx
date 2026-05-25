import "@vscode/codicons/dist/codicon.css";
import "./styles.css";

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import ini from "highlight.js/lib/languages/ini";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

type Category = "clean" | "modified" | "new" | "deleted";
type ViewMode = "full" | "changes";

type TreeNode = {
  name: string;
  path: string;
  type: "directory" | "file";
  category: Category;
  label: string;
  xy?: string;
  old_path?: string | null;
  children?: TreeNode[];
};

type FileStatus = {
  path?: string;
  xy: string;
  category: Category;
  label: string;
  old_path?: string | null;
};

type RepoState = {
  repo: string;
  branch: string;
  counts: {
    changed: number;
    new: number;
    deleted: number;
    total: number;
    all: number;
  };
  tree: TreeNode;
  files: FileStatus[];
};

type FullLine = {
  number: number | null;
  text: string;
  kind: "context" | "added" | "deleted" | "modified";
  virtual: boolean;
};

type FilePayload = {
  path: string;
  status: FileStatus;
  binary: boolean;
  language: string;
  fullLines: FullLine[];
  reviewContent: string;
  currentContent: string;
  originalContent: string;
  diff: string;
};

type DiffLine = {
  number: number;
  text: string;
  kind: "meta" | "hunk" | "added" | "deleted" | "context";
};

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("go", go);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload as T;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function statusLetter(category: Category): string {
  if (category === "modified") return "M";
  if (category === "new") return "A";
  if (category === "deleted") return "D";
  return "";
}

function iconForFile(path: string): string {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".py")) return "codicon-file-code";
  if (name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".js") || name.endsWith(".jsx")) return "codicon-file-code";
  if (name.endsWith(".css")) return "codicon-symbol-color";
  if (name.endsWith(".md")) return "codicon-markdown";
  if (name.endsWith(".json") || name.endsWith(".toml") || name.endsWith(".yaml") || name.endsWith(".yml")) return "codicon-json";
  return "codicon-file";
}

function useVisibilityRefresh(callback: () => void) {
  useEffect(() => {
    const onFocus = () => callback();
    const onVisibility = () => {
      if (document.visibilityState === "visible") callback();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [callback]);
}

function App() {
  const [repoState, setRepoState] = useState<RepoState | null>(null);
  const [selectedPath, setSelectedPath] = useState(() => decodeURIComponent(window.location.hash.slice(1) || ""));
  const [selectedFile, setSelectedFile] = useState<FilePayload | null>(null);
  const [mode, setMode] = useState<ViewMode>("full");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string>("");

  const loadState = useCallback(async () => {
    try {
      const payload = await fetchJson<RepoState>("/api/state");
      setRepoState(payload);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    loadState();
    const timer = window.setInterval(loadState, 5000);
    return () => window.clearInterval(timer);
  }, [loadState]);

  useVisibilityRefresh(loadState);

  useEffect(() => {
    if (!selectedPath) return;
    let cancelled = false;
    fetchJson<FilePayload>(`/api/file?path=${encodeURIComponent(selectedPath)}`)
      .then((payload) => {
        if (!cancelled) {
          setSelectedFile(payload);
          setError("");
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath, repoState]);

  const selectedExists = useMemo(() => {
    if (!repoState || !selectedPath) return false;
    return repoState.files.some((file) => file.path === selectedPath);
  }, [repoState, selectedPath]);

  useEffect(() => {
    if (selectedPath && repoState && !selectedExists) {
      setSelectedPath("");
      setSelectedFile(null);
      history.replaceState(null, "", location.pathname);
    }
  }, [repoState, selectedExists, selectedPath]);

  const openFile = (path: string) => {
    setSelectedPath(path);
    history.replaceState(null, "", `#${encodeURIComponent(path)}`);
  };

  const goBack = () => {
    setSelectedPath("");
    setSelectedFile(null);
    history.replaceState(null, "", location.pathname);
  };

  const isFileOpen = Boolean(selectedPath);

  return (
    <main className="app-shell">
      <section className={`explorer ${isFileOpen ? "mobile-hidden" : ""}`} aria-label="Repository files">
        <header className="explorer-header">
          <div className="title-stack">
            <span className="section-label">Explorer</span>
            <h1>{repoState ? basename(repoState.repo) : "Loading..."}</h1>
            <div className="meta-line">
              <span>{repoState?.branch || ""}</span>
              <span>{repoState ? `${repoState.counts.all} files, ${repoState.counts.total} changed` : ""}</span>
            </div>
          </div>
          <button className="icon-button codicon codicon-refresh" type="button" title="Refresh" aria-label="Refresh" onClick={loadState} />
        </header>

        <div className="change-strip">
          <span><strong>{repoState?.counts.changed ?? 0}</strong> modified</span>
          <span><strong>{repoState?.counts.new ?? 0}</strong> new</span>
          <span><strong>{repoState?.counts.deleted ?? 0}</strong> deleted</span>
        </div>

        <div className="tree-scroll">
          {error && <div className="empty-state">{error}</div>}
          {!error && repoState?.tree?.children?.map((node) => (
            <TreeItem
              key={node.path || node.name}
              node={node}
              depth={0}
              collapsed={collapsed}
              selectedPath={selectedPath}
              onToggle={(path) => {
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                });
              }}
              onOpen={openFile}
            />
          ))}
          {!error && repoState && repoState.files.length === 0 && <div className="empty-state">No files found.</div>}
        </div>
      </section>

      <section className={`viewer ${isFileOpen ? "" : "mobile-hidden"}`} aria-label="File viewer">
        {selectedFile ? (
          <>
            <header className="viewer-header">
              <button className="back-button" type="button" onClick={goBack}>
                <span className="codicon codicon-arrow-left" />
                Back
              </button>
              <div className="file-title">
                <h2>{selectedFile.path}</h2>
                <span className={`status-pill ${selectedFile.status.category}`}>{selectedFile.status.label}</span>
              </div>
              <div className="segmented">
                <button className={mode === "full" ? "active" : ""} type="button" onClick={() => setMode("full")}>Full</button>
                <button className={mode === "changes" ? "active" : ""} type="button" onClick={() => setMode("changes")}>Changes</button>
              </div>
            </header>
            {selectedFile.binary ? (
              <div className="empty-state">Binary file; text preview is not available.</div>
            ) : mode === "changes" ? (
              <DiffCodeView diff={selectedFile.diff} language={selectedFile.language} />
            ) : (
              <FullCodeView lines={selectedFile.fullLines} language={selectedFile.language} />
            )}
          </>
        ) : (
          <div className="placeholder">
            <span className="codicon codicon-file-code" />
            <p>Select a file from the explorer.</p>
          </div>
        )}
      </section>
    </main>
  );
}

function FullCodeView({ lines, language }: { lines: FullLine[]; language: string }) {
  if (!lines.length) {
    return <div className="empty-state">No text content to display.</div>;
  }

  return (
    <pre className="code-view selectable-code" aria-label="Full file">
      {lines.map((line, index) => (
        <span className={`code-line ${line.kind}`} key={`${index}-${line.number ?? "old"}`}>
          <span className="line-number" aria-hidden="true">{displayLineNumber(lines, index + 1)}</span>
          <HighlightedCode text={line.text || " "} language={language} />
        </span>
      ))}
    </pre>
  );
}

function DiffCodeView({ diff, language }: { diff: string; language: string }) {
  const lines = parseDiffLines(diff);
  if (!lines.length) {
    return <div className="empty-state">No changes for this file.</div>;
  }

  return (
    <pre className="code-view selectable-code" aria-label="Changes only">
      {lines.map((line) => (
        <span className={`code-line diff-${line.kind}`} key={line.number}>
          <span className="line-number" aria-hidden="true">{line.number}</span>
          <HighlightedDiffCode line={line} language={language} />
        </span>
      ))}
    </pre>
  );
}

function HighlightedDiffCode({ line, language }: { line: DiffLine; language: string }) {
  if (line.kind === "added" || line.kind === "deleted") {
    const prefix = line.text.slice(0, 1);
    const body = line.text.slice(1);
    return (
      <code className="line-text">
        <span className="diff-prefix">{prefix}</span>
        <HighlightedInline text={body || " "} language={language} />
      </code>
    );
  }
  if (line.kind === "context" && line.text.startsWith(" ")) {
    return (
      <code className="line-text">
        <span className="diff-prefix"> </span>
        <HighlightedInline text={line.text.slice(1) || " "} language={language} />
      </code>
    );
  }
  return <code className="line-text">{line.text || " "}</code>;
}

function HighlightedCode({ text, language }: { text: string; language: string }) {
  return (
    <code className="line-text">
      <HighlightedInline text={text} language={language} />
    </code>
  );
}

function HighlightedInline({ text, language }: { text: string; language: string }) {
  return <span dangerouslySetInnerHTML={{ __html: highlightLine(text, language) }} />;
}

function TreeItem({
  node,
  depth,
  collapsed,
  selectedPath,
  onToggle,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  selectedPath: string;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  if (node.type === "directory") {
    const isCollapsed = collapsed.has(node.path);
    return (
      <div className="tree-node">
        <button className={`tree-row directory ${node.category}`} style={{ "--depth": depth } as React.CSSProperties} type="button" onClick={() => onToggle(node.path)}>
          <span className={`codicon ${isCollapsed ? "codicon-chevron-right" : "codicon-chevron-down"} tree-chevron`} />
          <span className={`codicon ${isCollapsed ? "codicon-folder" : "codicon-folder-opened"} tree-icon folder-icon`} />
          <span className="tree-name">{node.name}</span>
          <span className="tree-status">{statusLetter(node.category)}</span>
        </button>
        {!isCollapsed && node.children?.map((child) => (
          <TreeItem key={child.path || child.name} node={child} depth={depth + 1} collapsed={collapsed} selectedPath={selectedPath} onToggle={onToggle} onOpen={onOpen} />
        ))}
      </div>
    );
  }

  return (
    <button className={`tree-row file ${node.category} ${selectedPath === node.path ? "selected" : ""}`} style={{ "--depth": depth } as React.CSSProperties} type="button" onClick={() => onOpen(node.path)}>
      <span className="tree-chevron" />
      <span className={`codicon ${iconForFile(node.path)} tree-icon file-icon`} />
      <span className="tree-name">{node.name}</span>
      <span className="tree-status">{statusLetter(node.category)}</span>
      {node.old_path && <span className="old-path">from {node.old_path}</span>}
    </button>
  );
}

function displayLineNumber(lines: FullLine[], lineNumber: number): string {
  const line = lines[lineNumber - 1];
  if (!line) return String(lineNumber);
  if (line.number === null || line.number === undefined) return "-";
  return String(line.number);
}

function highlightLine(text: string, language: string): string {
  const normalized = normalizeHighlightLanguage(language);
  try {
    if (normalized && hljs.getLanguage(normalized)) {
      return hljs.highlight(text, { language: normalized, ignoreIllegals: true }).value;
    }
  } catch {
    // Fall back to escaped plain text if a grammar rejects the line.
  }
  return escapeHtml(text);
}

function normalizeHighlightLanguage(language: string): string {
  if (language === "plaintext") return "";
  if (language === "shell") return "bash";
  if (language === "dockerfile") return "bash";
  if (language === "toml") return "ini";
  return language;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseDiffLines(diff: string): DiffLine[] {
  return diff
    .split("\n")
    .filter((line) => line && !line.startsWith("diff --git") && !line.startsWith("index "))
    .map((line, index) => {
      let kind: DiffLine["kind"] = "context";
      if (line.startsWith("@@")) kind = "hunk";
      else if (line.startsWith("+++") || line.startsWith("---")) kind = "meta";
      else if (line.startsWith("+")) kind = "added";
      else if (line.startsWith("-")) kind = "deleted";
      return { number: index + 1, text: line, kind };
    });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
