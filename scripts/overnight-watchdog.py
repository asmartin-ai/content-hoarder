#!/usr/bin/env python3
"""
Overnight bakeoff watchdog — detects Zed death, agent stalls, and sequence
transitions between content-hoarder (CH) and PKMS bakeoffs. Pings ntfy on each
event. Run in a DEDICATED terminal (NOT inside any Zed session) so it survives
Zed crashes.

Sequence:
  1. CH bakeoff starts (manually, by user, in a Zed session rooted at content-hoarder).
  2. CH bakeoff publishes "CH_BAKEOFF_DONE" to ntfy topic when finished.
  3. PKMS bakeoff (waiting in another Zed session rooted at PKMS) sees that and starts.
  4. PKMS bakeoff publishes "PKMS_BAKEOFF_DONE" when finished.

Watchdog watches:
  - Zed.exe process alive (tasklist)
  - File mtimes in K:/Projects/{content-hoarder,PKMS}/{bakeoff,tests}
  - ntfy topic for the two DONE tokens

Alerts via ntfy on:
  - Zed death (and revival)
  - File-write stalls (>15 min while a phase expects activity)
  - PKMS not starting within 10 min of CH done
  - Both done (success ping)
  - Hourly "watchdog alive" ping so you know the watchdog itself didn't die

Usage:
    python -u overnight-watchdog.py

Stop with Ctrl+C — writes a final log entry and pings "watchdog stopped".

Logs to: overnight-watchdog-<timestamp>.log next to this script.
Heartbeat: overnight-watchdog-heartbeat.txt (overwritten every 60s).
"""

import datetime
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
TOPIC = "kenja-bench-r7k2q9"
NTFY_BASE = "https://ntfy.sh"

POLL_INTERVAL = 120  # 2 min — main poll loop
NTFY_POLL_INTERVAL = 30  # 30 sec — ntfy message poll
HEARTBEAT_INTERVAL = 60  # 60 sec — write heartbeat.txt
HOURLY_PING_INTERVAL = 3600  # 1 hour — "watchdog alive" ntfy ping

STALL_THRESHOLD = 900  # 15 min — no file write → stall alert
PKMS_STARTUP_GRACE = 600  # 10 min — PKMS should start within this of CH done
STALL_ALERT_COOLDOWN = 1800  # 30 min — don't repeat a stall alert for same dir
STARTUP_GRACE = 600  # 10 min — don't alert stalls in the first 10 min of watchdog life
# (lets user start the watchdog before kicking off CH)

# Filter out the watchdog's own published messages from being re-interpreted.
# If a polled ntfy msg starts with any of these, it's our own echo and should be ignored.
OWN_MSG_PREFIXES = (
    "STALL:",
    "watchdog alive,",
    "Overnight bakeoff watchdog",
    "CH done received.",
    "PKMS bakeoff started.",
    "Both bakeoffs done.",
    "Watchdog stopped",
    "Watchdog fatal",
    "Zed process came back",
    "Zed process not found",
    "PKMS hasn't started",
    "PKMS not started",
    "CH bakeoff done",
    "Watchdog hourly",
    "Watchdog started",
    "PKMS started",
)

# (label, dir, expected_during_phase)
# phase values: "ch" (CH running), "pkms" (PKMS running)
WATCH_DIRS = [
    ("CH bakeoff", Path("K:/Projects/content-hoarder/bakeoff"), "ch"),
    ("CH tests", Path("K:/Projects/content-hoarder/tests"), "ch"),
    ("PKMS bakeoff", Path("K:/Projects/PKMS/bakeoff"), "pkms"),
    ("PKMS tests", Path("K:/Projects/PKMS/tests"), "pkms"),
]

LOG_DIR = Path("K:/Users/Kenja/Documents/LLM-dev/bakeoffs")

# Message protocol — bakeoff agents must send these EXACT tokens to trigger
# phase transitions. Tell the agents to publish them via curl/Invoke-RestMethod
# to https://ntfy.sh/kenja-bench-r7k2q9 when their bakeoff completes.
CH_DONE_TOKEN = "CH_BAKEOFF_DONE"
PKMS_DONE_TOKEN = "PKMS_BAKEOFF_DONE"


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
class State:
    def __init__(self):
        # phase: "ch_running" | "ch_done_pkms_pending" | "pkms_running" | "both_done" | "fatal"
        self.phase = "ch_running"
        self.ch_done_ts = None
        self.pkms_started_ts = None
        self.pkms_done_ts = None
        self.zed_dead_since = None  # None = alive; datetime = first detected dead
        self.last_stall_alert = {}  # dir_label -> timestamp of last stall alert
        self.last_hourly_ping = 0
        self.start_ts = time.time()
        self.seen_ntfy_ids = set()  # for ntfy dedup
        self.first_ntfy_poll = (
            True  # seed seen set on first poll, don't emit historical
        )


