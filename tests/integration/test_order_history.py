"""Customer-scoped fictional order details remain safe across upgrades."""

import sqlite3

from fastapi.testclient import TestClient

from customer_service.app import create_app
from customer_service.tools import Store


def test_history_and_details_are_scoped_and_prices_are_consistent(tmp_path):
    with TestClient(create_app(tmp_path / "orders.sqlite")) as client:
        session = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        headers = {"X-Session": session}
        history = client.post("/api/orders", headers=headers, json={}).json()["orders"]
        assert len(history) == 25
        assert all(order["id"].startswith("ord-a-") for order in history)
        for order in history:
            assert order["currency"] == "INR"
            assert order["items"]
            assert order["total_paise"] == sum(
                item["quantity"] * item["unit_price_paise"] for item in order["items"]
            )
        response = client.post(
            "/api/order-details", headers=headers, json={"order_id": "ord-a-201"}
        )
        assert response.json() == next(order for order in history if order["id"] == "ord-a-201")
        foreign = client.post("/api/order-details", headers=headers, json={"order_id": "ord-b-201"})
        missing = client.post(
            "/api/order-details", headers=headers, json={"order_id": "ord-absent"}
        )
        assert foreign.status_code == missing.status_code == 404
        assert foreign.json() == missing.json()
        assert client.post("/api/orders", json={}).status_code == 401


def test_backfill_preserves_foreign_collision_and_existing_items(tmp_path):
    path = tmp_path / "legacy.sqlite"
    Store(path)
    with sqlite3.connect(path) as db:
        db.execute("DELETE FROM metadata WHERE key='synthetic-order-items-v1'")
        db.execute("DELETE FROM order_items WHERE order_id='ord-a-202'")
        db.execute("UPDATE orders SET customer='cust-b' WHERE id='ord-a-202'")
        db.execute("UPDATE order_items SET name='kept' WHERE order_id='ord-a-201' AND line=1")
    Store(path)
    with sqlite3.connect(path) as db:
        assert (
            db.execute("SELECT COUNT(*) FROM order_items WHERE order_id='ord-a-202'").fetchone()[0]
            == 0
        )
        assert (
            db.execute(
                "SELECT name FROM order_items WHERE order_id='ord-a-201' AND line=1"
            ).fetchone()[0]
            == "kept"
        )
