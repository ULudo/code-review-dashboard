import "@vscode/codicons/dist/codicon.css";
import "./styles.css";

import Editor, { DiffEditor, type Monaco } from "@monaco-editor/react";
import * as monacoTypes from "monaco-editor";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const editorOptions: monacoTypes.editor.IStandaloneEditorConstructionOptions = {
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 13,
  lineHeight: 20,
  folding: false,
  glyphMargin: false,
  lineDecorationsWidth: 10,
  lineNumbersMinChars: 4,
  renderLineHighlight: "none",
  scrollBeyondLastLine: false,
  automaticLayout: true,
  wordWrap: "off",
  contextmenu: false,
};

const diffOptions: monacoTypes.editor.IStandaloneDiffEditorConstructionOptions = {
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 13,
  lineHeight: 20,
  renderSideBySide: false,
  useInlineViewWhenSpaceIsLimited: true,
  lineDecorationsWidth: 10,
  lineNumbersMinChars: 4,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  wordWrap: "off",
  contextmenu: false,
};

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
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<monacoTypes.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<monacoTypes.editor.IEditorDecorationsCollection | null>(null);

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

  const configureMonaco = (monaco: Monaco) => {
    monacoRef.current = monaco;
    monaco.editor.defineTheme("review-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#1e1e1e",
        "editorLineNumber.foreground": "#6e7681",
        "editorGutter.background": "#1e1e1e",
        "diffEditor.insertedTextBackground": "#14361f",
        "diffEditor.removedTextBackground": "#3f1818",
      },
    });
    monaco.editor.setTheme("review-dark");
  };

  const onEditorMount = (editor: monacoTypes.editor.IStandaloneCodeEditor, monaco: Monaco) => {
    editorRef.current = editor;
    if (!monacoRef.current) configureMonaco(monaco);
    decorationsRef.current = editor.createDecorationsCollection();
    applyLineDecorations(selectedFile, decorationsRef.current);
  };

  useEffect(() => {
    if (editorRef.current) applyLineDecorations(selectedFile, decorationsRef.current);
  }, [selectedFile, mode]);

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
              <DiffEditor
                key={`diff-${selectedFile.path}`}
                original={selectedFile.originalContent}
                modified={selectedFile.currentContent}
                language={selectedFile.language}
                theme="review-dark"
                beforeMount={configureMonaco}
                options={diffOptions}
              />
            ) : (
              <Editor
                key={`full-${selectedFile.path}`}
                value={selectedFile.reviewContent}
                language={selectedFile.language}
                theme="review-dark"
                beforeMount={configureMonaco}
                onMount={onEditorMount}
                options={{
                  ...editorOptions,
                  lineNumbers: (lineNumber) => displayLineNumber(selectedFile.fullLines, lineNumber),
                }}
              />
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

function applyLineDecorations(file: FilePayload | null, collection: monacoTypes.editor.IEditorDecorationsCollection | null) {
  if (!file || !collection) return;
  const decorations = file.fullLines
    .map((line, index) => {
      if (line.kind === "context") return null;
      return {
        range: new monacoTypes.Range(index + 1, 1, index + 1, 1),
        options: {
          isWholeLine: true,
          className: `line-${line.kind}`,
          linesDecorationsClassName: `gutter-${line.kind}`,
        },
      };
    })
    .filter(Boolean) as monacoTypes.editor.IModelDeltaDecoration[];
  collection.set(decorations);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
