#!/usr/bin/env python3
"""Sheepdog agent probe.

Lists running Claude Code, Codex, Gemini CLI and Antigravity CLI (agy) sessions on this machine plus basic host
load, and prints one JSON object. It never signals any process; the only file it
writes is its own token-count cache (~/.cache/sheepdog/claude-tokens.json), so
it doesn't re-read whole Claude logs every poll. Runs locally, and is piped over
ssh to remote machines (`ssh <host> python3 - < probe.py`). Needs Python 3.8+.
"""
import glob
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
NOW = time.time()
IS_LINUX = sys.platform.startswith("linux")
WORKING_WINDOW = 20  # seconds since last log write that still counts as "working"
# Claude logs don't record the context window size. Assume 200k unless the model id says 1M
# or the context has already grown past 200k (then it must be a 1M window).
CLAUDE_WINDOW = int(os.environ.get("CLAUDE_CONTEXT_WINDOW", "200000"))
TOKEN_CACHE = os.path.join(HOME, ".cache", "sheepdog", "claude-tokens.json")
_token_cache = None
CTX_KEYS = ("tokens", "contextTokens", "contextWindow", "contextPct")


# ---------------------------------------------------------------- helpers
def run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10,
                              env={**os.environ, "LC_ALL": "C"}).stdout
    except Exception:
        return ""


