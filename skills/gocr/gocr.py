#!/usr/bin/env python3
"""GOCR anchor tool (v2 grammar).

Two artifact modes, one evidence grammar:
  change:  alpha (before sha) -> delta (derived diff) -> omega (after sha)
           gate: every changed line of the delta claimed
  explore: omega (one pinned sha) + scope (path filter pipeline)
           gate: every scope file cited by at least one claim

Evidence is source:selection recipes:
  at: alpha:<path>:<a>-<b>     file lines in the before-universe
  at: omega:<path>:<a>-<b>     file lines in the after-universe
  at: delta:<a>-<b>            lines of the delta (change mode only)
  grep: <pattern> | [<pattern>, "!<pattern>", ...]   with  in: alpha|omega|delta

Greps are NOT globs and do not run against file contents directly.
Each pattern is a Python regex tested against rendered strings, one per
source line, with the path glued onto the front - alpha/omega:
"path:lineno:content", delta: "path:<+/- content>". A ^-anchored
pattern therefore filters by path ("^site/"), an unanchored one by
content, one pattern can do both. Keeps apply in order; a leading !
drops matches; "*" or "" means match-all.

Recipes, never results: the delta is derived live from `git diff alpha
omega` (an explicit `delta: <file>` in the change block overrides, for
repo-less review of a fetched .diff); alpha/omega resolve via
`git show`/`git grep` at the pinned shas. Run from the repo root.

Commands:
  gocr.py coverage <review.yaml>          the gate (mode-aware)
  gocr.py resolve  <review.yaml> <sel>    print what a selection names
  gocr.py resolve  <review.yaml> <claim>  resolve every evidence entry of a claim
  gocr.py stats    <review.yaml>          per-claim mechanical signals
  gocr.py files    <diff-path-or-url | review.yaml>   per-file shape of the delta
"""

import os
import re
import subprocess
import sys
import urllib.request


def _read(path_or_url: str) -> str:
    if path_or_url.startswith(("http://", "https://")):
        with urllib.request.urlopen(path_or_url) as resp:
            return resp.read().decode("utf-8", "replace")
    return open(path_or_url).read()


def _git(*args: str) -> str:
    proc = subprocess.run(["git", *args], capture_output=True, text=True)
    if proc.returncode not in (0, 1):
        sys.exit(f"git {args[0]} failed (run from the repo root): "
                 + proc.stderr.strip()[:200])
    return proc.stdout


# ── artifact metadata ───────────────────────────────────────────────

# The problem is every command takes only the yaml, so the tool must
# learn the mode, pinned shas and scope from the artifact itself.
# The way we solve this is a narrow regex read of the header block - the
# format is ours, so a yaml library dependency isn't worth it.
def yaml_meta(review_text: str, yaml_dir: str) -> dict:
    def field(name):
        m = re.search(rf"^\s*{name}:\s*[\"']?([^\s\"']+)", review_text, re.M)
        return m.group(1) if m else None

    scope, collecting = [], False
    for line in review_text.splitlines():
        if re.match(r"\s*scope:\s*$", line):
            collecting = True
            continue
        if collecting:
            m = re.match(r"\s*-\s*(.+?)\s*$", line)
            if m:
                scope.append(_clean(m.group(1)))
            elif line.strip():
                collecting = False

    delta = field("delta")
    return {
        "mode": "explore" if re.search(r"^explore:", review_text, re.M) else "change",
        "alpha": field("alpha"),
        "omega": field("omega"),
        "delta": os.path.join(yaml_dir, delta) if delta else None,
        "scope": scope,
    }


# The delta is a derived view: an explicitly pinned file wins, otherwise
# it comes live from git at the pinned shas.
def delta_text(meta: dict) -> str:
    if meta["delta"]:
        return _read(meta["delta"])
    if meta["alpha"] and meta["omega"]:
        return _git("diff", meta["alpha"], meta["omega"])
    sys.exit("change block needs alpha+omega (or an explicit delta: file)")


# Every +/- line of the delta, keyed by its 1-indexed line number - the
# change-mode coverage obligation set.
def change_lines(diff_text: str) -> list[tuple[int, str, str]]:
    out, path, in_hunk = [], None, False
    for i, line in enumerate(diff_text.splitlines(), 1):
        if line.startswith("diff --git"):
            path = line.split(" b/", 1)[-1]
            in_hunk = False
        elif line.startswith("@@"):
            in_hunk = True
        elif in_hunk and line[:1] in ("+", "-"):
            out.append((i, path or "?", line))
    return out


# ── evidence extraction ─────────────────────────────────────────────

SEL = re.compile(r"^(alpha|omega|delta):(?:(.+):)?(\d+)-(\d+)$")
_UNQUOTE = re.compile(r"""^\s*(['"]?)(.*)\1\s*$""")


def _clean(pattern: str) -> str:
    m = _UNQUOTE.match(pattern)
    return m.group(2) if m else pattern


