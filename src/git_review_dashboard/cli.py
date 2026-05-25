from __future__ import annotations

import argparse
import contextlib
import difflib
import json
import os
import posixpath
import re
import socket
import subprocess
import sys
import threading
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8765
TEXT_LIMIT_BYTES = 1_500_000


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


def repo_state(repo: Path) -> dict[str, Any]:
    files = parse_status(repo)
    return {
        "repo": str(repo),
        "branch": current_branch(repo),
        "hasHead": has_head(repo),
        "counts": {
            "changed": sum(1 for item in files if item.category == "modified"),
            "new": sum(1 for item in files if item.category == "new"),
            "deleted": sum(1 for item in files if item.category == "deleted"),
            "total": len(files),
        },
        "files": [item.__dict__ for item in files],
    }


def read_text_file(repo: Path, rel_path: str) -> tuple[list[str], bool]:
    disk_path = path_on_disk(repo, rel_path)
    try:
        data = disk_path.read_bytes()
    except FileNotFoundError as exc:
        raise NotFoundError(f"{rel_path} does not exist in the working tree.") from exc
    if b"\x00" in data:
        return [], True
    if len(data) > TEXT_LIMIT_BYTES:
        raise DashboardError(f"{rel_path} is larger than the {TEXT_LIMIT_BYTES} byte display limit.")
    return data.decode("utf-8", "replace").splitlines(), False


def read_head_text(repo: Path, rel_path: str) -> tuple[list[str], bool]:
    proc = run_git(repo, "show", f"HEAD:{rel_path}", check=False)
    if proc.returncode != 0:
        return [], False
    data = proc.stdout
    if b"\x00" in data:
        return [], True
    return data.decode("utf-8", "replace").splitlines(), False


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


def file_payload(repo: Path, raw_path: str) -> dict[str, Any]:
    rel_path = normalize_repo_path(raw_path)
    status = get_status_for_path(repo, rel_path)
    if status is None and not path_on_disk(repo, rel_path).is_file():
        raise NotFoundError(f"{rel_path} was not found.")

    diff_text = unified_diff_for_file(repo, rel_path, status, context=3)
    full_lines, binary = build_full_lines(repo, rel_path, status)
    return {
        "path": rel_path,
        "status": status.__dict__ if status else {"category": "clean", "label": "Clean", "xy": "  "},
        "binary": binary,
        "fullLines": full_lines,
        "diff": diff_text,
    }


class DashboardHandler(SimpleHTTPRequestHandler):
    server: "DashboardServer"

    def __init__(self, *args: Any, directory: str | None = None, **kwargs: Any) -> None:
        static_dir = resources.files("git_review_dashboard").joinpath("static")
        super().__init__(*args, directory=str(static_dir), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), format % args))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/state":
                self.send_json(repo_state(self.server.repo))
            elif parsed.path == "/api/file":
                query = parse_qs(parsed.query)
                paths = query.get("path") or []
                if not paths:
                    raise DashboardError("Missing path.")
                self.send_json(file_payload(self.server.repo, paths[0]))
            elif parsed.path.startswith("/api/"):
                raise NotFoundError("API route not found.")
            else:
                if parsed.path == "/":
                    self.path = "/index.html"
                super().do_GET()
        except DashboardError as exc:
            self.send_json({"error": str(exc)}, status=exc.status)
        except Exception as exc:
            self.send_json({"error": str(exc)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class DashboardServer(ThreadingHTTPServer):
    def __init__(self, server_address: tuple[str, int], repo: Path) -> None:
        self.repo = repo
        super().__init__(server_address, DashboardHandler)


def candidate_urls(host: str, port: int) -> list[str]:
    urls: list[str] = []
    display_host = "127.0.0.1" if host in ("", "0.0.0.0", "::") else host
    urls.append(f"http://{display_host}:{port}")
    if host in ("", "0.0.0.0", "::"):
        for address in private_addresses():
            url = f"http://{address}:{port}"
            if url not in urls:
                urls.append(url)
    return urls


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
    return sorted(address for address in addresses if not address.startswith("127."))


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

    server = DashboardServer((args.host, args.port), repo)
    port = server.server_address[1]
    urls = candidate_urls(args.host, port)

    print(f"Repository: {repo}")
    print("Serving read-only dashboard:")
    for url in urls:
        print(f"  {url}")
    print("Press Ctrl+C to stop.")

    if not args.no_open and urls:
        threading.Timer(0.25, lambda: webbrowser.open(urls[0])).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        server.server_close()
    return 0
