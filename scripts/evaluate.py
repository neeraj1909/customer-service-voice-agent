"""Run controlled-command cases through the real browser module and loopback API."""

import argparse
import collections
import hashlib
import json
import math
import os
import platform
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / "evals/cases.jsonl"


def percentile(values, quantile):
    if not values:
        return None
    return sorted(values)[max(0, math.ceil(quantile * len(values)) - 1)]


def check_case(case, actual):
    expected = case["expected"]
    trace = actual["trace"]
    failures = []
    for name, observed in (
        ("paths", [t["path"] for t in trace]),
        ("http_statuses", [t["status"] for t in trace]),
        ("appointment_slot", actual["appointment_slot"]),
        ("appointment_version", actual.get("appointment_version")),
        ("slot_2_occupant", actual.get("slot_2_occupant")),
        ("operation_count", actual.get("operation_count")),
        ("handoffs", actual["handoffs"]),
    ):
        if name in expected and expected[name] != observed:
            failures.append(f"{name}: expected {expected[name]!r}; got {observed!r}")
    for field in ("status", "error"):
        if field in expected and not any(
            t["response"].get(field) == expected[field] for t in trace
        ):
            failures.append(f"missing expected response {field}={expected[field]!r}")
    if "handoff_language" in expected and actual.get("handoff_languages") != [
        expected["handoff_language"]
    ]:
        failures.append("handoff language differs")
    for index, fields in enumerate(expected.get("request_fields", [])):
        if index >= len(trace) or any(
            trace[index]["request"].get(k) != v for k, v in fields.items()
        ):
            failures.append(f"request {index} arguments differ")
    if "other_appointment" in actual and actual["other_appointment"] != ["slot-3", 1]:
        failures.append("other customer appointment mutated")
    for index, fragments in enumerate(expected.get("visible_turn_fragments", [])):
        turns = actual.get("turn_messages", [])
        visible = " ".join(turns[index]).casefold() if index < len(turns) else ""
        for fragment in fragments:
            if fragment.casefold() not in visible:
                failures.append(f"turn {index} missing visible fragment {fragment!r}")
    for forbidden in expected.get("forbidden_response_values", []):
        if any(forbidden in json.dumps(t["response"], ensure_ascii=False) for t in trace):
            failures.append("foreign customer order disclosed")
    if (
        expected.get("responses_equal")
        and len(trace) >= 2
        and trace[0]["response"] != trace[1]["response"]
    ):
        failures.append("foreign and unknown responses differ")
    messages = " ".join(actual.get("messages", [])).lower()
    for claim in (
        "a human has joined",
        "human connected",
        "human was contacted",
        "a ticket was created",
    ):
        # Explicitly negated English wording is truthful.
        if claim in messages and f"no {claim}" not in messages:
            failures.append(f"unsupported human claim: {claim}")
    return failures


def run_case(case):
    with tempfile.TemporaryDirectory(prefix="voice-eval-") as tmp:
        db = Path(tmp) / "fixture.sqlite3"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        env = dict(os.environ, DEMO_DB=str(db))
        server = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "customer_service.app:create_app",
                "--factory",
                "--app-dir",
                "src",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--log-level",
                "warning",
            ],
            cwd=ROOT,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        base = f"http://127.0.0.1:{port}"
        try:
            deadline = time.monotonic() + 10
            while True:
                if server.poll() is not None:
                    raise RuntimeError(
                        f"local server exited during startup: {server.stderr.read().decode(errors='replace')}"
                    )
                try:
                    with urllib.request.urlopen(base + "/", timeout=0.5) as response:
                        if response.status == 200:
                            break
                except (urllib.error.URLError, TimeoutError):
                    if time.monotonic() >= deadline:
                        raise RuntimeError("local server startup timeout")
                    time.sleep(0.03)
            completed = subprocess.run(
                [
                    "node",
                    str(ROOT / "evals/driver.mjs"),
                    base,
                    json.dumps(case, ensure_ascii=False),
                ],
                capture_output=True,
                text=True,
                timeout=20,
                check=True,
                cwd=ROOT,
            )
            actual = json.loads(completed.stdout)
            with sqlite3.connect(db) as conn:
                appointment = conn.execute(
                    "SELECT slot,version FROM appointments WHERE id='appt-a-1'"
                ).fetchone()
                actual["appointment_slot"], actual["appointment_version"] = appointment
                occupied = conn.execute(
                    "SELECT id FROM appointments WHERE slot='slot-2'"
                ).fetchone()
                actual["slot_2_occupant"] = occupied[0] if occupied else None
                rows = conn.execute("SELECT language FROM handoffs ORDER BY rowid").fetchall()
                actual["other_appointment"] = list(
                    conn.execute(
                        "SELECT slot,version FROM appointments WHERE id='appt-b-1'"
                    ).fetchone()
                )
                actual["operation_count"] = conn.execute(
                    "SELECT COUNT(*) FROM operations"
                ).fetchone()[0]
                actual["handoffs"] = len(rows)
                actual["handoff_languages"] = [row[0] for row in rows]
            return actual
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
            if server.stderr:
                server.stderr.close()