# The problem is evidence entries live inside claims and greps span
# several yaml lines (scalar or pipeline list, then `in:`).
# The way we solve this is a line scan attributing each `at:`/`grep:`
# entry to the claim id above it and collecting pipeline items until the
# `in:` line closes the grep.
def evidence(review_text: str) -> list[dict]:
    entries, cur, grep, note_for = [], None, None, None
    skip_indent = None
    for line in review_text.splitlines():
        # comments blocks reuse the at: syntax as anchors - they are
        # reviewer testimony, never evidence, and must not touch coverage
        if skip_indent is not None:
            if not line.strip() or len(line) - len(line.lstrip()) > skip_indent:
                continue
            skip_indent = None
        m = re.match(r"^(\s*)comments:\s*$", line)
        if m:
            skip_indent = len(m.group(1))
            continue
        m = re.match(r"\s*-\s+id:\s*(\S+)\s*$", line)
        if m:
            cur, grep, note_for = m.group(1), None, None
            continue
        m = re.match(r"\s*-\s*at:\s*[\"']?(\S+?)[\"']?\s*$", line)
        if m:
            entries.append({"claim": cur, "kind": "at", "raw": m.group(1),
                            "sel": SEL.match(m.group(1)), "note": ""})
            grep, note_for = None, entries[-1]
            continue
        m = re.match(r"\s*-\s*grep:\s*(.*?)\s*$", line)
        if m:
            grep = {"claim": cur, "kind": "grep", "pipeline": [], "in": None,
                    "note": ""}
            if m.group(1):
                grep["pipeline"].append(_clean(m.group(1)))
            entries.append(grep)
            note_for = grep
            continue
        m = re.match(r"(\s*)note:\s*(.*?)\s*$", line)
        if m and note_for is not None:
            val = m.group(2)
            note_for["note"] = "" if val in (">", ">-", "|") else _clean(val)
            # block note: remember the key's indent so a dedented line
            # (open_questions:, the next claim, ...) closes the block —
            # an open-ended scan swallows whatever section follows
            note_for["_noting"] = len(m.group(1)) if val in (">", ">-", "|") \
                else None
            continue
        if note_for is not None and note_for.get("_noting") is not None \
                and line.strip():
            if len(line) - len(line.lstrip()) > note_for["_noting"]:
                note_for["note"] = (note_for["note"] + " "
                                    + line.strip()).strip()
                continue
            note_for["_noting"] = None  # dedent closes; fall through
        if grep is not None:
            m = re.match(r"\s*-\s*(.+?)\s*$", line)
            if m and not re.match(r"\s*-\s*(at|grep|id|note):", line):
                grep["pipeline"].append(_clean(m.group(1)))
                continue
            m = re.match(r"\s*in:\s*(alpha|omega|delta)\s*$", line)
            if m:
                grep["in"] = m.group(1)
                grep = None
    return entries


# The problem is one selection mechanism must cover matching, negation
# and path scoping without becoming a shell.
# The way we solve this is an ordered filter pipeline over rendered
# "path:content" lines: start from everything, each pattern keeps its
# matches, a leading ! drops them. Regex is the whole pattern language.
def apply_pipeline(pipeline: list[str], lines: list[tuple]) -> list[tuple]:
    cur = lines
    for pat in pipeline:
        neg = pat.startswith("!")
        body = pat[1:] if neg else pat
        if body in ("*", ""):
            rx = re.compile("")
        else:
            try:
                rx = re.compile(body)
            except re.error:
                rx = re.compile(re.escape(body))
        cur = [l for l in cur if bool(rx.search(l[-1])) != neg]
    return cur


def _delta_stream(changed: list[tuple[int, str, str]]) -> list[tuple]:
    return [(ln, f"{path}:{text}") for ln, path, text in changed]


# All lines of a pinned universe as (path, "path:lineno:content").
def _universe_stream(sha: str) -> list[tuple]:
    out, prefix = [], sha + ":"
    for line in _git("grep", "-nI", "-e", "", sha).splitlines():
        if line.startswith(prefix):
            rendered = line[len(prefix):]
            out.append((rendered.split(":", 1)[0], rendered))
    return out


# ── coverage ────────────────────────────────────────────────────────