def parse_etime(s):
    """ps etime: [[dd-]hh:]mm:ss -> seconds."""
    days = 0
    if "-" in s:
        d, s = s.split("-", 1)
        days = int(d)
    parts = [int(x) for x in s.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    h, m, sec = parts
    return days * 86400 + h * 3600 + m * 60 + sec


def read_json_lines(path, from_end=True, nbytes=400_000):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            start = max(0, size - nbytes) if from_end else 0
            f.seek(start)
            data = f.read(nbytes)
    except OSError:
        return []
    lines = data.split(b"\n")
    if from_end and start > 0:
        lines = lines[1:]          # first line is probably cut
    if not from_end and len(data) == nbytes:
        lines = lines[:-1]         # last line is probably cut
    out = []
    for line in lines:
        if line.strip():
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def lines_backwards(path, needles, chunk=262_144):
    """Yield parsed JSON lines containing any of `needles`, newest first, reading the file backwards."""
    try:
        f = open(path, "rb")
    except OSError:
        return
    with f:
        f.seek(0, 2)
        pos = f.tell()
        rest = b""  # partial first line carried over from the previous (later) chunk
        while pos > 0:
            step = min(chunk, pos)
            pos -= step
            f.seek(pos)
            buf = f.read(step) + rest
            lines = buf.split(b"\n")
            rest = lines[0] if pos > 0 else b""  # may be cut; complete it with the next chunk
            for line in reversed(lines[1:] if pos > 0 else lines):
                if any(n in line for n in needles):
                    try:
                        yield json.loads(line)
                    except ValueError:
                        pass


def iso_ts(s):
    """'2026-11-25T07:40:49.365Z' -> epoch seconds (UTC)."""
    if not s:
        return None
    try:
        import calendar
        base, _, frac = s.rstrip("Z").partition(".")
        return calendar.timegm(time.strptime(base, "%Y-%m-%dT%H:%M:%S")) + float("0." + (frac or "0"))
    except ValueError:
        return None


def clip(s, n=140):
    if not s:
        return None
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


def short_path(p):
    if not p:
        return None
    return "~" + p[len(HOME):] if p.startswith(HOME) else p


# ---------------------------------------------------------------- processes
def list_procs():
    out = run(["ps", "-axo", "pid=,ppid=,etime=,pcpu=,stat=,tty=,args="])
    procs = {}
    for line in out.splitlines():
        p = line.split(None, 6)
        if len(p) < 7:
            continue
        pid, ppid, et, cpu, stat, tty, args = p
        try:
            procs[int(pid)] = dict(pid=int(pid), ppid=int(ppid), age=parse_etime(et),
                                   cpu=float(cpu), stat=stat, tty=tty, args=args)
        except ValueError:
            pass
    return procs


def agent_kind(pr):
    if pr["stat"].startswith("Z"):
        return None
    toks = pr["args"].split()
    head = " ".join(toks[:3])
    # skip the Codex app-server daemon/helpers and macOS desktop apps (argv only, not flags)
    if "app-server" in head or "code-mode-host" in head or toks[0].startswith("/Applications/"):
        return None
    # the program, or the script a node/bun interpreter runs (skipping flags like --max-old-space-size=…,
    # which Gemini CLI adds when it relaunches itself)
    cand = toks[:1] + [t for t in toks[1:4] if not t.startswith("-")][:1]
    for tok in cand:
        base = os.path.basename(tok)
        if base in ("codex", "claude", "gemini", "agy"):
            return base
    return None


def is_wrapper(pr):
    return os.path.basename(pr["args"].split()[0]) in ("node", "bun")


def proc_env(pid):
    try:
        with open(f"/proc/{pid}/environ", "rb") as f:
            return dict(v.split(b"=", 1) for v in f.read().split(b"\0") if b"=" in v)
    except OSError:
        return {}


def env_ssh_port(env):
    try:
        return int(env[b"SSH_CONNECTION"].split()[1])
    except (KeyError, ValueError, IndexError):
        return None


def tmux_client_pids(env):
    """Agents inside tmux: the tmux clients (`tmux attach` processes) currently showing the agent's session,
    most recently active first. The agent's own environment is tmux's, from whoever started tmux first."""
    tmux, pane = env.get(b"TMUX"), env.get(b"TMUX_PANE")
    if not tmux or not pane:
        return []
    sock = tmux.split(b",")[0].decode(errors="replace")
    base = ["tmux", "-S", sock]
    session = run(base + ["display-message", "-p", "-t", pane.decode(errors="replace"), "#{session_name}"]).strip()
    if not session:
        return []
    clients = []
    for line in run(base + ["list-clients", "-F", "#{client_pid}\t#{client_session}\t#{client_activity}"]).splitlines():
        p = line.split("\t")
        if len(p) == 3 and p[1] == session:
            try:
                clients.append((int(p[2] or 0), int(p[0])))
            except ValueError:
                pass
    return [pid for _, pid in sorted(clients, reverse=True)]


def ssh_client_port(pid):
    """For agents started inside an ssh login: the client's source port (links it to a Mac tab). Inside tmux,
    the port of the ssh login that is showing the agent right now."""
    if not IS_LINUX:
        return None
    env = proc_env(pid)
    for client in tmux_client_pids(env):
        port = env_ssh_port(proc_env(client))
        if port:
            return port
    return env_ssh_port(env)


def get_cwds(pids):
    res = {}
    if not pids:
        return res
    if IS_LINUX:
        for p in pids:
            try:
                res[p] = os.readlink(f"/proc/{p}/cwd")
            except OSError:
                pass
        return res
    cur = None
    for line in run(["lsof", "-a", "-d", "cwd", "-Fpn", "-p", ",".join(map(str, pids))]).splitlines():
        if line.startswith("p"):
            cur = int(line[1:])
        elif line.startswith("n") and cur:
            res[cur] = line[1:]
    return res


# ---------------------------------------------------------------- tokens
def _load_token_cache():
    global _token_cache
    if _token_cache is None:
        try:
            with open(TOKEN_CACHE) as f:
                _token_cache = json.load(f)
        except (OSError, ValueError):
            _token_cache = {}
    return _token_cache


def save_token_cache(live_paths):
    if _token_cache is None:
        return
    keep = {p: v for p, v in _token_cache.items() if p in live_paths}
    try:
        os.makedirs(os.path.dirname(TOKEN_CACHE), exist_ok=True)
        tmp = TOKEN_CACHE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(keep, f)
        os.replace(tmp, TOKEN_CACHE)
    except OSError:
        pass


def claude_tokens(log):
    """(session tokens, context tokens, model) for a Claude log, read incrementally.

    Session tokens = everything sent and received over the session (input incl. cache + output),
    the same measure as Codex's total_tokens. Context = what the last request sent.
    Streamed replies repeat one message's usage on several lines, so each message id counts once.
    """
    cache = _load_token_cache()
    c = cache.get(log) or {"off": 0, "total": 0, "ctx": 0, "model": None, "last": None}
    try:
        size = os.path.getsize(log)
    except OSError:
        return None
    if size < c["off"]:  # file was rewritten
        c = {"off": 0, "total": 0, "ctx": 0, "model": None, "last": None}
    if size > c["off"]:
        with open(log, "rb") as f:
            f.seek(c["off"])
            data = f.read(size - c["off"])
        end = data.rfind(b"\n") + 1  # only whole lines; the rest is read next time
        for line in data[:end].split(b"\n"):
            if b'"usage"' not in line or b'"assistant"' not in line:
                continue
            try:
                msg = json.loads(line).get("message") or {}
            except ValueError:
                continue
            u = msg.get("usage")
            if not u or msg.get("id") == c["last"]:
                continue
            inp = (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) \
                + (u.get("cache_creation_input_tokens") or 0)
            c["total"] += inp + (u.get("output_tokens") or 0)
            c["ctx"] = inp
            c["model"] = msg.get("model") or c["model"]
            c["last"] = msg.get("id")
        c["off"] += end
        cache[log] = c
    return c


def claude_context(log):
    c = claude_tokens(log)
    if not c or not c["ctx"]:
        return {}
    model = c.get("model") or ""
    window = 1_000_000 if ("1m" in model.lower() or c["ctx"] > CLAUDE_WINDOW) else CLAUDE_WINDOW
    return dict(tokens=c["total"], contextTokens=c["ctx"], contextWindow=window,
                contextPct=round(100 * c["ctx"] / window), model=model or None)


def codex_context(path):
    for e in lines_backwards(path, (b'"type":"token_count"',)):
        info = (e.get("payload") or {}).get("info") or {}
        total = (info.get("total_token_usage") or {}).get("total_tokens")
        last = info.get("last_token_usage") or {}
        ctx = (last.get("input_tokens") or 0) + (last.get("output_tokens") or 0)
        window = info.get("model_context_window")
        if total is None:
            continue
        return dict(tokens=total, contextTokens=ctx, contextWindow=window,
                    contextPct=round(100 * ctx / window) if window else None)
    return {}


# ---------------------------------------------------------------- claude
def claude_session(pid, cwd):
    info = {}
    meta_path = os.path.join(HOME, ".claude", "sessions", f"{pid}.json")
    try:
        with open(meta_path) as f:
            meta = json.load(f)
    except (OSError, ValueError):
        meta = {}
    sid = meta.get("sessionId")
    cwd = meta.get("cwd") or cwd
    info["headless"] = meta.get("kind") not in (None, "interactive")
    info["name"] = meta.get("name")
    status = meta.get("status")  # "busy" | "idle" | ...
    status_at = (meta.get("statusUpdatedAt") or 0) / 1000 or None

    log = None
    if sid and cwd:
        cand = os.path.join(HOME, ".claude", "projects", re.sub(r"[^A-Za-z0-9]", "-", cwd), f"{sid}.jsonl")
        if os.path.exists(cand):
            log = cand
    title = prompt = branch = None
    last = None
    if log:
        last = os.path.getmtime(log)
        for e in read_json_lines(log):
            t = e.get("type")
            if t == "ai-title":
                title = e.get("aiTitle") or title
            elif t == "last-prompt":
                prompt = e.get("lastPrompt") or prompt
            elif t in ("assistant", "user"):
                branch = e.get("gitBranch") or branch
    if status == "busy":
        state = "working"
    elif status:
        state = "waiting"
    else:  # no status file: fall back to log activity
        state = "working" if last and NOW - last < WORKING_WINDOW else "waiting"
    info.update(sessionId=sid, title=clip(title, 80), prompt=clip(prompt), branch=branch,
                state=state, stateSince=status_at if status else None, lastActivity=last, cwd=cwd)
    if log:
        info.update(claude_context(log))
        info["_log"] = log
    return info


# ---------------------------------------------------------------- codex
def codex_index():
    names = {}
    for e in read_json_lines(os.path.join(HOME, ".codex", "session_index.jsonl"), nbytes=300_000):
        if e.get("id"):
            names[e["id"]] = e.get("thread_name")
    return names


def codex_rollouts(since):
    """Rollout logs modified after `since`, newest first, with parsed status."""
    files = []
    for path in glob.glob(os.path.join(HOME, ".codex", "sessions", "*", "*", "*", "rollout-*.jsonl")):
        try:
            mt = os.path.getmtime(path)
        except OSError:
            continue
        if mt >= since:
            files.append((mt, path))
    files.sort(reverse=True)
    names = codex_index() if files else {}
    out = []
    for mt, path in files[:40]:
        head = read_json_lines(path, from_end=False, nbytes=120_000)
        meta = next((e.get("payload", {}) for e in head if e.get("type") == "session_meta"), {})
        first_user = None
        for e in head:
            p = e.get("payload") or {}
            if e.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
                for c in p.get("content") or []:
                    txt = (c.get("text") or "").strip()
                    if txt and not txt.startswith("<") and "AGENTS.md" not in txt[:200]:
                        first_user = txt
                        break
            if first_user:
                break
        # Status = the last task start/finish event. Big tool outputs can push it far from the end
        # of the file, so search backwards until it is found instead of reading a fixed tail.
        state, state_ts = "waiting", None
        for e in lines_backwards(path, (b'"payload":{"type":"task_started"', b'"payload":{"type":"task_complete"',
                                        b'"payload":{"type":"turn_aborted"')):
            started_evt = (e.get("payload") or {}).get("type") == "task_started"
            state, state_ts = ("working" if started_evt else "waiting"), e.get("timestamp")
            break
        last_user = None
        for e in lines_backwards(path, (b'"role":"user","content":[{"type":"input_text"',)):
            for c in (e.get("payload") or {}).get("content") or []:
                txt = (c.get("text") or "").strip()
                if txt and not txt.startswith("<") and "AGENTS.md" not in txt[:200]:
                    last_user = txt
                    break
            if last_user:
                break
        m = re.search(r"rollout-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d)", path)
        started = time.mktime(time.strptime(m.group(1), "%Y-%m-%dT%H-%M-%S")) if m else None
        sid = meta.get("id")
        out.append(dict(sessionId=sid, path=path, lastActivity=mt, started=started,
                        cwd=meta.get("cwd"), originator=meta.get("originator"),
                        title=clip(names.get(sid), 80), prompt=clip(last_user or first_user),
                        firstPrompt=first_user, state=state, stateSince=iso_ts(state_ts),
                        **codex_context(path)))
    return out


# ---------------------------------------------------------------- gemini cli
# ~/.gemini/tmp/<project>/chats/session-<time>-<id>.jsonl: a header line {sessionId, startTime, lastUpdated, kind},
# then one line per message ({type: user|gemini|info, timestamp, content, tokens, model}) and {"$set": {...}}
# updates (lastUpdated, summary). <project> comes from ~/.gemini/projects.json (path -> name).
GEMINI = os.path.join(HOME, ".gemini")
GEMINI_WINDOW = int(os.environ.get("GEMINI_CONTEXT_WINDOW", "1000000"))


def gemini_chat_dirs(cwd):
    dirs = []
    try:
        with open(os.path.join(GEMINI, "projects.json")) as f:
            name = (json.load(f).get("projects") or {}).get(cwd)
        if name:
            dirs.append(os.path.join(GEMINI, "tmp", name, "chats"))
    except (OSError, ValueError):
        pass
    import hashlib
    dirs.append(os.path.join(GEMINI, "tmp", hashlib.sha256(cwd.encode()).hexdigest(), "chats"))  # older layout
    return [d for d in dirs if os.path.isdir(d)]


def gemini_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("text"))
    return ""


