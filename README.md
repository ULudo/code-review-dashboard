# Code Review Dashboard

A small read-only web dashboard for reviewing uncommitted Git changes from a phone or tablet.

## Install

From this directory:

```bash
pip install .
```

For isolated global use:

```bash
pipx install .
```

## Run

Launch it from any folder inside a Git repository:

```bash
git-review-dashboard --host 0.0.0.0 --port 8765
```

Then open `http://<machine-ip>:8765` from another device on the same private network or VPN.

The app is strictly read-only. It reads files and runs read-only Git commands such as `git status`, `git diff`, `git show`, and `git rev-parse`.

## Options

```bash
git-review-dashboard --help
```

- `--repo PATH`: repository or subdirectory to inspect, defaults to the current directory.
- `--host HOST`: bind host, defaults to `0.0.0.0`.
- `--port PORT`: bind port, defaults to `8765`.
- `--no-open`: do not open a local browser automatically.