# The problem is a curated review can silently skip parts of the change -
# whatever no claim covers is exactly what nobody will read.
# The way we solve this is line arithmetic over the derived delta:
# ranges and delta-grep pipelines claim changed lines, the leftovers
# print loudly with a nonzero exit. alpha/omega evidence never gates.
# flow: CLI `gocr.py coverage <review.yaml>` (change mode) -> coverage_change_data() <-- HERE
# flow: report `GET /api/artifact` -> artifact_data() -> coverage_change_data() <-- HERE
def coverage_change_data(meta: dict, text: str) -> dict:
    changed = change_lines(delta_text(meta))
    total = {ln for ln, _, _ in changed}

    claimed, stale = set(), []
    for e in evidence(text):
        if e["kind"] == "at":
            if e["sel"] is None:
                stale.append(f"at: {e['raw']} (unparseable)")
                continue
            src, _, a, b = e["sel"].groups()
            if src != "delta":
                continue
            span = set(range(int(a), int(b) + 1)) & total
            if not span:
                stale.append(f"at: {e['raw']} (no changed lines in range)")
            claimed |= span
        elif e["in"] == "delta":
            hits = {ln for ln, _ in
                    apply_pipeline(e["pipeline"], _delta_stream(changed))}
            if not hits:
                stale.append(f"grep: {' | '.join(e['pipeline'])} (selects nothing in delta)")
            claimed |= hits

    residual = [(ln, f, t) for ln, f, t in changed if ln not in claimed]
    return {"unit": "changed lines claimed", "total": len(total),
            "claimed": len(total) - len(residual),
            "residual": residual, "stale": list(dict.fromkeys(stale))}


def coverage_change(meta: dict, text: str) -> None:
    d = coverage_change_data(meta, text)
    print(f"coverage: {d['claimed']}/{d['total']} {d['unit']}")
    prev = None
    for ln, f, t in d["residual"]:
        if prev is None or ln != prev + 1:
            print(f"  UNCLAIMED delta:{ln}-  {f}  {t[:70]}")
        prev = ln
    for s in d["stale"]:
        print(f"  STALE {s}")
    sys.exit(1 if d["residual"] or d["stale"] else 0)


# The problem is an exploration promises to map a territory, and a lazy
# map can quietly skip the files it never visited.
# The way we solve this is file arithmetic over the declared scope:
# every file the scope pipeline selects at omega must be cited by an
# omega range or hit by an omega grep. Breadth proof, not depth.
# flow: CLI `gocr.py coverage <review.yaml>` (explore mode) -> coverage_explore_data() <-- HERE
# flow: report `GET /api/artifact` -> artifact_data() -> coverage_explore_data() <-- HERE
def coverage_explore_data(meta: dict, text: str) -> dict:
    if not meta["omega"]:
        sys.exit("explore block needs omega")
    if not meta["scope"]:
        sys.exit("explore block needs a scope")
    tree = [(p, p) for p in
            _git("ls-tree", "-r", "--name-only", meta["omega"]).splitlines()]
    territory = {p for p, _ in apply_pipeline(meta["scope"], tree)}

    stream = None
    cited, stale = set(), []
    for e in evidence(text):
        if e["kind"] == "at":
            if e["sel"] is None or e["sel"].group(1) != "omega":
                stale.append(f"at: {e['raw']} (explore evidence must be omega)")
                continue
            cited.add(e["sel"].group(2))
        elif e["in"] == "omega":
            if stream is None:
                stream = _universe_stream(meta["omega"])
            hits = apply_pipeline(e["pipeline"], stream)
            if not hits:
                stale.append(f"grep: {' | '.join(e['pipeline'])} (selects nothing in omega)")
            cited |= {p for p, _ in hits}
        else:
            stale.append(f"grep: {' | '.join(e['pipeline'])} (in: {e['in']} - explore has only omega)")

    residual = sorted(territory - cited)
    return {"unit": "scope files cited", "total": len(territory),
            "claimed": len(territory) - len(residual),
            "residual": residual, "stale": list(dict.fromkeys(stale))}


def coverage_explore(meta: dict, text: str) -> None:
    d = coverage_explore_data(meta, text)
    print(f"coverage: {d['claimed']}/{d['total']} {d['unit']}")
    for p in d["residual"][:50]:
        print(f"  UNVISITED {p}")
    if len(d["residual"]) > 50:
        print(f"  ... {len(d['residual']) - 50} more")
    for s in d["stale"]:
        print(f"  STALE {s}")
    sys.exit(1 if d["residual"] or d["stale"] else 0)


# flow: CLI `gocr.py coverage <review.yaml>` -> coverage() <-- HERE
def coverage(yaml_path: str) -> None:
    text = _read(yaml_path)
    meta = yaml_meta(text, os.path.dirname(yaml_path) or ".")
    if meta["mode"] == "explore":
        coverage_explore(meta, text)
    else:
        coverage_change(meta, text)


# ── resolve ─────────────────────────────────────────────────────────

def _print_capped(rows: list[str], cap: int = 100) -> None:
    for row in rows[:cap]:
        print(row)
    if len(rows) > cap:
        print(f"  ... {len(rows) - cap} more")