state = State()


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
LOG_FILE = (
    LOG_DIR
    / f"overnight-watchdog-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.log"
)
HEARTBEAT_FILE = LOG_DIR / "overnight-watchdog-heartbeat.txt"


def log(msg, level="INFO"):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] [{level}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as e:
        print(f"[log write failed: {e}]", flush=True)


def write_heartbeat():
    try:
        with open(HEARTBEAT_FILE, "w", encoding="utf-8") as f:
            f.write(f"watchdog alive at {datetime.datetime.now().isoformat()}\n")
            f.write(f"phase: {state.phase}\n")
            f.write(f"uptime: {int(time.time() - state.start_ts)}s\n")
            f.write(f"ch_done: {state.ch_done_ts}\n")
            f.write(f"pkms_started: {state.pkms_started_ts}\n")
            f.write(f"pkms_done: {state.pkms_done_ts}\n")
            f.write(f"zed_dead_since: {state.zed_dead_since}\n")
            f.write(f"seen_ntfy_ids_count: {len(state.seen_ntfy_ids)}\n")
    except Exception as e:
        log(f"heartbeat write failed: {e}", "WARN")


# ---------------------------------------------------------------------------
# ntfy
# ---------------------------------------------------------------------------
def ntfy_publish(body, title=None, tags=None):
    """Publish a message to the ntfy topic. Body must be a UTF-8 str."""
    url = f"{NTFY_BASE}/{TOPIC}"
    headers = {"Content-Type": "text/plain; charset=utf-8"}
    if title:
        headers["Title"] = title
    if tags:
        headers["Tags"] = tags
    data = body.encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status != 200:
                log(f"ntfy publish failed: status {resp.status}", "WARN")
    except Exception as e:
        log(f"ntfy publish error: {e}", "WARN")


def ntfy_poll():
    """Poll ntfy for messages from the last hour. Return list of (id, ts, msg) for new messages only."""
    url = f"{NTFY_BASE}/{TOPIC}/json?poll=1&since=3600"
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        log(f"ntfy poll error: {e}", "WARN")
        return []

    msgs = []
    for line in data.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("event") != "message":
            continue
        msg_id = obj.get("id")
        if msg_id is None or msg_id in state.seen_ntfy_ids:
            continue
        state.seen_ntfy_ids.add(msg_id)
        # cap the seen set to avoid unbounded growth over many days
        if len(state.seen_ntfy_ids) > 1000:
            # drop oldest ~half — simple, doesn't matter which
            state.seen_ntfy_ids = set(list(state.seen_ntfy_ids)[-500:])
        if state.first_ntfy_poll:
            # seed seen set, don't emit historical messages
            continue
        msgs.append((msg_id, obj.get("time"), obj.get("message", "")))

    state.first_ntfy_poll = False
    return msgs


# ---------------------------------------------------------------------------
# Process + file checks
# ---------------------------------------------------------------------------
def zed_alive():
    """Return True if at least one Zed.exe process is in tasklist."""
    try:
        result = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq Zed.exe", "/NH", "/FO", "CSV"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        out = result.stdout.strip()
        # /NH = no header. If Zed not running, output is
        # "INFO: No tasks are running which match the specified criteria."
        if out.startswith("INFO:"):
            return False
        return "Zed.exe" in out
    except Exception as e:
        log(f"tasklist check failed: {e}", "WARN")
        return True  # don't false-alarm on a transient subprocess error


def latest_mtime_in(dir_path):
    """Return the most recent mtime among files in dir_path (recursive).
    Skips __pycache__ / .pyc / .git so bytecode or git metadata doesn't mask a stall.
    None if missing/empty/unreadable."""
    if not dir_path.exists():
        return None
    latest = None
    try:
        for p in dir_path.rglob("*"):
            if not p.is_file():
                continue
            name = p.name
            if (
                name == "__pycache__"
                or name.endswith(".pyc")
                or p.parts[-2:][-1:] == (".git",)
            ):
                continue
            # also skip if any path component is __pycache__ or .git
            if any(c in ("__pycache__", ".git") for c in p.parts):
                continue
            try:
                m = p.stat().st_mtime
                if latest is None or m > latest:
                    latest = m
            except Exception:
                pass
    except Exception as e:
        log(f"mtime scan of {dir_path} failed: {e}", "WARN")
    return latest


# ---------------------------------------------------------------------------
# Event handlers
# ---------------------------------------------------------------------------
def handle_zed_alive_change(alive):
    now = datetime.datetime.now()
    if alive:
        if state.zed_dead_since is not None:
            dur = (now - state.zed_dead_since).total_seconds()
            log(f"Zed process came back. Was dead for {int(dur)}s", "WARN")
            ntfy_publish(
                f"Zed process came back after {int(dur)}s dead. Phase: {state.phase}",
                title="Zed revived",
                tags="warning",
            )
            state.zed_dead_since = None
    else:
        if state.zed_dead_since is None:
            state.zed_dead_since = now
            log("Zed process not found in tasklist", "ERROR")
            ntfy_publish(
                f"Zed process not found in tasklist. Phase: {state.phase}. Watchdog continuing to watch for revival.",
                title="Zed dead",
                tags="warning,fire",
            )


def handle_stall(label, dir_path, expected_phase):
    """Alert if dir_path's latest mtime is too old given the current phase."""
    # Startup grace — don't alert in the first STARTUP_GRACE seconds of watchdog life.
    # (Lets user start watchdog before kicking off CH bakeoff without false alarms.)
    if time.time() - state.start_ts < STARTUP_GRACE:
        return
    # In ch_done_pkms_pending, we ARE expecting PKMS to start writing — watch it.
    # In both_done/fatal, no writes expected.
    if state.phase in ("both_done", "fatal"):
        return

    # Determine whether this dir is expected to be active in the current phase.
    # ch_running          -> CH dirs active
    # ch_done_pkms_pending-> PKMS dirs should be coming alive (we still watch PKMS)
    # pkms_running        -> PKMS dirs active
    active_for = set()
    if state.phase == "ch_running":
        active_for = {"ch"}
    elif state.phase == "ch_done_pkms_pending":
        active_for = {"pkms"}  # PKMS should be starting
    elif state.phase == "pkms_running":
        active_for = {"pkms"}
    if expected_phase not in active_for:
        return

    latest = latest_mtime_in(dir_path)
    if latest is None:
        return  # dir doesn't exist yet or is empty — only stall if it should exist
    age = time.time() - latest
    if age > STALL_THRESHOLD:
        last_alert = state.last_stall_alert.get(label, 0)
        if time.time() - last_alert < STALL_ALERT_COOLDOWN:
            return
        state.last_stall_alert[label] = time.time()
        log(f"STALL: {label} ({dir_path}) no file write for {int(age)}s", "WARN")
        ntfy_publish(
            f"STALL: {label} no write for {int(age / 60)}min. Phase: {state.phase}",
            title=f"Stall: {label}",
            tags="warning",
        )


def handle_ntfy_message(msg):
    """Interpret a message from the bakeoff agents. Return 'exit' if both done."""
    # Skip our own echoed messages
    if msg.startswith(OWN_MSG_PREFIXES):
        return None
    if CH_DONE_TOKEN in msg:
        if state.phase == "ch_running":
            state.ch_done_ts = datetime.datetime.now()
            state.phase = "ch_done_pkms_pending"
            log(f"{CH_DONE_TOKEN} received. Waiting for PKMS to start.", "INFO")
            ntfy_publish(
                "CH done received. Watchdog expects PKMS to start within 10min.",
                title="CH bakeoff done",
                tags="white_check_mark",
            )
        else:
            log(f"{CH_DONE_TOKEN} received in phase {state.phase} (unexpected)", "WARN")
    elif PKMS_DONE_TOKEN in msg:
        if state.phase == "pkms_running":
            state.pkms_done_ts = datetime.datetime.now()
            state.phase = "both_done"
            log(f"{PKMS_DONE_TOKEN} received. Both bakeoffs complete.", "INFO")
            ntfy_publish(
                "Both bakeoffs done. Watchdog exiting.",
                title="Both bakeoffs done",
                tags="white_check_mark,party_popper",
            )
            return "exit"
        else:
            log(
                f"{PKMS_DONE_TOKEN} received in phase {state.phase} (unexpected)",
                "WARN",
            )
    else:
        log(f"ntfy msg (uninterpreted): {msg}", "DEBUG")
    return None


def check_pkms_started():
    """Transition to pkms_running if PKMS dirs show fresh activity after ch_done."""
    if state.phase != "ch_done_pkms_pending":
        return
    pkms_bakeoff = latest_mtime_in(Path("K:/Projects/PKMS/bakeoff"))
    pkms_tests = latest_mtime_in(Path("K:/Projects/PKMS/tests"))
    now = time.time()
    if (pkms_bakeoff and now - pkms_bakeoff < STALL_THRESHOLD) or (
        pkms_tests and now - pkms_tests < STALL_THRESHOLD
    ):
        state.pkms_started_ts = datetime.datetime.now()
        state.phase = "pkms_running"
        log("PKMS activity detected. Transitioning to pkms_running.", "INFO")
        ntfy_publish("PKMS bakeoff started.", title="PKMS started", tags="rocket")


def check_pkms_startup_grace():
    """Alert if PKMS hasn't started within grace period after CH done."""
    if state.phase != "ch_done_pkms_pending" or state.ch_done_ts is None:
        return
    elapsed = (datetime.datetime.now() - state.ch_done_ts).total_seconds()
    if elapsed > PKMS_STARTUP_GRACE and state.pkms_started_ts is None:
        # only alert once per cooldown window
        last_alert = state.last_stall_alert.get("PKMS_startup", 0)
        if time.time() - last_alert < STALL_ALERT_COOLDOWN:
            return
        state.last_stall_alert["PKMS_startup"] = time.time()
        log(f"PKMS hasn't started {int(elapsed)}s after CH done", "ERROR")
        ntfy_publish(
            f"PKMS hasn't started {int(elapsed / 60)}min after CH done. Check standby session.",
            title="PKMS not started",
            tags="warning,fire",
        )


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log(f"Watchdog starting. Log: {LOG_FILE}", "INFO")
    log(f"Watching: Zed process + {[d[0] for d in WATCH_DIRS]}", "INFO")
    log(
        f"Initial phase: {state.phase} (CH bakeoff assumed already running or starting)",
        "INFO",
    )
    ntfy_publish(
        "Overnight bakeoff watchdog started. Watching Zed + bakeoff dirs.",
        title="Watchdog started",
        tags="dog,watch",
    )
    write_heartbeat()

    last_heartbeat = 0
    last_ntfy_poll = 0

    try:
        while state.phase not in ("both_done", "fatal"):
            now = time.time()

            # 1. Zed liveness
            alive = zed_alive()
            handle_zed_alive_change(alive)

            # 2. File mtimes / stalls
            for label, dir_path, expected_phase in WATCH_DIRS:
                handle_stall(label, dir_path, expected_phase)

            # 3. PKMS startup grace / transition
            if state.phase == "ch_done_pkms_pending":
                check_pkms_started()
                check_pkms_startup_grace()
                # re-check stalls AFTER the transition check, so a freshly-started
                # PKMS dir doesn't get a spurious stall alert from the pre-transition scan
                pass

            # 4. ntfy poll
            if now - last_ntfy_poll > NTFY_POLL_INTERVAL:
                last_ntfy_poll = now
                msgs = ntfy_poll()
                for msg_id, ts, msg in msgs:
                    log(f"ntfy msg: {msg}", "INFO")
                    result = handle_ntfy_message(msg)
                    if result == "exit":
                        write_heartbeat()
                        return

            # 5. heartbeat
            if now - last_heartbeat > HEARTBEAT_INTERVAL:
                last_heartbeat = now
                write_heartbeat()

            # 6. hourly ping (watchdog itself is alive)
            if now - state.last_hourly_ping > HOURLY_PING_INTERVAL:
                state.last_hourly_ping = now
                uptime = int(now - state.start_ts)
                ntfy_publish(
                    f"watchdog alive, uptime {uptime}s, phase {state.phase}",
                    title="Watchdog hourly",
                    tags="hourglass",
                )

            # 7. sleep
            time.sleep(POLL_INTERVAL)

    except KeyboardInterrupt:
        log("Watchdog stopped by Ctrl+C", "INFO")
        ntfy_publish("Watchdog stopped manually.", title="Watchdog stopped", tags="x")
    except Exception as e:
        log(f"Watchdog fatal: {e}", "ERROR")
        ntfy_publish(
            f"Watchdog fatal: {e}", title="Watchdog fatal", tags="warning,fire"
        )
        state.phase = "fatal"
    finally:
        write_heartbeat()
        log(f"Watchdog exiting. Final phase: {state.phase}", "INFO")


if __name__ == "__main__":
    main()