def gemini_tokens(path):
    """(session tokens, context tokens, model), read incrementally like Claude's."""
    cache = _load_token_cache()
    key = "gemini:" + path
    c = cache.get(key) or {"off": 0, "total": 0, "ctx": 0, "model": None, "last": None}
    try:
        size = os.path.getsize(path)
    except OSError:
        return c
    if size < c["off"]:
        c = {"off": 0, "total": 0, "ctx": 0, "model": None, "last": None}
    if size > c["off"]:
        with open(path, "rb") as f:
            f.seek(c["off"])
            data = f.read(size - c["off"])
        end = data.rfind(b"\n") + 1
        for line in data[:end].split(b"\n"):
            if b'"tokens"' not in line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            t = e.get("tokens") or {}
            if e.get("type") != "gemini" or not t or e.get("id") == c["last"]:
                continue
            c["total"] += t.get("total") or 0
            c["ctx"] = (t.get("input") or 0) + (t.get("output") or 0)
            c["model"] = e.get("model") or c["model"]
            c["last"] = e.get("id")
        c["off"] += end
        cache[key] = c
    return c


def gemini_session_info(path):
    """Header, title, prompts and timing of one Gemini session file."""
    head = read_json_lines(path, from_end=False, nbytes=4000)[:1]
    meta = head[0] if head else {}
    if meta.get("kind") not in (None, "main"):
        return None  # subagent sessions
    tail = read_json_lines(path, nbytes=300_000)
    summary = last_user = first_user = None
    last_type = last_ts = last_user_ts = None
    updated = iso_ts(meta.get("lastUpdated"))
    for e in tail:
        if "$set" in e:
            st = e["$set"]
            summary = st.get("summary") or summary
            updated = iso_ts(st.get("lastUpdated")) or updated
            continue
        t = e.get("type")
        if t in ("user", "gemini"):
            last_type, last_ts = t, iso_ts(e.get("timestamp"))
        if t == "user":
            txt = gemini_text(e.get("content")).strip()
            if txt and not txt.startswith("/"):
                last_user, last_user_ts = txt, iso_ts(e.get("timestamp"))
    if not first_user:
        for e in read_json_lines(path, from_end=False, nbytes=60_000):
            if e.get("type") == "user":
                first_user = gemini_text(e.get("content")).strip() or None
                if first_user:
                    break
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        mtime = None
    return dict(path=path, sessionId=meta.get("sessionId"), started=iso_ts(meta.get("startTime")),
                updated=max(x for x in (updated, mtime, 0) if x is not None), title=summary or first_user,
                prompt=last_user or first_user, lastType=last_type, lastTs=last_ts, lastUserTs=last_user_ts)


