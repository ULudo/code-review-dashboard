import "@vscode/codicons/dist/codicon.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
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
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

type Category = "clean" | "modified" | "new" | "deleted";
type ViewMode = "full" | "changes";
type AppView = "source" | "terminal";

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

type TmuxSession = {
  name: string;
  windows: number;
  attached: number;
  created: number;
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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
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
  const [view, setView] = useState<AppView>("source");
  const [menuOpen, setMenuOpen] = useState(false);
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

  if (view === "terminal") {
    return (
      <TerminalView
        onSource={() => {
          setView("source");
          setMenuOpen(false);
        }}
      />
    );
  }

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
          <div className="menu-wrap">
            <button className="icon-button codicon codicon-menu" type="button" title="Menu" aria-label="Menu" onClick={() => setMenuOpen((open) => !open)} />
            {menuOpen && (
              <div className="app-menu">
                <button type="button" className="active" onClick={() => setMenuOpen(false)}>Source</button>
                <button type="button" onClick={() => { setView("terminal"); setMenuOpen(false); }}>Terminal</button>
              </div>
            )}
          </div>
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

function TerminalView({ onSource }: { onSource: () => void }) {
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [activeSession, setActiveSession] = useState<string>("");
  const [newSessionName, setNewSessionName] = useState("");
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      const payload = await fetchJson<{ sessions: TmuxSession[] }>("/api/tmux/sessions");
      setSessions(payload.sessions);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    loadSessions();
    const timer = window.setInterval(loadSessions, 5000);
    return () => window.clearInterval(timer);
  }, [loadSessions]);

  const createSession = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newSessionName.trim();
    if (!name) return;
    try {
      const payload = await fetchJson<{ session: TmuxSession; sessions: TmuxSession[] }>("/api/tmux/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setSessions(payload.sessions);
      setActiveSession(payload.session.name);
      setNewSessionName("");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (activeSession) {
    return <AttachedTerminal session={activeSession} onBack={() => { setActiveSession(""); loadSessions(); }} onSource={onSource} />;
  }

  return (
    <main className="terminal-shell">
      <header className="terminal-header">
        <div className="title-stack">
          <span className="section-label">Terminal</span>
          <h1>tmux sessions</h1>
          <div className="meta-line"><span>{sessions.length} sessions</span></div>
        </div>
        <div className="menu-wrap">
          <button className="icon-button codicon codicon-menu" type="button" title="Menu" aria-label="Menu" onClick={() => setMenuOpen((open) => !open)} />
          {menuOpen && (
            <div className="app-menu">
              <button type="button" onClick={onSource}>Source</button>
              <button type="button" className="active" onClick={() => setMenuOpen(false)}>Terminal</button>
            </div>
          )}
        </div>
      </header>

      <section className="terminal-session-panel">
        <form className="new-session-form" onSubmit={createSession}>
          <input
            value={newSessionName}
            onChange={(event) => setNewSessionName(event.target.value)}
            placeholder="New session name"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" className="new-session-button" aria-label="Create session">
            <span className="codicon codicon-add" />
          </button>
        </form>
        {error && <div className="terminal-error">{error}</div>}
        <div className="session-list">
          {sessions.map((session) => (
            <button className="session-row" type="button" key={session.name} onClick={() => setActiveSession(session.name)}>
              <span className="codicon codicon-terminal" />
              <span className="session-name">{session.name}</span>
              <span className="session-meta">{session.windows} win · {session.attached} attached</span>
            </button>
          ))}
          {!sessions.length && !error && <div className="empty-state">No tmux sessions.</div>}
        </div>
      </section>
    </main>
  );
}

function AttachedTerminal({ session, onBack, onSource }: { session: string; onBack: () => void; onSource: () => void }) {
  const terminalHost = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const composeOpenRef = useRef(false);
  const resizeLockedRef = useRef(false);
  const composerActionHandledRef = useRef(false);
  const composerComposingRef = useRef(false);
  const composeTextRef = useRef("");
  const useMobileInput = useMemo(() => window.matchMedia("(pointer: coarse)").matches, []);
  const lastTouchY = useRef<number | null>(null);
  const [status, setStatus] = useState("Connecting");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectionText, setSelectionText] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeText, setComposeText] = useState("");

  const fitTerminal = (sendSize: boolean) => {
    const socket = socketRef.current;
    const terminal = terminalRef.current;
    const fitAddon = fitRef.current;
    if (!terminal || !fitAddon) return;
    fitAddon.fit();
    if (sendSize && socket) {
      sendTerminalSize(socket, terminal, fitAddon);
    }
  };

  const terminalViewportHeight = () => {
    return composeOpenRef.current ? window.visualViewport?.height ?? window.innerHeight : window.innerHeight;
  };

  useEffect(() => {
    composeOpenRef.current = composeOpen;
  }, [composeOpen]);

  useEffect(() => {
    composeTextRef.current = composeText;
  }, [composeText]);

  useEffect(() => {
    if (!composeOpen) return;
    const keepPagePinned = () => window.scrollTo(0, 0);
    keepPagePinned();
    window.addEventListener("scroll", keepPagePinned, { passive: true });
    window.visualViewport?.addEventListener("scroll", keepPagePinned, { passive: true });
    return () => {
      window.removeEventListener("scroll", keepPagePinned);
      window.visualViewport?.removeEventListener("scroll", keepPagePinned);
      keepPagePinned();
    };
  }, [composeOpen]);

  useEffect(() => {
    if (!terminalHost.current) return;
    let disposed = false;
    let reconnectTimer = 0;
    let heartbeatTimer = 0;
    const terminal = new Terminal({
      cursorBlink: true,
      disableStdin: useMobileInput,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.15,
      scrollback: 10000,
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHost.current);
    fitAddon.fit();
    if (!useMobileInput) {
      terminal.focus();
    }

    const initialDimensions = fitAddon.proposeDimensions();
    const initialCols = initialDimensions?.cols || terminal.cols || 80;
    const initialRows = initialDimensions?.rows || terminal.rows || 24;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    terminalRef.current = terminal;
    fitRef.current = fitAddon;

    const connectSocket = () => {
      if (disposed) return;
      setStatus(socketRef.current ? "Reconnecting" : "Connecting");
      const nextSocket = new WebSocket(`${protocol}://${window.location.host}/api/tmux/attach?session=${encodeURIComponent(session)}&cols=${initialCols}&rows=${initialRows}`);
      socketRef.current = nextSocket;

      nextSocket.addEventListener("open", () => {
        setStatus("Attached");
        sendTerminalSize(nextSocket, terminal, fitAddon);
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = window.setInterval(() => {
          if (nextSocket.readyState === WebSocket.OPEN) {
            try {
              nextSocket.send(JSON.stringify({ type: "ping" }));
            } catch {
              nextSocket.close();
            }
          }
        }, 25000);
      });
      nextSocket.addEventListener("message", (event) => terminal.write(String(event.data)));
      nextSocket.addEventListener("close", () => {
        window.clearInterval(heartbeatTimer);
        if (disposed) return;
        setStatus("Reconnecting");
        reconnectTimer = window.setTimeout(connectSocket, 1200);
      });
      nextSocket.addEventListener("error", () => {
        setStatus("Connection error");
        nextSocket.close();
      });
    };
    connectSocket();

    const dataDisposable = terminal.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });
    const resizeDisposable = terminal.onResize((size) => {
      if (composeOpenRef.current) return;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
      }
    });

    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        fitAddon.fit();
        const socket = socketRef.current;
        if (socket && !composeOpenRef.current) {
          sendTerminalSize(socket, terminal, fitAddon);
        }
      }, 160);
    };
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      window.clearTimeout(resizeTimer);
      window.clearTimeout(reconnectTimer);
      window.clearInterval(heartbeatTimer);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      socketRef.current?.close();
      terminal.dispose();
    };
  }, [session, useMobileInput]);

  useEffect(() => {
    let resizeTimer = 0;
    const updateViewportHeight = () => {
      document.documentElement.style.setProperty("--terminal-height", `${terminalViewportHeight()}px`);
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        fitRef.current?.fit();
        const socket = socketRef.current;
        const terminal = terminalRef.current;
        const fitAddon = fitRef.current;
        if (socket && terminal && fitAddon && !composeOpenRef.current) {
          sendTerminalSize(socket, terminal, fitAddon);
        }
      }, 220);
    };
    updateViewportHeight();
    window.visualViewport?.addEventListener("resize", updateViewportHeight);
    return () => {
      window.visualViewport?.removeEventListener("resize", updateViewportHeight);
      window.clearTimeout(resizeTimer);
      document.documentElement.style.removeProperty("--terminal-height");
    };
  }, []);

  useEffect(() => {
    if (composeOpen) return;
    document.documentElement.style.setProperty("--terminal-height", `${terminalViewportHeight()}px`);
    window.setTimeout(() => {
      fitTerminal(true);
    }, 160);
  }, [composeOpen]);

  const sendTmuxNavigation = (action: string, count = 5) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "tmux", action, count }));
    }
  };

  const focusTerminal = () => {
    if (selectionMode) return;
    if (useMobileInput) return;
    terminalRef.current?.focus();
  };

  const sendInput = (data: string) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }));
    }
  };

  const setResizeLock = (locked: boolean) => {
    if (resizeLockedRef.current === locked) return;
    resizeLockedRef.current = locked;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "resize-lock", locked }));
    }
  };

  const focusComposerInput = () => {
    composerInputRef.current?.focus({ preventScroll: true });
  };

  const openComposer = () => {
    if (!useMobileInput || selectionMode) return;
    if (composeOpenRef.current) {
      focusComposerInput();
      return;
    }
    composeOpenRef.current = true;
    setResizeLock(true);
    flushSync(() => {
      setComposeOpen(true);
    });
    focusComposerInput();
    window.setTimeout(focusComposerInput, 60);
  };

  const toggleComposer = () => {
    if (composeOpenRef.current) {
      closeComposer(false);
      return;
    }
    openComposer();
  };

  const closeComposer = (clearText = true) => {
    if (!composeOpenRef.current && !composeOpen) {
      setResizeLock(false);
      return;
    }
    composeOpenRef.current = false;
    setComposeOpen(false);
    if (clearText) {
      composeTextRef.current = "";
      setComposeText("");
    }
    window.setTimeout(() => {
      fitTerminal(false);
      setResizeLock(false);
      fitTerminal(true);
      window.setTimeout(() => fitTerminal(true), 220);
    }, 180);
  };

  const sendTextDelta = (previous: string, next: string) => {
    if (next === previous || composerComposingRef.current) return;
    if (next.startsWith(previous)) {
      sendInput(next.slice(previous.length));
      return;
    }
    if (previous.startsWith(next)) {
      sendInput("\x7f".repeat(previous.length - next.length));
      return;
    }

    let prefixLength = 0;
    while (
      prefixLength < previous.length &&
      prefixLength < next.length &&
      previous[prefixLength] === next[prefixLength]
    ) {
      prefixLength += 1;
    }

    const removed = previous.length - prefixLength;
    const added = next.slice(prefixLength);
    if (removed > 0) {
      sendInput("\x7f".repeat(removed));
    }
    if (added) {
      sendInput(added);
    }
  };

  const sendEnter = () => {
    sendInput("\r");
    composeTextRef.current = "";
    setComposeText("");
  };

  const updateComposerValue = (value: string) => {
    sendTextDelta(composeTextRef.current, value);
    composeTextRef.current = value;
    setComposeText(value);
  };

  const handleComposerChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    updateComposerValue(event.target.value);
  };

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendEnter();
    } else if (event.key === "Backspace" && !event.currentTarget.value) {
      event.preventDefault();
      sendInput("\x7f");
    } else if (event.key === "Escape") {
      event.preventDefault();
      sendInput("\x1b");
    } else if (event.key === "Tab") {
      event.preventDefault();
      sendInput("\t");
    }
  };

  const handleComposerAction = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    composerActionHandledRef.current = true;
    sendEnter();
    window.setTimeout(() => {
      composerActionHandledRef.current = false;
    }, 500);
  };

  const handleComposerClick = () => {
    if (composerActionHandledRef.current) return;
    sendEnter();
  };

  const handleTerminalWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (selectionMode) return;
    if (Math.abs(event.deltaY) < 4) return;
    event.preventDefault();
    const count = Math.min(50, Math.max(3, Math.round(Math.abs(event.deltaY) / 8)));
    sendTmuxNavigation(event.deltaY < 0 ? "scroll-up" : "scroll-down", count);
  };

  const handleMobilePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!useMobileInput || selectionMode) return;
    event.preventDefault();
    event.stopPropagation();
    if (composeOpenRef.current) {
      focusComposerInput();
      return;
    }
    openComposer();
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (selectionMode) return;
    lastTouchY.current = event.touches[0]?.clientY ?? null;
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    if (selectionMode) return;
    const currentY = event.touches[0]?.clientY;
    const previousY = lastTouchY.current;
    if (currentY == null || previousY == null) return;
    const delta = currentY - previousY;
    if (Math.abs(delta) < 14) return;
    event.preventDefault();
    const count = Math.min(30, Math.max(3, Math.round(Math.abs(delta) / 6)));
    sendTmuxNavigation(delta > 0 ? "scroll-up" : "scroll-down", count);
    lastTouchY.current = currentY;
  };

  const handleTouchEnd = () => {
    lastTouchY.current = null;
  };

  const toggleSelectionMode = () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (selectionMode) {
      setSelectionMode(false);
      return;
    }
    closeComposer(false);
    setSelectionText(terminalBufferText(terminal));
    setSelectionMode(true);
  };

  return (
    <main className="terminal-shell">
      <header className="terminal-header attached">
        <button className="back-button" type="button" onClick={onBack}>
          <span className="codicon codicon-arrow-left" />
          Sessions
        </button>
        <div className="file-title">
          <h2>{session}</h2>
          <span className="status-pill clean">{status}</span>
        </div>
        <div className="terminal-actions">
          {useMobileInput && (
            <button className={`source-button ${composeOpen ? "active" : ""}`} type="button" onClick={toggleComposer}>
              Text
            </button>
          )}
          <button className={`source-button ${selectionMode ? "active" : ""}`} type="button" onClick={toggleSelectionMode}>
            {selectionMode ? "Live" : "Select"}
          </button>
        </div>
      </header>
      <div className="terminal-live">
        <div
          className="terminal-host"
          ref={terminalHost}
          onClick={focusTerminal}
          onPointerDownCapture={handleMobilePointerDown}
          onWheel={handleTerminalWheel}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        />
        {selectionMode && (
          <textarea
            className="terminal-selection-layer"
            aria-label="Selectable terminal text"
            readOnly
            value={selectionText || "No terminal text available."}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        )}
        {composeOpen && (
          <div className="terminal-compose">
            <div className="terminal-compose-row">
              <input
                ref={composerInputRef}
                className="terminal-compose-input"
                value={composeText}
                onChange={handleComposerChange}
                onCompositionStart={() => { composerComposingRef.current = true; }}
                onCompositionEnd={(event) => {
                  composerComposingRef.current = false;
                  updateComposerValue(event.currentTarget.value);
                }}
                onKeyDown={handleComposerKeyDown}
                placeholder="Type or paste"
                autoFocus
                autoCapitalize="sentences"
                autoComplete="on"
                autoCorrect="on"
                enterKeyHint="send"
                spellCheck={true}
              />
              <button
                type="button"
                onPointerDown={handleComposerAction}
                onClick={handleComposerClick}
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function terminalBufferText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n").replace(/\s+$/u, "");
}

function sendTerminalSize(socket: WebSocket, terminal: Terminal, fitAddon: FitAddon) {
  if (socket.readyState !== WebSocket.OPEN) return;
  const dimensions = fitAddon.proposeDimensions();
  socket.send(JSON.stringify({
    type: "resize",
    cols: dimensions?.cols || terminal.cols,
    rows: dimensions?.rows || terminal.rows,
  }));
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