# The problem is evidence must lead a reader back to real text - delta
# lines, file lines and grep results - with recipes, not cached results.
# The way we solve this is resolving live: the delta derived (or pinned),
# alpha/omega via git show / git grep at the pinned sha. Passing a claim
# id resolves every evidence entry of that claim.
# flow: CLI `gocr.py resolve <review.yaml> <sel-or-claim>` -> resolve() <-- HERE
# flow: CLI resolve + report `GET /api/resolve` -> resolve_at_data() <-- HERE
def resolve_at_data(meta: dict, raw: str) -> dict:
    m = SEL.match(raw)
    if not m:
        raise ValueError(f"bad selection {raw!r}")
    src, path, a, b = m.groups()
    a, b = int(a), int(b)
    drift = None
    ide = None
    if src == "delta":
        lines = delta_text(meta).splitlines()
        anchors = [f"delta:{i}-{i}" for i in range(a, min(b, len(lines)) + 1)]
        # Understand: a delta line still lives in a file — walk the diff
        # headers so each selected row knows [path, omega lineno] (None
        # lineno for removed/meta rows), which feeds the IDE link and the
        # highlighter's language guess.
        ide = []
        path_now, new_ln, cur = None, 0, None
        for idx, l in enumerate(lines, 1):
            if idx > min(b, len(lines)):
                break
            if l.startswith("+++ "):
                p = l[4:].strip()
                path_now = None if p == "/dev/null" else \
                    (p[2:] if p.startswith("b/") else p)
                cur = None
            elif l.startswith(("diff ", "index ", "--- ", "\\")):
                cur = None
            elif l.startswith("@@"):
                m2 = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)", l)
                new_ln = int(m2.group(1)) - 1 if m2 else 0
                cur = None
            elif l.startswith("+"):
                new_ln += 1
                cur = new_ln
            elif l.startswith("-"):
                cur = None
            else:  # context line
                new_ln += 1
                cur = new_ln
            if idx >= a:
                ide.append([path_now, cur] if path_now else None)
    else:
        sha = meta[src]
        if not sha or not path:
            raise ValueError(f"{src}: sha missing from header or path missing")
        proc = subprocess.run(["git", "show", f"{sha}:{path}"],
                              capture_output=True, text=True)
        if proc.returncode:
            raise ValueError(f"git show {sha}:{path} failed (run from the repo "
                             "root): " + proc.stderr.strip()[:200])
        lines = proc.stdout.splitlines()
        anchors = [f"{src}:{path}:{i}-{i}"
                   for i in range(a, min(b, len(lines)) + 1)]
        if src == "omega":
            try:
                drift = _read(path) != proc.stdout
            except OSError:
                drift = True
    return {"kind": "at", "raw": raw, "src": src, "path": path, "start": a,
            "lines": [[i, l] for i, l in enumerate(lines[a - 1:b], a)],
            "anchors": anchors, "drift": drift, "ide": ide}


# flow: CLI resolve + report `GET /api/resolve` -> resolve_grep_data() <-- HERE
def resolve_grep_data(meta: dict, pipeline: list[str], src: str) -> dict:
    if src == "delta":
        stream = _delta_stream(change_lines(delta_text(meta)))
        hits = apply_pipeline(pipeline, stream)
        rows = [{"anchor": f"delta:{ln}-{ln}", "text": r} for ln, r in hits]
    else:
        sha = meta[src]
        if not sha:
            raise ValueError(f"{src}: sha missing from header")
        hits = apply_pipeline(pipeline, _universe_stream(sha))
        rows = []
        for _, r in hits:
            parts = r.split(":", 2)
            anchor = (f"{src}:{parts[0]}:{parts[1]}-{parts[1]}"
                      if len(parts) == 3 and parts[1].isdigit() else None)
            rows.append({"anchor": anchor, "text": r})
    return {"kind": "grep", "pipeline": pipeline, "in": src,
            "count": len(rows), "hits": rows}


def resolve(yaml_path: str, target: str) -> None:
    text = _read(yaml_path)
    meta = yaml_meta(text, os.path.dirname(yaml_path) or ".")

    def show(e):
        try:
            if e["kind"] == "at":
                d = resolve_at_data(meta, e["raw"])
                print(f"-- at: {d['raw']}")
                _print_capped([f"{i:6d}  {l}" for i, l in d["lines"]])
            else:
                d = resolve_grep_data(meta, e["pipeline"], e["in"])
                print(f"-- grep: {' | '.join(d['pipeline'])}  in: {d['in']}")
                print(f"   {d['count']} line(s) selected")
                _print_capped([f"   {h['text']}" for h in d["hits"]])
        except ValueError as err:
            sys.exit(str(err))

    if SEL.match(target):
        show({"kind": "at", "raw": target})
        return
    mine = [e for e in evidence(text) if e["claim"] == target]
    if not mine:
        sys.exit(f"{target!r} is neither a selection nor a claim id in {yaml_path}")
    for e in mine:
        show(e)


# ── stats ───────────────────────────────────────────────────────────

