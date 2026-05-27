from __future__ import annotations

import argparse
import asyncio
import contextlib
import difflib
import fcntl
import ipaddress
import os
import posixpath
import pty
import re
import secrets
import shutil
import signal
import socket
import struct
import subprocess
import sys
import termios
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from importlib import resources
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response


DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8765
TEXT_LIMIT_BYTES = 1_500_000
TOKEN_COOKIE = "code_review_dashboard_token"
SESSION_NAME_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")

LANGUAGE_BY_EXTENSION = {
    ".css": "css",
    ".go": "go",
    ".html": "html",
    ".java": "java",
    ".js": "javascript",
    ".json": "json",
    ".jsx": "javascript",
    ".md": "markdown",
    ".py": "python",
    ".rs": "rust",
    ".sh": "shell",
    ".toml": "toml",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
}


class DashboardError(Exception):
    status = HTTPStatus.BAD_REQUEST


class NotFoundError(DashboardError):
    status = HTTPStatus.NOT_FOUND


@dataclass(frozen=True)
class FileStatus:
    path: str
    xy: str
    category: str
    label: str
    old_path: str | None = None


def run_git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=check,
    )


def decode_git(data: bytes) -> str:
    return data.decode("utf-8", "surrogateescape")


def detect_repo(start: Path) -> Path:
    proc = subprocess.run(
        ["git", "-C", str(start), "rev-parse", "--show-toplevel"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise DashboardError(f"{start} is not inside a Git repository.")
    return Path(decode_git(proc.stdout).strip()).resolve()


def has_head(repo: Path) -> bool:
    return run_git(repo, "rev-parse", "--verify", "HEAD", check=False).returncode == 0


def current_branch(repo: Path) -> str:
    proc = run_git(repo, "branch", "--show-current", check=False)
    branch = decode_git(proc.stdout).strip()
    if branch:
        return branch
    proc = run_git(repo, "rev-parse", "--short", "HEAD", check=False)
    commit = decode_git(proc.stdout).strip()
    return commit or "(no commits)"


def normalize_repo_path(raw: str) -> str:
    raw = unquote(raw).replace("\\", "/")
    if raw.startswith("/") or "\x00" in raw:
        raise DashboardError("Invalid repository path.")
    normalized = posixpath.normpath(raw)
    if normalized in ("", ".") or normalized.startswith("../") or normalized == "..":
        raise DashboardError("Invalid repository path.")
    return normalized


def path_on_disk(repo: Path, rel_path: str) -> Path:
    path = (repo / rel_path).resolve()
    try:
        path.relative_to(repo)
    except ValueError as exc:
        raise DashboardError("Path escapes repository.") from exc
    return path


def parse_status(repo: Path) -> list[FileStatus]:
    proc = run_git(repo, "status", "--porcelain=v2", "-z", "--untracked-files=all")
    records = proc.stdout.split(b"\0")
    files: list[FileStatus] = []
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        marker = record[:1]
        if marker == b"?":
            path = decode_git(record[2:])
            files.append(FileStatus(path=path, xy="??", category="new", label="Untracked"))
        elif marker == b"1":
            parts = record.split(b" ", 8)
            if len(parts) < 9:
                continue
            xy = decode_git(parts[1])
            path = decode_git(parts[8])
            files.append(classify_status(path, xy))
        elif marker == b"2":
            parts = record.split(b" ", 9)
            old_path = None
            if index < len(records):
                old_path = decode_git(records[index])
                index += 1
            if len(parts) < 10:
                continue
            xy = decode_git(parts[1])
            path = decode_git(parts[9])
            files.append(classify_status(path, xy, old_path=old_path))
    return sorted(files, key=lambda item: (item.category, item.path.lower()))


def classify_status(path: str, xy: str, old_path: str | None = None) -> FileStatus:
    if "D" in xy:
        return FileStatus(path=path, xy=xy, category="deleted", label="Deleted", old_path=old_path)
    if xy.startswith("R"):
        return FileStatus(path=path, xy=xy, category="modified", label="Renamed", old_path=old_path)
    if xy.startswith("C"):
        return FileStatus(path=path, xy=xy, category="new", label="Copied", old_path=old_path)
    if "A" in xy:
        return FileStatus(path=path, xy=xy, category="new", label="New", old_path=old_path)
    if "U" in xy:
        return FileStatus(path=path, xy=xy, category="modified", label="Conflict", old_path=old_path)
    return FileStatus(path=path, xy=xy, category="modified", label="Modified", old_path=old_path)


def all_repo_paths(repo: Path, changed_files: list[FileStatus]) -> list[str]:
    proc = run_git(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    paths = {decode_git(path) for path in proc.stdout.split(b"\0") if path}
    paths.update(item.path for item in changed_files)
    return sorted(paths, key=lambda path: path.lower())


def clean_file(path: str) -> dict[str, Any]:
    return {"path": path, "xy": "  ", "category": "clean", "label": "Clean", "old_path": None}


def status_priority(category: str) -> int:
    return {"deleted": 3, "new": 2, "modified": 1, "clean": 0}.get(category, 0)


def directory_status(children: dict[str, dict[str, Any]]) -> tuple[str, str]:
    category = "clean"
    for child in children.values():
        child_category = child.get("category", "clean")
        if status_priority(child_category) > status_priority(category):
            category = child_category
    label = {"deleted": "Deleted inside", "new": "New inside", "modified": "Changed inside", "clean": "Clean"}[category]
    return category, label


def build_tree(paths: list[str], status_by_path: dict[str, FileStatus]) -> dict[str, Any]:
    root: dict[str, Any] = {
        "name": "",
        "path": "",
        "type": "directory",
        "category": "clean",
        "label": "Clean",
        "children": {},
    }

    for path in paths:
        parts = path.split("/")
        current = root
        for index, part in enumerate(parts):
            current_path = "/".join(parts[: index + 1])
            is_file = index == len(parts) - 1
            children = current["children"]
            if part not in children:
                children[part] = {
                    "name": part,
                    "path": current_path,
                    "type": "file" if is_file else "directory",
                    "category": "clean",
                    "label": "Clean",
                    "xy": "  ",
                    "old_path": None,
                    "children": {},
                }
            current = children[part]

        status = status_by_path.get(path)
        if status:
            current.update(status.__dict__)
            current["type"] = "file"
            current["name"] = parts[-1]
        else:
            current.update(clean_file(path))
            current["type"] = "file"
            current["name"] = parts[-1]

    def finalize(node: dict[str, Any]) -> dict[str, Any]:
        if node["type"] == "file":
            node.pop("children", None)
            return node

        finalized_children = [finalize(child) for child in node["children"].values()]
        finalized_children.sort(key=lambda child: (child["type"] == "file", child["name"].lower()))
        node["children"] = finalized_children
        node["category"], node["label"] = directory_status({child["name"]: child for child in finalized_children})
        node["xy"] = ""
        node["old_path"] = None
        return node

    return finalize(root)


def repo_state(repo: Path) -> dict[str, Any]:
    changed_files = parse_status(repo)
    status_by_path = {item.path: item for item in changed_files}
    paths = all_repo_paths(repo, changed_files)
    files = [status_by_path[path].__dict__ if path in status_by_path else clean_file(path) for path in paths]
    return {
        "repo": str(repo),
        "branch": current_branch(repo),
        "hasHead": has_head(repo),
        "counts": {
            "changed": sum(1 for item in changed_files if item.category == "modified"),
            "new": sum(1 for item in changed_files if item.category == "new"),
            "deleted": sum(1 for item in changed_files if item.category == "deleted"),
            "total": len(changed_files),
            "all": len(files),
        },
        "tree": build_tree(paths, status_by_path),
        "files": files,
    }


def read_text_file(repo: Path, rel_path: str) -> tuple[list[str], bool]:
    text, binary = read_text_blob(repo, rel_path)
    return text.splitlines(), binary


def read_text_blob(repo: Path, rel_path: str) -> tuple[str, bool]:
    disk_path = path_on_disk(repo, rel_path)
    try:
        data = disk_path.read_bytes()
    except FileNotFoundError as exc:
        raise NotFoundError(f"{rel_path} does not exist in the working tree.") from exc
    return decode_text_blob(data, rel_path)


def decode_text_blob(data: bytes, rel_path: str) -> tuple[str, bool]:
    if b"\x00" in data:
        return "", True
    if len(data) > TEXT_LIMIT_BYTES:
        raise DashboardError(f"{rel_path} is larger than the {TEXT_LIMIT_BYTES} byte display limit.")
    return data.decode("utf-8", "replace"), False


def read_head_text(repo: Path, rel_path: str) -> tuple[list[str], bool]:
    text, binary = read_head_text_blob(repo, rel_path)
    return text.splitlines(), binary


def read_head_text_blob(repo: Path, rel_path: str) -> tuple[str, bool]:
    proc = run_git(repo, "show", f"HEAD:{rel_path}", check=False)
    if proc.returncode != 0:
        return "", False
    return decode_text_blob(proc.stdout, rel_path)


def get_status_for_path(repo: Path, rel_path: str) -> FileStatus | None:
    for item in parse_status(repo):
        if item.path == rel_path:
            return item
    return None


def is_probably_untracked(repo: Path, rel_path: str) -> bool:
    proc = run_git(repo, "ls-files", "--error-unmatch", "--", rel_path, check=False)
    return proc.returncode != 0


def unified_diff_for_file(repo: Path, rel_path: str, status: FileStatus | None, context: int = 3) -> str:
    if status and status.category == "new" and is_probably_untracked(repo, rel_path):
        lines, binary = read_text_file(repo, rel_path)
        if binary:
            return f"diff --git a/{rel_path} b/{rel_path}\nBinary file b/{rel_path} differs\n"
        return "".join(
            difflib.unified_diff(
                [],
                [line + "\n" for line in lines],
                fromfile="/dev/null",
                tofile=f"b/{rel_path}",
                n=context,
            )
        )

    base = "HEAD" if has_head(repo) else "--cached"
    proc = run_git(
        repo,
        "diff",
        "--no-ext-diff",
        f"--unified={context}",
        base,
        "--",
        rel_path,
        check=False,
    )
    if proc.returncode not in (0, 1):
        raise DashboardError(decode_git(proc.stderr).strip() or "Unable to read Git diff.")
    return decode_git(proc.stdout)


HUNK_RE = re.compile(r"^@@ -(?P<old>\d+)(?:,(?P<old_len>\d+))? \+(?P<new>\d+)(?:,(?P<new_len>\d+))? @@")


def parse_patch_hunks(diff_text: str) -> list[dict[str, Any]]:
    hunks: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in diff_text.splitlines():
        match = HUNK_RE.match(line)
        if match:
            current = {
                "oldStart": int(match.group("old")),
                "oldLength": int(match.group("old_len") or "1"),
                "newStart": int(match.group("new")),
                "newLength": int(match.group("new_len") or "1"),
                "lines": [],
            }
            hunks.append(current)
            continue
        if current is None:
            continue
        if line.startswith("\\"):
            continue
        if not line:
            prefix = " "
            text = ""
        else:
            prefix = line[0]
            text = line[1:]
        if prefix in (" ", "+", "-"):
            current["lines"].append({"type": prefix, "text": text})
    return hunks


def line_payload(number: int | None, text: str, kind: str, virtual: bool = False) -> dict[str, Any]:
    return {"number": number, "text": text, "kind": kind, "virtual": virtual}


def build_full_lines(repo: Path, rel_path: str, status: FileStatus | None) -> tuple[list[dict[str, Any]], bool]:
    if status and status.category == "deleted":
        lines, binary = read_head_text(repo, rel_path)
        return [line_payload(index + 1, line, "deleted") for index, line in enumerate(lines)], binary

    current_lines, binary = read_text_file(repo, rel_path)
    if binary:
        return [], True

    if status and status.category == "new" and is_probably_untracked(repo, rel_path):
        return [line_payload(index + 1, line, "added") for index, line in enumerate(current_lines)], False

    diff_text = unified_diff_for_file(repo, rel_path, status, context=0)
    hunks = parse_patch_hunks(diff_text)
    output: list[dict[str, Any]] = []
    pointer = 1

    for hunk in hunks:
        target = max(hunk["newStart"], 1)
        while pointer < target and pointer <= len(current_lines):
            output.append(line_payload(pointer, current_lines[pointer - 1], "context"))
            pointer += 1

        group: list[dict[str, str]] = []

        def flush_group() -> None:
            nonlocal pointer, group
            if not group:
                return
            deletions = [line for line in group if line["type"] == "-"]
            additions = [line for line in group if line["type"] == "+"]
            has_replacement = bool(deletions and additions)
            for line in deletions:
                output.append(line_payload(None, line["text"], "deleted", virtual=True))
            for line in additions:
                kind = "modified" if has_replacement else "added"
                number = pointer if pointer <= len(current_lines) else None
                output.append(line_payload(number, line["text"], kind))
                pointer += 1
            group = []

        for line in hunk["lines"]:
            if line["type"] == " ":
                flush_group()
                if pointer <= len(current_lines):
                    output.append(line_payload(pointer, current_lines[pointer - 1], "context"))
                    pointer += 1
            else:
                group.append(line)
        flush_group()

    while pointer <= len(current_lines):
        output.append(line_payload(pointer, current_lines[pointer - 1], "context"))
        pointer += 1

    return output, False


def editor_text_from_lines(lines: list[dict[str, Any]]) -> str:
    return "\n".join(line["text"] for line in lines)


def language_for_path(rel_path: str) -> str:
    suffix = Path(rel_path).suffix.lower()
    if suffix in LANGUAGE_BY_EXTENSION:
        return LANGUAGE_BY_EXTENSION[suffix]
    if Path(rel_path).name in {"Dockerfile", "Containerfile"}:
        return "dockerfile"
    return "plaintext"


def file_payload(repo: Path, raw_path: str) -> dict[str, Any]:
    rel_path = normalize_repo_path(raw_path)
    status = get_status_for_path(repo, rel_path)
    if status is None and not path_on_disk(repo, rel_path).is_file():
        raise NotFoundError(f"{rel_path} was not found.")

    diff_text = unified_diff_for_file(repo, rel_path, status, context=3)
    full_lines, binary = build_full_lines(repo, rel_path, status)
    original_content, original_binary = read_head_text_blob(repo, rel_path)

    if status and status.category == "deleted":
        current_content = ""
    elif binary:
        current_content = ""
    else:
        current_content, _ = read_text_blob(repo, rel_path)

    return {
        "path": rel_path,
        "status": status.__dict__ if status else {"category": "clean", "label": "Clean", "xy": "  "},
        "binary": binary or original_binary,
        "language": language_for_path(rel_path),
        "fullLines": full_lines,
        "reviewContent": "" if binary else editor_text_from_lines(full_lines),
        "currentContent": current_content,
        "originalContent": "" if original_binary else original_content,
        "diff": diff_text,
    }


def tmux_command(*args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    if shutil.which("tmux") is None:
        raise DashboardError("tmux is not installed or not available on PATH.")
    return subprocess.run(
        ["tmux", *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=check,
    )


def validate_session_name(name: str) -> str:
    name = name.strip()
    if not SESSION_NAME_RE.fullmatch(name):
        raise DashboardError("Session name must be 1-80 characters: letters, numbers, _, ., :, or -.")
    return name


def list_tmux_sessions() -> list[dict[str, Any]]:
    proc = tmux_command(
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}",
        check=False,
    )
    if proc.returncode != 0:
        stderr = decode_git(proc.stderr).lower()
        if "no server running" in stderr:
            return []
        raise DashboardError(decode_git(proc.stderr).strip() or "Unable to list tmux sessions.")

    sessions = []
    for line in decode_git(proc.stdout).splitlines():
        parts = line.split("\t")
        if len(parts) != 4:
            continue
        name, windows, attached, created = parts
        sessions.append(
            {
                "name": name,
                "windows": int(windows or "0"),
                "attached": int(attached or "0"),
                "created": int(created or "0"),
            }
        )
    return sorted(sessions, key=lambda item: item["name"].lower())


def create_tmux_session(name: str) -> dict[str, Any]:
    session_name = validate_session_name(name)
    proc = tmux_command("new-session", "-d", "-s", session_name, check=False)
    if proc.returncode != 0:
        message = decode_git(proc.stderr).strip() or f"Unable to create tmux session {session_name}."
        raise DashboardError(message)
    for session in list_tmux_sessions():
        if session["name"] == session_name:
            return session
    return {"name": session_name, "windows": 1, "attached": 0, "created": 0}


def send_tmux_navigation(session_name: str, action: str, count: int = 5) -> None:
    session = validate_session_name(session_name)
    count = max(1, min(int(count), 200))
    if action == "live":
        tmux_command("send-keys", "-t", session, "-X", "cancel", check=False)
        return
    command_by_action = {
        "scroll-up": "scroll-up",
        "scroll-down": "scroll-down",
        "page-up": "page-up",
        "page-down": "page-down",
    }
    command = command_by_action.get(action)
    if command is None:
        return
    tmux_command("copy-mode", "-t", session, check=False)
    if action.startswith("page-"):
        tmux_command("send-keys", "-t", session, "-X", command, check=False)
    else:
        tmux_command("send-keys", "-t", session, "-X", "-N", str(count), command, check=False)


def tmux_option(session_name: str, option: str) -> str | None:
    session = validate_session_name(session_name)
    if option == "status":
        proc = tmux_command("display-message", "-p", "-t", session, "#{status}", check=False)
        if proc.returncode == 0:
            return decode_git(proc.stdout).strip()
    proc = tmux_command("show-options", "-qv", "-t", session, option, check=False)
    if proc.returncode != 0:
        return None
    return decode_git(proc.stdout).strip()


def set_tmux_option(session_name: str, option: str, value: str) -> None:
    session = validate_session_name(session_name)
    tmux_command("set-option", "-q", "-t", session, option, value, check=False)


def token_is_valid(request: Request, token: str) -> bool:
    supplied = request.query_params.get("token") or request.cookies.get(TOKEN_COOKIE)
    return bool(supplied and secrets.compare_digest(supplied, token))


def websocket_token_is_valid(websocket: WebSocket, token: str) -> bool:
    supplied = websocket.query_params.get("token") or websocket.cookies.get(TOKEN_COOKIE)
    return bool(supplied and secrets.compare_digest(supplied, token))


def unauthorized_response() -> HTMLResponse:
    return HTMLResponse(
        """
        <!doctype html>
        <html lang="en">
          <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unauthorized</title></head>
          <body style="margin:0;background:#1e1e1e;color:#d4d4d4;font-family:system-ui;display:grid;min-height:100vh;place-items:center">
            <main style="max-width:30rem;padding:1.5rem">
              <h1 style="font-size:1.25rem">Unauthorized</h1>
              <p>Open the dashboard with the tokenized URL printed at startup.</p>
            </main>
          </body>
        </html>
        """,
        status_code=HTTPStatus.UNAUTHORIZED,
    )


def set_winsize(fd: int, rows: int, cols: int) -> None:
    rows = max(1, min(rows, 200))
    cols = max(1, min(cols, 400))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def refresh_tmux_client_size(client_name: str, rows: int, cols: int) -> None:
    rows = max(1, min(rows, 200))
    cols = max(1, min(cols, 400))
    tmux_command("refresh-client", "-t", client_name, "-C", f"{cols}x{rows}", check=False)


async def tmux_attach_socket(websocket: WebSocket, session_name: str, rows: int, cols: int) -> None:
    session = validate_session_name(session_name)
    send_tmux_navigation(session, "live")
    previous_status = tmux_option(session, "status")
    set_tmux_option(session, "status", "off")
    master_fd, slave_fd = pty.openpty()
    slave_name = os.ttyname(slave_fd)
    set_winsize(master_fd, rows, cols)

    def prepare_child_terminal() -> None:
        os.setsid()
        with contextlib.suppress(OSError):
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

    env = {**os.environ, "TERM": "xterm-256color"}
    proc = subprocess.Popen(
        ["tmux", "attach-session", "-t", session],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        env=env,
        preexec_fn=prepare_child_terminal,
    )
    os.close(slave_fd)
    os.set_blocking(master_fd, False)
    refresh_tmux_client_size(slave_name, rows, cols)

    loop = asyncio.get_running_loop()
    output_queue: asyncio.Queue[bytes | None] = asyncio.Queue()

    def read_pty() -> None:
        try:
            while True:
                try:
                    data = os.read(master_fd, 8192)
                except BlockingIOError:
                    break
                if not data:
                    output_queue.put_nowait(None)
                    break
                output_queue.put_nowait(data)
        except OSError:
            output_queue.put_nowait(None)

    loop.add_reader(master_fd, read_pty)

    async def send_output() -> None:
        while True:
            data = await output_queue.get()
            if data is None:
                break
            await websocket.send_text(data.decode("utf-8", "replace"))

    async def receive_input() -> None:
        while True:
            payload = await websocket.receive_json()
            message_type = payload.get("type")
            if message_type == "input":
                send_tmux_navigation(session, "live")
                os.write(master_fd, str(payload.get("data", "")).encode("utf-8", "replace"))
            elif message_type == "tmux":
                send_tmux_navigation(session, str(payload.get("action", "")), int(payload.get("count", 5)))
            elif message_type == "resize":
                next_rows = int(payload.get("rows", 30))
                next_cols = int(payload.get("cols", 100))
                set_winsize(master_fd, next_rows, next_cols)
                refresh_tmux_client_size(slave_name, next_rows, next_cols)

    output_task = asyncio.create_task(send_output())
    input_task = asyncio.create_task(receive_input())
    try:
        done, pending = await asyncio.wait({output_task, input_task}, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                raise exc
        for task in pending:
            task.cancel()
    finally:
        loop.remove_reader(master_fd)
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGHUP)
        if previous_status in {"on", "off", "2", "3", "4", "5"}:
            set_tmux_option(session, "status", previous_status)
        with contextlib.suppress(OSError):
            os.close(master_fd)
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=1)


def create_app(repo: Path, token: str) -> FastAPI:
    app = FastAPI()
    static_dir = Path(str(resources.files("git_review_dashboard").joinpath("static")))

    @app.middleware("http")
    async def require_token(request: Request, call_next: Any) -> Response:
        if not token_is_valid(request, token):
            if request.url.path.startswith("/api/"):
                return JSONResponse({"error": "Unauthorized"}, status_code=HTTPStatus.UNAUTHORIZED)
            return unauthorized_response()
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        if request.query_params.get("token") == token:
            response.set_cookie(TOKEN_COOKIE, token, httponly=True, samesite="lax")
        return response

    @app.exception_handler(DashboardError)
    async def dashboard_error_handler(_: Request, exc: DashboardError) -> JSONResponse:
        return JSONResponse({"error": str(exc)}, status_code=exc.status)

    @app.get("/api/state")
    async def api_state() -> dict[str, Any]:
        return repo_state(repo)

    @app.get("/api/file")
    async def api_file(path: str) -> dict[str, Any]:
        return file_payload(repo, path)

    @app.get("/api/tmux/sessions")
    async def api_tmux_sessions() -> dict[str, Any]:
        return {"sessions": list_tmux_sessions()}

    @app.post("/api/tmux/sessions")
    async def api_create_tmux_session(request: Request) -> dict[str, Any]:
        payload = await request.json()
        session = create_tmux_session(str(payload.get("name", "")))
        return {"session": session, "sessions": list_tmux_sessions()}

    @app.websocket("/api/tmux/attach")
    async def api_tmux_attach(websocket: WebSocket) -> None:
        if not websocket_token_is_valid(websocket, token):
            await websocket.close(code=1008)
            return
        session = websocket.query_params.get("session")
        if not session:
            await websocket.close(code=1008)
            return
        rows = int(websocket.query_params.get("rows", 30))
        cols = int(websocket.query_params.get("cols", 80))
        await websocket.accept()
        await tmux_attach_socket(websocket, session, rows, cols)

    @app.get("/{asset_path:path}")
    async def static_asset(asset_path: str) -> FileResponse:
        target = (static_dir / (asset_path or "index.html")).resolve()
        try:
            target.relative_to(static_dir.resolve())
        except ValueError as exc:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND) from exc
        if target.is_file():
            return FileResponse(target, headers={"Cache-Control": "no-store"})
        return FileResponse(static_dir / "index.html", headers={"Cache-Control": "no-store"})

    return app


def candidate_urls(host: str, port: int) -> list[str]:
    urls: list[str] = []
    display_host = "127.0.0.1" if host in ("", "0.0.0.0", "::") else host
    urls.append(f"http://{format_url_host(display_host)}:{port}")
    if host in ("", "0.0.0.0", "::"):
        for address in private_addresses():
            url = f"http://{format_url_host(address)}:{port}"
            if url not in urls:
                urls.append(url)
    return urls


def format_url_host(host: str) -> str:
    if ":" in host and not host.startswith("["):
        return f"[{host}]"
    return host


def private_addresses() -> list[str]:
    addresses: set[str] = set()
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_DGRAM)) as sock:
        try:
            sock.connect(("8.8.8.8", 80))
            addresses.add(sock.getsockname()[0])
        except OSError:
            pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addresses.add(info[4][0])
    except OSError:
        pass
    with contextlib.suppress(OSError, subprocess.SubprocessError):
        proc = subprocess.run(["hostname", "-I"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
        addresses.update(address.split("%", 1)[0] for address in decode_git(proc.stdout).split())

    filtered = []
    for address in addresses:
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            continue
        if parsed.is_loopback or parsed.is_link_local or parsed.is_unspecified:
            continue
        filtered.append(address)
    return sorted(filtered)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve a read-only mobile Git changes review dashboard.")
    parser.add_argument("--repo", default=os.getcwd(), help="Path inside the Git repository to inspect.")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"Host/interface to bind, default {DEFAULT_HOST}.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Port to bind, default {DEFAULT_PORT}.")
    parser.add_argument("--no-open", action="store_true", help="Do not open a local browser.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        repo = detect_repo(Path(args.repo).resolve())
    except DashboardError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    token = secrets.token_urlsafe(32)
    urls = [f"{url}/?token={quote(token)}" for url in candidate_urls(args.host, args.port)]
    app = create_app(repo, token)

    print(f"Repository: {repo}", flush=True)
    print("Serving dashboard:", flush=True)
    for url in urls:
        print(f"  {url}", flush=True)
    print("Press Ctrl+C to stop.", flush=True)

    if not args.no_open and urls:
        webbrowser.open(urls[0])

    try:
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    except KeyboardInterrupt:
        print("\nStopping.")
    return 0