def source_hashes():
    paths = [
        ROOT / "web/conversation.mjs",
        ROOT / "evals/driver.mjs",
        ROOT / "scripts/evaluate.py",
        ROOT / "pyproject.toml",
        ROOT / "uv.lock",
        ROOT / "src/customer_service/fixtures/orders.json",
    ]
    paths.extend(sorted((ROOT / "src/customer_service").glob("*.py")))
    return {
        str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=CASES)
    parser.add_argument("--output", type=Path, help="Write report JSON here as well as stdout")
    args = parser.parse_args()
    raw = args.cases.read_bytes()
    cases = [json.loads(line) for line in raw.decode().splitlines() if line.strip()]
    if not cases or len({case["id"] for case in cases}) != len(cases):
        raise ValueError("cases must be nonempty with unique IDs")
    starting_hashes = source_hashes()
    results = []
    for case in cases:
        try:
            actual = run_case(case)
            failures = check_case(case, actual)
        except (
            OSError,
            RuntimeError,
            subprocess.SubprocessError,
            sqlite3.Error,
            ValueError,
        ) as exc:
            actual = {"trace": [], "durations_ms": []}
            failures = [f"execution error: {type(exc).__name__}: {exc}"]
        results.append(
            {
                "id": case["id"],
                "language": case["language"],
                "scenario": case["scenario"],
                "passed": not failures,
                "failures": failures,
                "language_review": "unreviewed",
                "actual": actual,
            }
        )
    by_language = {}
    for language in sorted({r["language"] for r in results}):
        group = [r for r in results if r["language"] == language]
        by_language[language] = {
            "passed": sum(r["passed"] for r in group),
            "total": len(group),
            "unreviewed": len(group),
        }
    samples = [ms for r in results for ms in r["actual"].get("durations_ms", [])]
    revision = (
        subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        ).stdout.strip()
        or None
    )
    git_status = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=5,
    )
    final_hashes = source_hashes()
    sources_changed = starting_hashes != final_hashes
    report = {
        "version": 1,
        "mode": "controlled-text-loopback",
        "case_sha256": hashlib.sha256(raw).hexdigest(),
        "revision": revision,
        "git_dirty": bool(git_status.stdout.strip()) if git_status.returncode == 0 else None,
        "source_sha256": starting_hashes,
        "sources_changed_during_run": sources_changed,
        "environment": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "node": subprocess.run(
                ["node", "--version"], capture_output=True, text=True, check=False, timeout=5
            ).stdout.strip(),
        },
        "timing": {
            "boundary": "Node monotonic send(command) to completion including loopback HTTP; excludes app startup",
            "unit": "ms",
            "sample_count": len(samples),
            "p50": percentile(samples, 0.5),
            "p95": percentile(samples, 0.95),
            "conditions": "fresh server and seeded database per case; sequential turns, unclassified cold/warm",
        },
        "summary": {
            "passed": sum(r["passed"] for r in results),
            "total": len(results),
            "failed": sum(not r["passed"] for r in results),
            "unreviewed_language": len(results),
            "by_language": by_language,
            "by_scenario": {
                scenario: {
                    "passed": sum(r["passed"] for r in results if r["scenario"] == scenario),
                    "total": count,
                }
                for scenario, count in collections.Counter(r["scenario"] for r in results).items()
            },
        },
        "results": results,
    }
    output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(output)
    print(output, end="")
    return 1 if report["summary"]["failed"] or sources_changed else 0


if __name__ == "__main__":
    raise SystemExit(main())