def gemini_attach(procs):
    """Give each running gemini process its session: newest session in its folder started after it."""
    by_cwd = {}
    for a in procs:
        by_cwd.setdefault(a.get("cwd") or "", []).append(a)
    for cwd, group in by_cwd.items():
        files = []
        for d in gemini_chat_dirs(cwd) if cwd else []:
            for p in glob.glob(os.path.join(d, "session-*.jsonl")):
                try:
                    files.append((os.path.getmtime(p), p))
                except OSError:
                    pass
        files.sort(reverse=True)
        sessions = [s for s in (gemini_session_info(p) for _, p in files[:20]) if s]
        taken = set()
        for a in sorted(group, key=lambda x: -x["started"]):
            # a session this process started, else (resumed with --resume) one it has written to since starting
            mine = [s for s in sessions if s["path"] not in taken and (s["started"] or 0) >= a["started"] - 10] \
                or [s for s in sessions if s["path"] not in taken and s["updated"] >= a["started"]]
            if not mine:
                a.update(state="waiting", stateSince=a["started"], title=None, prompt=None, lastActivity=None, headless=False)
                continue
            s = mine[-1] if (mine[-1]["started"] or 0) >= a["started"] - 10 else mine[0]
            taken.add(s["path"])
            # Gemini only writes a tool call once it has finished, and nothing while it thinks: count it as
            # working while the log was just written, the last message is yours, or the process is busy.
            busy = NOW - s["updated"] < WORKING_WINDOW or (a.get("cpu") or 0) >= 3.0
            working = busy or (s["lastType"] == "user" and NOW - (s["lastUserTs"] or 0) < 3600 and (a.get("cpu") or 0) >= 1.0)
            tok = gemini_tokens(s["path"])
            a.update(sessionId=s["sessionId"], title=clip(s["title"], 80), prompt=clip(s["prompt"]), headless=False,
                     state="working" if working else "waiting",
                     stateSince=(s["lastUserTs"] if working else s["updated"]) or a["started"], lastActivity=s["updated"])
            if tok.get("ctx"):
                a.update(tokens=tok["total"], contextTokens=tok["ctx"], contextWindow=GEMINI_WINDOW,
                         contextPct=round(100 * tok["ctx"] / GEMINI_WINDOW), model=tok.get("model"))
            a["_log"] = "gemini:" + s["path"]