# The problem is walk order and attention triage need importance signals,
# but model-guessed scores are fake precision reviewers learn to ignore.
# The way we solve this is computing only recomputable numbers per claim
# and leaving the ordinal judgment to whoever reads the table. Stats are
# derived, never stored in the artifact.
# flow: CLI `gocr.py stats <review.yaml>` -> stats() <-- HERE
def stats(yaml_path: str) -> None:
    text = _read(yaml_path)
    meta = yaml_meta(text, os.path.dirname(yaml_path) or ".")
    explore = meta["mode"] == "explore"
    changed = [] if explore else change_lines(delta_text(meta))
    total = {ln for ln, _, _ in changed}
    stream = _universe_stream(meta["omega"]) if explore and meta["omega"] else None

    per: dict[str, dict] = {}
    for e in evidence(text):
        c = per.setdefault(e["claim"] or "?", {
            "delta": set(), "files": set(), "alpha": 0, "omega": 0, "greps": 0})
        if e["kind"] == "at" and e["sel"]:
            src, path, a, b = e["sel"].groups()
            if src == "delta":
                c["delta"] |= set(range(int(a), int(b) + 1)) & total
            else:
                c[src] += 1
                if path:
                    c["files"].add(path)
        elif e["kind"] == "grep":
            c["greps"] += 1
            if e.get("in") == "delta":
                c["delta"] |= {ln for ln, _ in
                               apply_pipeline(e["pipeline"], _delta_stream(changed))}
            elif e.get("in") == "omega" and stream is not None:
                c["files"] |= {p for p, _ in apply_pipeline(e["pipeline"], stream)}

    if explore:
        print(f"{'claim':6} {'files':>6} {'ranges':>7} {'greps':>6}")
        for cid, c in per.items():
            print(f"{cid:6} {len(c['files']):>6} {c['omega']:>7} {c['greps']:>6}")
        return
    print(f"{'claim':6} {'Δlines':>7} {'alpha':>6} {'omega':>6} {'greps':>6}")
    bare = []
    for cid, c in per.items():
        if not (c["greps"] or c["alpha"] or c["omega"]):
            bare.append(cid)
        print(f"{cid:6} {len(c['delta']):>7} {c['alpha']:>6} {c['omega']:>6} {c['greps']:>6}")
    if bare:
        print(f"delta-only evidence (no universe cites, no greps): {', '.join(bare)}")


# ── files ───────────────────────────────────────────────────────────

# The problem is authors need the shape of a change - which files, how
# much churn, where in the delta - before drafting claims.
# The way we solve this is per-file aggregation of changed lines with
# their delta line spans, so wholesale-claim candidates stand out.
# flow: CLI `gocr.py files <diff-or-yaml>` -> files() <-- HERE
def files(arg: str) -> None:
    if arg.endswith((".yaml", ".yml")):
        text = _read(arg)
        diff = delta_text(yaml_meta(text, os.path.dirname(arg) or "."))
    else:
        diff = _read(arg)
    changed = change_lines(diff)
    per: dict[str, list[int]] = {}
    for ln, path, _ in changed:
        per.setdefault(path, []).append(ln)
    print(f"{'Δlines':>7}  {'delta span':18}  file")
    for path, lns in per.items():
        segs = 1 + sum(1 for a, b in zip(lns, lns[1:]) if b != a + 1)
        span = f"{lns[0]}-{lns[-1]} ({segs} seg)"
        print(f"{len(lns):>7}  {span:18}  {path}")


# ── report (the story deck) ─────────────────────────────────────────

# Newlines survive so markdown bodies keep their structure; the report's
# renderer merges single-newline runs into paragraphs.
def _block_scalar(lines: list[str], i: int, key_indent: int) -> tuple[str, int]:
    out = []
    while i < len(lines) and (not lines[i].strip()
                              or len(lines[i]) - len(lines[i].lstrip()) > key_indent):
        out.append(lines[i].strip())
        i += 1
    while out and not out[-1]:
        out.pop()
    return "\n".join(out), i


