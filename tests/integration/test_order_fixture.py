"""Additive synthetic orders preserve prior customer data."""

import sqlite3

from customer_service.tools import Store


def test_fresh_database_adds_synthetic_orders_without_changing_legacy(tmp_path):
    path = tmp_path / "data.sqlite3"
    store = Store(path)
    assert store.order("cust-a", "ord-a-203") == {"id": "ord-a-203", "status": "delivered"}
    assert store.order("cust-b", "ord-b-201") == {"id": "ord-b-201", "status": "processing"}
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT COUNT(*) FROM orders").fetchone() == (50,)
        assert db.execute("SELECT customer,status FROM orders WHERE id='ord-a-100'").fetchone() == (
            "cust-a",
            "shipped",
        )


def legacy_database(path):
    """Build the original layout, then keep synthetic upgrade unrun."""
    from customer_service.tools import FIXTURE_MARKER

    Store(path)
    with sqlite3.connect(path) as db:
        db.execute("DELETE FROM orders WHERE id NOT IN ('ord-a-100','ord-b-200')")
        db.execute("DELETE FROM metadata WHERE key=?", (FIXTURE_MARKER,))
        db.execute("UPDATE orders SET status='user-modified' WHERE id='ord-a-100'")
        db.execute("UPDATE appointments SET slot='slot-2', version=7 WHERE id='appt-a-1'")
        db.execute(
            "INSERT INTO handoffs VALUES ('h-existing','s-existing','cust-a','issue','en','summary')"
        )
        db.execute(
            "INSERT INTO operations VALUES ('s-existing','cust-a','handoff','existing','hash','{}')"
        )
        db.execute("INSERT INTO metadata VALUES ('user-metadata')")


def snapshot(path):
    with sqlite3.connect(path) as db:
        return {
            table: db.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
            for table in (
                "orders",
                "slots",
                "appointments",
                "handoffs",
                "operations",
                "confirmations",
                "metadata",
            )
        }


def test_legacy_upgrade_preserves_mutations_and_does_not_reseed(tmp_path):
    from customer_service.tools import FIXTURE_MARKER

    path = tmp_path / "legacy.sqlite3"
    legacy_database(path)
    before = snapshot(path)
    Store(path)
    upgraded = snapshot(path)
    for table in ("slots", "appointments", "handoffs", "operations", "confirmations"):
        assert upgraded[table] == before[table]
    assert all(row in upgraded["orders"] for row in before["orders"])
    assert all(row in upgraded["metadata"] for row in before["metadata"])
    assert (FIXTURE_MARKER,) in upgraded["metadata"]
    assert len(upgraded["orders"]) == 50
    with sqlite3.connect(path) as db:
        db.execute("UPDATE orders SET status='user-change' WHERE id='ord-a-201'")
        db.execute("DELETE FROM orders WHERE id='ord-a-202'")
    expected = snapshot(path)
    Store(path)
    assert snapshot(path) == expected


def test_existing_id_collision_is_preserved_and_diagnosed(tmp_path, caplog):
    from customer_service.tools import FIXTURE_MARKER

    path = tmp_path / "legacy.sqlite3"
    legacy_database(path)
    with sqlite3.connect(path) as db:
        db.execute("INSERT INTO orders VALUES ('ord-a-201', 'cust-b', 'user-status')")
    Store(path)
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT customer,status FROM orders WHERE id='ord-a-201'").fetchone() == (
            "cust-b",
            "user-status",
        )
        assert db.execute("SELECT COUNT(*) FROM orders").fetchone() == (50,)
        assert db.execute(
            "SELECT COUNT(*) FROM metadata WHERE key=?", (FIXTURE_MARKER,)
        ).fetchone() == (1,)
    assert "Preserved 1 existing order" in caplog.text
    assert "user-status" not in caplog.text


def test_storage_failure_rolls_back_all_fixture_inserts_and_marker(tmp_path):
    import pytest

    path = tmp_path / "legacy.sqlite3"
    legacy_database(path)
    with sqlite3.connect(path) as db:
        db.execute(
            "CREATE TRIGGER fail_upgrade BEFORE INSERT ON metadata WHEN NEW.key='synthetic-orders-v1' BEGIN SELECT RAISE(ABORT, 'injected'); END;"
        )
    before = snapshot(path)
    with pytest.raises(sqlite3.IntegrityError):
        Store(path)
    assert snapshot(path) == before
    with sqlite3.connect(path) as db:
        db.execute("DROP TRIGGER fail_upgrade")
    Store(path)
    assert len(snapshot(path)["orders"]) == 50


def test_malformed_fixture_fails_before_database_changes(tmp_path, monkeypatch):
    import hashlib
    import json

    import pytest

    from customer_service import tools

    path = tmp_path / "legacy.sqlite3"
    legacy_database(path)
    before = snapshot(path)
    fixture = json.loads(tools.FIXTURE_PATH.read_text())
    fixture["orders"][1] = dict(fixture["orders"][0])
    corrupt = tmp_path / "bad.json"
    corrupt.write_text(json.dumps(fixture))
    monkeypatch.setattr(tools, "FIXTURE_PATH", corrupt)
    monkeypatch.setattr(tools, "FIXTURE_SHA256", hashlib.sha256(corrupt.read_bytes()).hexdigest())
    with pytest.raises(ValueError, match="invalid synthetic"):
        Store(path)
    assert snapshot(path) == before


def test_concurrent_first_start_is_serialized(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from customer_service.tools import FIXTURE_MARKER

    path = tmp_path / "fresh.sqlite3"
    barrier = Barrier(6)

    def start(_):
        barrier.wait(timeout=5)
        return Store(path).order("cust-a", "ord-a-203")

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(start, range(6)))
    assert all(result == {"id": "ord-a-203", "status": "delivered"} for result in results)
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT COUNT(*) FROM orders").fetchone() == (50,)
        assert db.execute(
            "SELECT COUNT(*) FROM metadata WHERE key=?", (FIXTURE_MARKER,)
        ).fetchone() == (1,)


def test_new_order_lookup_keeps_cross_customer_and_missing_equivalent(tmp_path):
    from fastapi.testclient import TestClient

    from customer_service.app import create_app

    with TestClient(create_app(tmp_path / "data.sqlite3")) as client:
        token = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        headers = {"X-Session": token}
        own = client.post("/api/order", headers=headers, json={"order_id": "ord-a-203"})
        foreign = client.post("/api/order", headers=headers, json={"order_id": "ord-b-203"})
        missing = client.post(
            "/api/order", headers=headers, json={"order_id": "ord-does-not-exist"}
        )
        assert own.json() == {"id": "ord-a-203", "status": "delivered"}
        assert foreign.status_code == missing.status_code == 404
        assert foreign.json() == missing.json() == {"error": "not_found"}


def test_fixture_hash_mismatch_preserves_existing_data(tmp_path, monkeypatch):
    import pytest

    from customer_service import tools

    path = tmp_path / "legacy.sqlite3"
    legacy_database(path)
    before = snapshot(path)
    altered = tmp_path / "tampered.json"
    altered.write_bytes(tools.FIXTURE_PATH.read_bytes() + b" ")
    monkeypatch.setattr(tools, "FIXTURE_PATH", altered)
    with pytest.raises(ValueError, match="hash mismatch"):
        Store(path)
    assert snapshot(path) == before