# ---------------------------------------------------------------- antigravity cli (agy)
# ~/.gemini/antigravity-cli/conversation_summaries.db has one row per conversation: title, status
# (CASCADE_RUN_STATUS_RUNNING / BUSY / CANCELING / IDLE), workspace, last change and last user input.
AGY = os.path.join(GEMINI, "antigravity-cli")


def agy_rows():
    path = os.path.join(AGY, "conversation_summaries.db")
    if not os.path.exists(path):
        return []
    try:
        con = sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=2)
        con.row_factory = sqlite3.Row
        rows = [dict(r) for r in con.execute(
            "select conversation_id, title, preview, status, workspace_uris, last_modified_time, last_user_input_time, "
            "killed, nesting_depth from conversation_summaries order by last_modified_time desc limit 50")]
        con.close()
        return rows
    except sqlite3.Error:
        return []


def sql_ts(s):
    """'2026-11-25 09:11:36.714702+00:00' -> epoch seconds."""
    if not s:
        return None
    try:
        import calendar
        base = str(s)[:19]
        return calendar.timegm(time.strptime(base, "%Y-%m-%d %H:%M:%S"))
    except ValueError:
        return None


def agy_open_conversations(pid):
    """Conversation ids a running agy process has open (its .db / presence lock files)."""
    ids = set()
    names = []
    if IS_LINUX:
        try:
            for fd in os.listdir(f"/proc/{pid}/fd"):
                try:
                    names.append(os.readlink(f"/proc/{pid}/fd/{fd}"))
                except OSError:
                    pass
        except OSError:
            pass
    else:
        names = [l[1:] for l in run(["lsof", "-p", str(pid), "-Fn"]).splitlines() if l.startswith("n")]
    for n in names:
        m = re.search(r"antigravity-cli/(?:conversations|presence)/([0-9a-f-]{36})\.(?:db|lock)", n)
        if m:
            ids.add(m.group(1))
    return ids


