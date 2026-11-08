"""Check a legacy database upgrade through actual loopback HTTP and SQLite."""

import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def post(opener, base, endpoint, body, session=None):
    headers = {"Content-Type": "application/json"}
    if session:
        headers["X-Session"] = session
    request = urllib.request.Request(
        base + endpoint, json.dumps(body).encode(), headers, method="POST"
    )
    try:
        with opener.open(request, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        return exc.code, json.load(exc)


def launch(db):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    env = dict(os.environ, DEMO_DB=str(db), PYTHONPATH=str(ROOT / "src"), LOCAL_AUDIO_ENABLED="0")
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "customer_service.app:create_app",
            "--factory",
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
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"server exited: {process.stderr.read().decode(errors='replace')}")
        try:
            with opener.open(base, timeout=0.5) as response:
                if response.status == 200:
                    return process, opener, base
        except (OSError, urllib.error.URLError):
            time.sleep(0.05)
    process.terminate()
    process.wait(timeout=5)
    raise RuntimeError("upgrade server startup timeout")


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    process.stderr.close()


def snapshot(db):
    with sqlite3.connect(db) as conn:
        return {
            table: conn.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
            for table in ("orders", "appointments", "handoffs", "operations", "metadata")
        }


def main():
    with tempfile.TemporaryDirectory(prefix="customer-upgrade-e2e-") as directory:
        db = Path(directory) / "legacy.sqlite3"
        # Model a previously seeded DB with an edited legacy order, a colliding
        # custom order and already committed service data. No user DB is read.
        with sqlite3.connect(db) as conn:
            conn.executescript("""
              CREATE TABLE orders(id TEXT PRIMARY KEY, customer TEXT NOT NULL, status TEXT NOT NULL);
              INSERT INTO orders VALUES ('ord-a-100','cust-a','legacy-edited');
              INSERT INTO orders VALUES ('ord-b-200','cust-b','processing');
              INSERT INTO orders VALUES ('ord-a-201','cust-a','custom-collision');
              CREATE TABLE metadata(key TEXT PRIMARY KEY);
              INSERT INTO metadata VALUES ('seeded');
              CREATE TABLE slots(id TEXT PRIMARY KEY,time_utc TEXT NOT NULL);
              INSERT INTO slots VALUES ('slot-1','2030-01-10T09:00:00Z'),('slot-2','2030-01-10T10:00:00Z'),('slot-3','2030-01-10T11:00:00Z');
              CREATE TABLE appointments(id TEXT PRIMARY KEY,customer TEXT NOT NULL,slot TEXT NOT NULL UNIQUE,version INTEGER NOT NULL);
              INSERT INTO appointments VALUES ('appt-a-1','cust-a','slot-2',2),('appt-b-1','cust-b','slot-3',1);
              CREATE TABLE handoffs(id TEXT PRIMARY KEY,session TEXT NOT NULL,customer TEXT NOT NULL,issue TEXT NOT NULL,language TEXT NOT NULL,summary TEXT NOT NULL);
              INSERT INTO handoffs VALUES ('old-handoff','old-session','cust-a','old issue','en','old summary');
              CREATE TABLE operations(session TEXT NOT NULL,customer TEXT NOT NULL,kind TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(session,customer,kind,key));
              INSERT INTO operations VALUES ('old-session','cust-a','handoff','old-key','old-fingerprint','{}');
            """)
        old = snapshot(db)
        process, opener, base = launch(db)
        try:
            session = post(opener, base, "/api/sessions", {"customer_id": "cust-a"})[1][
                "session_id"
            ]
            assert post(opener, base, "/api/order", {"order_id": "ord-a-201"}, session) == (
                200,
                {"id": "ord-a-201", "status": "custom-collision"},
            )
            assert post(opener, base, "/api/order", {"order_id": "ord-a-203"}, session) == (
                200,
                {"id": "ord-a-203", "status": "delivered"},
            )
            foreign = post(opener, base, "/api/order", {"order_id": "ord-b-201"}, session)
            unknown = post(opener, base, "/api/order", {"order_id": "ord-absent-999"}, session)
            assert foreign == unknown == (404, {"error": "not_found"})
        finally:
            stop(process)
        migrated = snapshot(db)
        assert len(migrated["orders"]) == 50
        for table in ("appointments", "handoffs", "operations"):
            assert migrated[table] == old[table], table
        assert ("ord-a-100", "cust-a", "legacy-edited") in migrated["orders"]
        assert ("ord-a-201", "cust-a", "custom-collision") in migrated["orders"]
        assert ("synthetic-orders-v1",) in migrated["metadata"]
        # A user edit after migration must persist across subsequent startups.
        with sqlite3.connect(db) as conn:
            conn.execute("UPDATE orders SET status='post-migration-edit' WHERE id='ord-a-203'")
        expected = snapshot(db)
        for _ in range(2):
            process, opener, base = launch(db)
            try:
                session = post(opener, base, "/api/sessions", {"customer_id": "cust-a"})[1][
                    "session_id"
                ]
                assert post(opener, base, "/api/order", {"order_id": "ord-a-203"}, session) == (
                    200,
                    {"id": "ord-a-203", "status": "post-migration-edit"},
                )
            finally:
                stop(process)
            assert snapshot(db) == expected
        print(
            "UPGRADE_E2E_PASS: legacy edits, collision and service state preserved; new orders visible; foreign 404; two restarts stable"
        )


if __name__ == "__main__":
    main()