# The problem is the report needs the full claim structure - text, note,
# tags, verdict, evidence, open questions, comments - not just anchors.
# The way we solve this is slicing the claims section into per-claim
# blocks and reading each field with the same narrow regexes the rest of
# the tool uses; the format is ours, so this stays honest.
# flow: report `GET /api/artifact` -> artifact_data() -> parse_claims() <-- HERE
def parse_claims(review_text: str) -> list[dict]:
    lines = review_text.splitlines()
    claims, cur, i = [], None, 0
    ev_by_claim: dict[str, list] = {}
    for e in evidence(review_text):
        ev_by_claim.setdefault(e["claim"], []).append(e)

    while i < len(lines):
        line = lines[i]
        m = re.match(r"^  - id:\s*(\S+)\s*$", line)
        if m:
            cur = {"id": m.group(1), "title": "", "text": "", "note": "",
                   "tags": [], "verdict": "unverified", "open_questions": [],
                   "comments": []}
            claims.append(cur)
            i += 1
            continue
        if cur is None or re.match(r"^\S", line):
            if re.match(r"^story:", line):
                break
            i += 1
            continue
        m = re.match(r"^    (text|note|title):\s*(.*?)\s*$", line)
        if m:
            key, val = m.groups()
            if val in (">", ">-", "|", ""):
                cur[key], i = _block_scalar(lines, i + 1, 4)
            else:
                cur[key] = _clean(val)
                i += 1
            continue
        m = re.match(r"^    tags:\s*\[(.*)\]\s*$", line)
        if m:
            cur["tags"] = [t.strip() for t in m.group(1).split(",") if t.strip()]
            i += 1
            continue
        m = re.match(r"^    verdict:\s*(\S+)", line)
        if m:
            cur["verdict"] = m.group(1)
            i += 1
            continue
        if re.match(r"^    open_questions:\s*$", line):
            i += 1
            while i < len(lines):
                m = re.match(r"^      - >?-?\s*(.*?)\s*$", lines[i])
                if not m:
                    break
                if m.group(1):
                    cur["open_questions"].append(_clean(m.group(1)))
                    i += 1
                else:
                    q, i = _block_scalar(lines, i + 1, 6)
                    cur["open_questions"].append(q)
            continue
        if re.match(r"^    comments:\s*$", line):
            i += 1
            while i < len(lines):
                m = re.match(r"^      - at:\s*[\"']?(\S+?)[\"']?\s*$", lines[i])
                if m:
                    at = m.group(1)
                    i += 1
                    m2 = re.match(r"^        text:\s*(.*?)\s*$", lines[i]) \
                        if i < len(lines) else None
                    cur["comments"].append(
                        {"at": at, "text": _clean(m2.group(1)) if m2 else ""})
                    if m2:
                        i += 1
                    continue
                m = re.match(r"^      - (?:text:\s*)?(.+?)\s*$", lines[i])
                if m:
                    cur["comments"].append({"at": None, "text": _clean(m.group(1))})
                    i += 1
                    continue
                break
            continue
        i += 1

    for c in claims:
        c["evidence"] = [
            {"kind": e["kind"],
             "raw": e.get("raw"),
             "pipeline": e.get("pipeline"),
             "in": e.get("in"),
             "note": e.get("note", "")}
            for e in ev_by_claim.get(c["id"], [])]
    return claims


# The problem is the story slide must show each walk leg WITH its short
# why, but old artifacts carry a bare id list (and maybe a why essay).
# The way we solve this is normalizing both walk spellings to
# [{id, why}] so the report renders one shape; the legacy why block
# still parses for old artifacts.
# flow: report `GET /api/artifact` -> artifact_data() -> _story() <-- HERE
def _story(review_text: str) -> dict:
    t = re.search(r"^story:\s*\n\s*title:\s*(.*?)\s*$", review_text, re.M)
    lines = review_text.splitlines()
    # scan only below story: so a claim body mentioning "summary:" can't shadow it
    start = next((i for i, l in enumerate(lines)
                  if re.match(r"^story:", l)), len(lines))

    def block(key):
        for i in range(start, len(lines)):
            if re.match(rf"^\s*{key}:\s*(?:[>|]-?)?\s*$", lines[i]):
                v, _ = _block_scalar(lines, i + 1,
                                     len(lines[i]) - len(lines[i].lstrip()))
                return v
        return ""

    walk = []
    m = re.search(r"^story:.*?walk:\s*\[(.*?)\]", review_text, re.M | re.S)
    if m:                                   # legacy: walk: [C2, C1]
        walk = [{"id": w.strip(), "why": ""}
                for w in m.group(1).split(",") if w.strip()]
    else:                                   # block: "- C2: why text"
        wi = next((i for i in range(start, len(lines))
                   if re.match(r"^\s*walk:\s*(#.*)?$", lines[i])), None)
        if wi is not None:
            key_indent = len(lines[wi]) - len(lines[wi].lstrip())
            i, cur = wi + 1, None
            while i < len(lines):
                line = lines[i]
                if line.strip().startswith("#"):
                    i += 1
                    continue
                if line.strip() and len(line) - len(line.lstrip()) <= key_indent:
                    break                   # next story key
                m2 = re.match(r"^\s*- (\S+?):\s*(.*?)\s*$", line)
                if m2:
                    wid, rest = m2.groups()
                    if rest in (">", ">-", "|", ""):
                        why, i = _block_scalar(
                            lines, i + 1, len(line) - len(line.lstrip()))
                        # leg whys are a sentence or two, never markdown
                        walk.append({"id": wid,
                                     "why": re.sub(r"\s+", " ", why).strip()})
                        cur = None
                        continue
                    cur = {"id": wid, "why": rest}
                    walk.append(cur)
                elif cur is not None and line.strip():
                    cur["why"] += " " + line.strip()
                i += 1
    return {"title": t.group(1) if t else "", "walk": walk,
            "summary": block("summary"), "why": block("why")}