def agy_prompts():
    out = {}
    for e in read_json_lines(os.path.join(AGY, "history.jsonl"), nbytes=200_000):
        if e.get("conversationId") and e.get("display"):
            out[e["conversationId"]] = e["display"]
    return out


def agy_attach(procs):
    rows = [r for r in agy_rows() if not r.get("killed") and not r.get("nesting_depth")]
    prompts = agy_prompts() if procs else {}
    taken = set()
    for a in sorted(procs, key=lambda x: -x["started"]):
        open_ids = agy_open_conversations(a["pid"])
        mine = [r for r in rows if r["conversation_id"] in open_ids and r["conversation_id"] not in taken]
        if not mine:  # fall back to the newest conversation in its folder changed since it started
            uri = "file://" + (a.get("cwd") or "")
            mine = [r for r in rows if r["conversation_id"] not in taken and uri in (r.get("workspace_uris") or "")
                    and (sql_ts(r["last_modified_time"]) or 0) >= a["started"] - 10]
        if not mine:
            a.update(state="waiting", stateSince=a["started"], title=None, prompt=None, lastActivity=None, headless=False)
            continue
        r = mine[0]
        taken.add(r["conversation_id"])
        status = r.get("status") or ""
        working = status.endswith(("RUNNING", "BUSY", "CANCELING"))
        changed = sql_ts(r["last_modified_time"])
        asked = sql_ts(r["last_user_input_time"])
        a.update(sessionId=r["conversation_id"], title=clip(r.get("title") or r.get("preview"), 80),
                 prompt=clip(prompts.get(r["conversation_id"]) or r.get("preview")), headless=False,
                 state="working" if working else "waiting",
                 stateSince=(asked if working else changed) or a["started"], lastActivity=changed)


# ---------------------------------------------------------------- host
def host_stats():
    st = {"host": os.uname().nodename.split(".")[0], "ncpu": os.cpu_count()}
    try:
        st["load"] = [round(x, 2) for x in os.getloadavg()]
    except OSError:
        pass
    du = shutil.disk_usage("/" if IS_LINUX else HOME)
    st["disk"] = {"used": du.used, "total": du.total}
    if IS_LINUX:
        mem = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                mem[k] = int(v.split()[0]) * 1024
        st["mem"] = {"used": mem["MemTotal"] - mem.get("MemAvailable", 0), "total": mem["MemTotal"]}
    else:
        # macOS: used = app + wired + compressed pages (what Activity Monitor calls "Memory Used")
        total = int(run(["sysctl", "-n", "hw.memsize"]).strip() or 0)
        vs = run(["vm_stat"])
        page = int((re.search(r"page size of (\d+)", vs) or [0, 4096])[1])
        pages = {k.strip().lower(): int(v.strip().rstrip(".")) for k, v in
                 re.findall(r"^([^:\n]+):\s+(\d+)\.?$", vs, re.M)}
        app = pages.get("anonymous pages", 0) - pages.get("pages purgeable", 0)
        used = (app + pages.get("pages wired down", 0) + pages.get("pages occupied by compressor", 0)) * page
        if total:
            st["mem"] = {"used": min(used, total), "total": total}
    return st


