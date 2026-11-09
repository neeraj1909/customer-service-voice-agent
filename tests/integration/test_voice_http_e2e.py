"""Real loopback signaling with an injected provider; no microphone or cloud calls."""

import os
import socket
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest


@pytest.fixture
def voice_http(tmp_path):
    runner = tmp_path / "voice_server.py"
    runner.write_text("""\
import os
from pathlib import Path
from customer_service.app import create_app

class FixtureProvider:
    def create(self, offer):
        assert offer.startswith(b'v=0')
        with open(os.environ['VOICE_EVENTS'], 'a') as f:
            f.write('create\\n')
        return 'fixture-call-1', b'v=0\\r\\nfixture-answer\\r\\n'

    def hangup(self, call_id):
        with open(os.environ['VOICE_EVENTS'], 'a') as f:
            f.write('hangup ' + call_id + '\\n')

app = create_app(Path(os.environ['DEMO_DB']), realtime_provider=FixtureProvider())
""")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    db = tmp_path / "voice.sqlite3"
    events = tmp_path / "events.txt"
    root = Path(__file__).resolve().parents[2]
    env = {
        **os.environ,
        "PYTHONPATH": f"{tmp_path}{os.pathsep}{root / 'src'}",
        "DEMO_DB": str(db),
        "VOICE_EVENTS": str(events),
        "REALTIME_ENABLED": "1",
        "OPENAI_API_KEY": "fixture-key-never-sent-to-provider",
    }
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "voice_server:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        env=env,
        cwd=root,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    client = httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=5)
    try:
        for _ in range(100):
            try:
                if client.get("/").status_code == 200:
                    break
            except httpx.ConnectError:
                if process.poll() is not None:
                    raise RuntimeError("voice fixture server exited")
                time.sleep(0.05)
        else:
            raise RuntimeError("voice fixture server did not start")
        yield client, db, events
    finally:
        client.close()
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stderr.close()


def test_voice_signaling_is_scoped_and_does_not_modify_business_state(voice_http):
    client, db, events = voice_http
    offer = b"v=0\r\nfixture-offer\r\n"
    headers = {"Content-Type": "application/sdp"}
    assert client.post("/api/realtime/call", headers=headers, content=offer).status_code == 401
    alice = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
    other = client.post("/api/sessions", json={"customer_id": "cust-b"}).json()["session_id"]
    mine = {**headers, "X-Session": alice}
    assert client.post("/api/realtime/call", headers=mine, content=b"bad").status_code == 400
    assert (
        client.post("/api/realtime/call", headers=mine, content=b"v=0" + b"x" * 200_000).status_code
        == 413
    )
    assert (
        client.post("/api/realtime/call", headers={"X-Session": alice}, content=offer).status_code
        == 415
    )
    assert not events.exists()
    response = client.post("/api/realtime/call", headers=mine, content=offer)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/sdp")
    assert response.content == b"v=0\r\nfixture-answer\r\n"
    call_id = response.headers["x-call-id"]
    assert call_id == "fixture-call-1"
    assert (
        client.post(
            "/api/order", headers={"X-Session": alice}, json={"order_id": "ord-a-100"}
        ).json()["status"]
        == "shipped"
    )
    foreign = client.post(
        "/api/order", headers={"X-Session": alice}, json={"order_id": "ord-b-200"}
    )
    missing = client.post(
        "/api/order", headers={"X-Session": alice}, json={"order_id": "not-an-order"}
    )
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json()
    assert (
        client.delete(f"/api/realtime/call/{call_id}", headers={"X-Session": other}).status_code
        == 404
    )
    assert events.read_text().splitlines() == ["create"]
    assert (
        client.delete(f"/api/realtime/call/{call_id}", headers={"X-Session": alice}).status_code
        == 204
    )
    assert events.read_text().splitlines() == ["create", "hangup fixture-call-1"]
    assert (
        client.delete(f"/api/realtime/call/{call_id}", headers={"X-Session": alice}).status_code
        == 204
    )
    assert (
        client.delete(f"/api/realtime/call/{call_id}", headers={"X-Session": other}).status_code
        == 404
    )
    assert events.read_text().splitlines() == ["create", "hangup fixture-call-1"]
    with sqlite3.connect(db) as connection:
        assert connection.execute("SELECT COUNT(*) FROM operations").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM handoffs").fetchone()[0] == 0
        assert connection.execute(
            "SELECT slot, version FROM appointments WHERE id='appt-a-1'"
        ).fetchone() == ("slot-1", 1)