def artifact_data(yaml_path: str) -> dict:
    text = _read(yaml_path)
    meta = yaml_meta(text, os.path.dirname(yaml_path) or ".")
    cov = (coverage_explore_data if meta["mode"] == "explore"
           else coverage_change_data)(meta, text)

    def field(name):
        m = re.search(rf"^\s*{name}:\s*[\"']?(.+?)[\"']?\s*$", text, re.M)
        return m.group(1) if m else ""
    return {
        "mode": meta["mode"], "repo": field("repo"), "title": field("title"),
        "ref": field("ref"), "alpha": meta["alpha"], "omega": meta["omega"],
        "coverage": {"claimed": cov["claimed"], "total": cov["total"],
                     "unit": cov["unit"], "stale": cov["stale"]},
        "story": _story(text), "claims": parse_claims(text),
    }


def _claim_span(lines: list[str], claim_id: str) -> tuple[int, int]:
    start = next((i for i, l in enumerate(lines)
                  if re.match(rf"^  - id:\s*{re.escape(claim_id)}\s*$", l)), -1)
    if start < 0:
        raise ValueError(f"no claim {claim_id}")
    end = next((i for i in range(start + 1, len(lines))
                if re.match(r"^  - id:", lines[i]) or re.match(r"^\S", lines[i])),
               len(lines))
    return start, end


# The problem is the report's one mutation - verdicts and reviewer
# comments - must land in review.yaml, which stays the single source of
# truth.
# The way we solve this is line surgery on the claim's block: replace the
# verdict line in place; append comments under a comments: key inserted
# after the verdict.
# flow: report `POST /api/verdict` -> set_verdict() <-- HERE
def set_verdict(yaml_path: str, claim_id: str, verdict: str) -> None:
    if verdict not in ("unverified", "verified", "refuted", "trusted"):
        raise ValueError(f"bad verdict {verdict!r}")
    lines = _read(yaml_path).splitlines()
    start, end = _claim_span(lines, claim_id)
    for i in range(start, end):
        if re.match(r"^    verdict:", lines[i]):
            lines[i] = f"    verdict: {verdict}"
            break
    else:
        lines.insert(start + 1, f"    verdict: {verdict}")
    open(yaml_path, "w").write("\n".join(lines) + "\n")


# flow: report `POST /api/comment` -> add_comment() <-- HERE
def add_comment(yaml_path: str, claim_id: str, text: str,
                at: str | None = None) -> None:
    import json as _json
    lines = _read(yaml_path).splitlines()
    start, end = _claim_span(lines, claim_id)
    q = _json.dumps(text, ensure_ascii=False)
    item = ([f"      - at: {at}", f"        text: {q}"]
            if at else [f"      - text: {q}"])
    for i in range(start, end):
        if re.match(r"^    comments:\s*$", lines[i]):
            j = i + 1
            while j < end and re.match(r"^      ", lines[j]):
                j += 1
            lines[j:j] = item
            break
    else:
        for i in range(start, end):
            if re.match(r"^    verdict:", lines[i]):
                lines[i + 1:i + 1] = ["    comments:"] + item
                break
        else:
            raise ValueError(f"claim {claim_id} has no verdict line to anchor on")
    open(yaml_path, "w").write("\n".join(lines) + "\n")


# flow: report `POST /api/uncomment` -> remove_comment() <-- HERE
def remove_comment(yaml_path: str, claim_id: str, text: str,
                   at: str | None = None) -> None:
    lines = _read(yaml_path).splitlines()
    start, end = _claim_span(lines, claim_id)
    for i in range(start, end):
        if not re.match(r"^    comments:\s*$", lines[i]):
            continue
        j = i + 1
        while j < min(end, len(lines)) and re.match(r"^      ", lines[j]):
            m = re.match(r"^      - at:\s*[\"']?(\S+?)[\"']?\s*$", lines[j])
            if m:
                m2 = re.match(r"^        text:\s*(.*?)\s*$", lines[j + 1]) \
                    if j + 1 < len(lines) else None
                if m and m2 and m.group(1) == at \
                        and _clean(m2.group(1)) == text:
                    del lines[j:j + 2]
                    break
                j += 2 if m2 else 1
                continue
            m = re.match(r"^      - (?:text:\s*)?(.+?)\s*$", lines[j])
            if m and at is None and _clean(m.group(1)) == text:
                del lines[j:j + 1]
                break
            j += 1
        else:
            raise ValueError("comment not found")
        # drop an emptied comments: key so the yaml stays clean
        if i + 1 >= len(lines) or not re.match(r"^      ", lines[i + 1]):
            del lines[i]
        open(yaml_path, "w").write("\n".join(lines) + "\n")
        return
    raise ValueError("comment not found")