# ---------------------------------------------------------------- main
def main():
    procs = list_procs()
    kinds = {pid: k for pid, pr in procs.items() if (k := agent_kind(pr))}
    children = {}
    for pid in kinds:
        children.setdefault(procs[pid]["ppid"], []).append(pid)
    # drop node/bun launcher wrappers whose child is the real agent binary
    agents = [pid for pid in kinds
              if not (is_wrapper(procs[pid]) and any(kinds.get(c) == kinds[pid] for c in children.get(pid, [])))]
    agent_set = set(agents)
    cwds = get_cwds(agents)

    result = []
    codex_procs, gemini_procs, agy_procs = [], [], []
    for pid in agents:
        pr = procs[pid]
        # parent agent (sub-agent / headless child), walking up the tree
        parent, cur, hops = None, pr["ppid"], 0
        while cur in procs and hops < 20:
            if cur in agent_set:
                parent = cur
                break
            cur, hops = procs[cur]["ppid"], hops + 1
        a = dict(kind=kinds[pid], pid=pid, parent=parent, age=pr["age"], started=NOW - pr["age"],
                 cpu=pr["cpu"], tty=None if pr["tty"] in ("?", "??") else pr["tty"], cwd=cwds.get(pid),
                 sshPort=ssh_client_port(pid))
        if a["kind"] == "claude":
            a.update(claude_session(pid, a["cwd"]))
            if " -p" in f" {pr['args']} " or "--print" in pr["args"]:
                a["headless"] = True
        elif a["kind"] == "codex":
            codex_procs.append(a)
        elif a["kind"] == "gemini":
            gemini_procs.append(a)
            if " -p " in f" {pr['args']} " or "--prompt " in pr["args"]:
                a["headless"] = True
        else:
            agy_procs.append(a)
        result.append(a)
    gemini_attach(gemini_procs)
    agy_attach(agy_procs)

    # match codex TUI processes to their rollout logs by start time
    rollouts = codex_rollouts(NOW - 2 * 86400) if codex_procs else codex_rollouts(NOW - 3600)
    # Each TUI rollout belongs to the most recently started TUI (same cwd) that was already
    # running when the rollout was created. A TUI that started several threads (/new) shows the
    # most recently active one. (The server can override this using the cmux tab title.)
    owned = {}
    for r in rollouts:
        if r["originator"] not in (None, "codex-tui") or r["started"] is None:
            continue
        owners = [a for a in codex_procs if a["started"] - 10 <= r["started"]
                  and not (r["cwd"] and a["cwd"] and r["cwd"] != a["cwd"])]
        if owners:
            owner = max(owners, key=lambda a: a["started"])
            owned.setdefault(owner["pid"], []).append(r)
    used = set()
    for a in codex_procs:
        mine = owned.get(a["pid"], [])
        best = max(mine, key=lambda r: r["lastActivity"]) if mine else None
        if best:
            used.add(best["sessionId"])
            a.update({k: best[k] for k in ("sessionId", "title", "prompt", "state", "stateSince", "lastActivity", "originator")})
            a.update({k: best[k] for k in CTX_KEYS if k in best})
            a["headless"] = False
        else:
            # untitled TUI: waiting for its first prompt since it was started
            a.update(state="waiting", stateSince=a["started"], title=None, prompt=None, lastActivity=None, headless=False)
    # codex sessions without a terminal (desktop app / IDE via app-server) that are mid-task
    for r in rollouts:
        if r["sessionId"] not in used and r["state"] == "working" and NOW - r["lastActivity"] < 900 \
                and r["originator"] != "codex-tui":
            result.append(dict(kind="codex", pid=None, parent=None, age=NOW - (r["started"] or r["lastActivity"]),
                               started=r["started"], cpu=None, tty=None, cwd=r["cwd"], headless=False,
                               app=True, **{k: r[k] for k in ("sessionId", "title", "prompt", "state", "stateSince",
                                                              "lastActivity", "originator") + CTX_KEYS if k in r}))

    for a in result:
        a["where"] = short_path(a.get("cwd"))
        a["repo"] = os.path.basename(a["cwd"]) if a.get("cwd") else None

    sessions = [{k: r[k] for k in ("sessionId", "title", "prompt", "state", "stateSince", "lastActivity", "started", "cwd")
                 + CTX_KEYS if k in r}
                for r in rollouts[:25]]
    save_token_cache({a.pop("_log") for a in result if a.get("_log")})
    print(json.dumps({**host_stats(), "now": NOW, "agents": result, "codexSessions": sessions}))


if __name__ == "__main__":
    main()