# The problem is the report must be interactive - live resolution, verdict
# flips, anchored comments, IDE jumps - which a static render can't do.
# The way we solve this is a dependency-free local server over the yaml
# and repo: /api/* is interpreted (resolution through the same functions
# as the CLI, writes through set_verdict/add_comment), /static/* is
# couriered from the report/ folder, and every other path returns
# index.html so the client router owns the URL (refresh and back work).
# flow: CLI `gocr.py serve <review.yaml>` -> serve() <-- HERE
def serve(yaml_path: str, port: int = 7345) -> None:
    import json
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import parse_qs, urlparse

    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "report")
    editor = os.environ.get("GOCR_EDITOR")
    mime = {".html": "text/html; charset=utf-8", ".css": "text/css",
            ".js": "text/javascript", ".svg": "image/svg+xml",
            ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".ico": "image/x-icon", ".woff2": "font/woff2",
            ".json": "application/json"}

    class Handler(BaseHTTPRequestHandler):
        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _file(self, full_path):
            body = open(full_path, "rb").read()
            ext = os.path.splitext(full_path)[1]
            self.send_response(200)
            self.send_header("Content-Type",
                             mime.get(ext, "application/octet-stream"))
            self.send_header("Content-Length", str(len(body)))
            # a local dev tool must always serve current files - stale CSS
            # in the browser's memory cache reads as "the change didn't land"
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlparse(self.path)
            try:
                if url.path.startswith("/static/"):
                    full = os.path.realpath(
                        os.path.join(root, url.path[len("/static/"):]))
                    if full.startswith(os.path.realpath(root) + os.sep) \
                            and os.path.isfile(full):
                        self._file(full)
                    else:
                        self._json({"error": "not found"}, 404)
                elif url.path == "/api/artifact":
                    self._json(artifact_data(yaml_path))
                elif url.path == "/api/resolve":
                    q = parse_qs(url.query)
                    text = _read(yaml_path)
                    meta = yaml_meta(text, os.path.dirname(yaml_path) or ".")
                    if "sel" in q:
                        self._json(resolve_at_data(meta, q["sel"][0]))
                    else:
                        cid, idx = q["claim"][0], int(q["idx"][0])
                        mine = [e for e in evidence(text) if e["claim"] == cid]
                        e = mine[idx]
                        self._json(resolve_at_data(meta, e["raw"])
                                   if e["kind"] == "at" else
                                   resolve_grep_data(meta, e["pipeline"], e["in"]))
                elif url.path.startswith("/api/"):
                    self._json({"error": "not found"}, 404)
                else:
                    # the catch-all: any other path is the client router's
                    # business - hand it index.html and let JS render it
                    self._file(os.path.join(root, "index.html"))
            except Exception as err:
                self._json({"error": str(err)}, 500)

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            try:
                if self.path == "/api/verdict":
                    set_verdict(yaml_path, body["claim"], body["verdict"])
                    self._json({"ok": True})
                elif self.path == "/api/comment":
                    add_comment(yaml_path, body["claim"], body["text"],
                                body.get("at"))
                    self._json({"ok": True})
                elif self.path == "/api/uncomment":
                    remove_comment(yaml_path, body["claim"], body["text"],
                                   body.get("at"))
                    self._json({"ok": True})
                elif self.path == "/api/open":
                    import shlex
                    import shutil
                    abs_path = os.path.abspath(body["path"])
                    line = body.get("line", 1)
                    if editor:
                        cmd = editor.format(path=abs_path, line=line)
                        if shutil.which(shlex.split(cmd)[0]) is None:
                            self._json({"error": "GOCR_EDITOR command "
                                        f"'{shlex.split(cmd)[0]}' not found"},
                                       500)
                        else:
                            subprocess.Popen(cmd, shell=True)
                            self._json({"ok": True})
                        return
                    # Understand: `code` is often missing from PATH even when
                    # VS Code is installed (the user never ran "Install 'code'
                    # command"), so the app-bundle CLI is tried as a fallback.
                    # Passing the repo root alongside -g makes VS Code reuse
                    # the project window and jump to the line inside it - a
                    # bare file arg would open the file detached from the tree.
                    candidates = ["code", "/Applications/Visual Studio Code"
                                  ".app/Contents/Resources/app/bin/code"]
                    cli = next(
                        (c for c in candidates
                         if (os.path.isfile(c) if os.sep in c
                             else shutil.which(c))), None)
                    if cli is None:
                        self._json({"error": "VS Code CLI not found - run "
                                    "\"Install 'code' command\" in VS Code, "
                                    'or set GOCR_EDITOR="<cmd> {path}:{line}"'
                                    " for another editor"}, 500)
                    else:
                        subprocess.Popen(
                            [cli, os.getcwd(), "-g", f"{abs_path}:{line}"])
                        self._json({"ok": True})
                else:
                    self._json({"error": "not found"}, 404)
            except Exception as err:
                self._json({"error": str(err)}, 500)

        def log_message(self, format, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"gocr report: http://127.0.0.1:{port}/  (yaml: {yaml_path})")
    httpd.serve_forever()


def main() -> None:
    cmd, rest = sys.argv[1], sys.argv[2:]
    if cmd == "coverage":
        coverage(rest[0])
    elif cmd == "resolve":
        resolve(rest[0], rest[1])
    elif cmd == "stats":
        stats(rest[0])
    elif cmd == "files":
        files(rest[0])
    elif cmd == "serve":
        serve(rest[0], int(rest[1]) if len(rest) > 1 else 7345)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
