from fastapi.testclient import TestClient

from customer_service.app import create_app


def test_customer_journey_and_ownership(tmp_path):
    with TestClient(create_app(tmp_path / "demo.sqlite3")) as client:
        session = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        headers = {"X-Session": session}
        order = client.post("/api/order", headers=headers, json={"order_id": "ord-a-100"})
        assert order.status_code == 200
        assert order.json()["status"] == "shipped"
        assert (
            client.post("/api/order", headers=headers, json={"order_id": "ord-b-200"}).status_code
            == 404
        )
        change = {"appointment_id": "appt-a-1", "slot_id": "slot-2"}
        proposal = client.post("/api/appointments/propose", headers=headers, json=change).json()
        confirm = {"confirmation_id": proposal["confirmation_id"], "idempotency_key": "retry-1"}
        first = client.post("/api/appointments/confirm", headers=headers, json=confirm)
        assert first.status_code == 200
        assert first.json()["slot_id"] == change["slot_id"]
        assert (
            client.post("/api/appointments/confirm", headers=headers, json=confirm).json()
            == first.json()
        )
        handoff = client.post(
            "/api/handoff",
            headers=headers,
            json={
                "issue": "Need help",
                "language": "en",
                "summary": "Order help",
                "idempotency_key": "help-1",
            },
        )
        assert handoff.status_code == 200
        assert "recorded locally" in handoff.json()["message"].lower()


def test_confirmation_expiry_replay_and_session_binding(tmp_path):
    now = [1000.0]
    with TestClient(create_app(tmp_path / "demo.sqlite3", clock=lambda: now[0])) as client:

        def session():
            return {
                "X-Session": client.post("/api/sessions", json={"customer_id": "cust-a"}).json()[
                    "session_id"
                ]
            }

        first, other = session(), session()
        request = {"appointment_id": "appt-a-1", "slot_id": "slot-2"}
        proposal = client.post("/api/appointments/propose", headers=first, json=request).json()
        confirm = {"confirmation_id": proposal["confirmation_id"], "idempotency_key": "same-key"}
        assert client.post("/api/appointments/confirm", headers=other, json=confirm).json() == {
            "error": "stale_confirmation"
        }
        committed = client.post("/api/appointments/confirm", headers=first, json=confirm).json()
        now[0] += 301
        assert (
            client.post("/api/appointments/confirm", headers=first, json=confirm).json()
            == committed
        )
        assert client.post("/api/appointments/confirm", headers=other, json=confirm).json() == {
            "error": "stale_confirmation"
        }
        assert client.post(
            "/api/appointments/confirm",
            headers=first,
            json={**confirm, "confirmation_id": "different"},
        ).json() == {"error": "idempotency_conflict"}
        noop = client.post("/api/appointments/propose", headers=first, json=request).json()
        assert noop == {
            "no_op": True,
            "appointment_id": "appt-a-1",
            "slot_id": "slot-2",
            "version": 2,
        }


def test_failed_and_rejected_proposals_do_not_change_state(tmp_path):
    path = tmp_path / "demo.sqlite3"
    now = [1000.0]
    with TestClient(create_app(path, clock=lambda: now[0])) as client:
        headers = {
            "X-Session": client.post("/api/sessions", json={"customer_id": "cust-a"}).json()[
                "session_id"
            ]
        }
        assert (
            client.post("/api/order", headers=headers, json={"order_id": "ord-b-200"}).json()
            == client.post("/api/order", headers=headers, json={"order_id": "missing"}).json()
            == {"error": "not_found"}
        )
        assert client.post(
            "/api/appointments/propose",
            headers=headers,
            json={"appointment_id": "appt-a-1", "slot_id": "slot-3"},
        ).json() == {"error": "unavailable"}
        data = {"appointment_id": "appt-a-1", "slot_id": "slot-2"}
        proposal = client.post("/api/appointments/propose", headers=headers, json=data).json()
        client.post(
            "/api/appointments/reject",
            headers=headers,
            json={"confirmation_id": proposal["confirmation_id"]},
        )
        assert client.post(
            "/api/appointments/confirm",
            headers=headers,
            json={"confirmation_id": proposal["confirmation_id"], "idempotency_key": "k1"},
        ).json() == {"error": "stale_confirmation"}
        proposal = client.post("/api/appointments/propose", headers=headers, json=data).json()
        now[0] += 301
        assert client.post(
            "/api/appointments/confirm",
            headers=headers,
            json={"confirmation_id": proposal["confirmation_id"], "idempotency_key": "k2"},
        ).json() == {"error": "stale_confirmation"}
    import sqlite3

    with sqlite3.connect(path) as db:
        assert db.execute(
            "SELECT slot,version FROM appointments WHERE id='appt-a-1'"
        ).fetchone() == ("slot-1", 1)
        assert db.execute("SELECT COUNT(*) FROM handoffs").fetchone()[0] == 0


def test_noop_invalidates_older_proposal(tmp_path):
    with TestClient(create_app(tmp_path / "demo.sqlite3")) as client:
        session = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        headers = {"X-Session": session}
        request = {"appointment_id": "appt-a-1", "slot_id": "slot-2"}
        proposal = client.post("/api/appointments/propose", headers=headers, json=request).json()
        noop = client.post(
            "/api/appointments/propose", headers=headers, json={**request, "slot_id": "slot-1"}
        ).json()
        assert noop["no_op"] is True
        response = client.post(
            "/api/appointments/confirm",
            headers=headers,
            json={"confirmation_id": proposal["confirmation_id"], "idempotency_key": "old"},
        )
        assert response.json() == {"error": "stale_confirmation"}


def test_unavailable_confirmation_stays_invalid_after_slot_becomes_free(tmp_path):
    with TestClient(create_app(tmp_path / "demo.sqlite3")) as client:

        def start(customer):
            token = client.post("/api/sessions", json={"customer_id": customer}).json()[
                "session_id"
            ]
            return {"X-Session": token}

        a, b = start("cust-a"), start("cust-b")
        pa = client.post(
            "/api/appointments/propose",
            headers=a,
            json={"appointment_id": "appt-a-1", "slot_id": "slot-2"},
        ).json()
        pb = client.post(
            "/api/appointments/propose",
            headers=b,
            json={"appointment_id": "appt-b-1", "slot_id": "slot-2"},
        ).json()
        assert (
            client.post(
                "/api/appointments/confirm",
                headers=b,
                json={"confirmation_id": pb["confirmation_id"], "idempotency_key": "b-1"},
            ).status_code
            == 200
        )
        confirm_a = {"confirmation_id": pa["confirmation_id"], "idempotency_key": "a-1"}
        assert client.post("/api/appointments/confirm", headers=a, json=confirm_a).json() == {
            "error": "unavailable"
        }
        free = client.post(
            "/api/appointments/propose",
            headers=b,
            json={"appointment_id": "appt-b-1", "slot_id": "slot-3"},
        ).json()
        assert (
            client.post(
                "/api/appointments/confirm",
                headers=b,
                json={"confirmation_id": free["confirmation_id"], "idempotency_key": "b-2"},
            ).status_code
            == 200
        )
        assert client.post("/api/appointments/confirm", headers=a, json=confirm_a).json() == {
            "error": "stale_confirmation"
        }


def test_expiry_and_version_staleness_invalidate_confirmation(tmp_path):
    now = [1000.0]
    with TestClient(create_app(tmp_path / "demo.sqlite3", clock=lambda: now[0])) as client:

        def start():
            token = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()[
                "session_id"
            ]
            return {"X-Session": token}

        a, b = start(), start()
        request = {"appointment_id": "appt-a-1", "slot_id": "slot-2"}
        expired = client.post("/api/appointments/propose", headers=a, json=request).json()
        payload = {"confirmation_id": expired["confirmation_id"], "idempotency_key": "expired"}
        now[0] += 301
        assert client.post("/api/appointments/confirm", headers=a, json=payload).json() == {
            "error": "stale_confirmation"
        }
        now[0] -= 301
        assert client.post("/api/appointments/confirm", headers=a, json=payload).json() == {
            "error": "stale_confirmation"
        }
        old = client.post("/api/appointments/propose", headers=a, json=request).json()
        winner = client.post("/api/appointments/propose", headers=b, json=request).json()
        assert (
            client.post(
                "/api/appointments/confirm",
                headers=b,
                json={"confirmation_id": winner["confirmation_id"], "idempotency_key": "winner"},
            ).status_code
            == 200
        )
        old_payload = {"confirmation_id": old["confirmation_id"], "idempotency_key": "old"}
        assert client.post("/api/appointments/confirm", headers=a, json=old_payload).json() == {
            "error": "stale_confirmation"
        }
        import sqlite3

        with sqlite3.connect(tmp_path / "demo.sqlite3") as db:
            assert db.execute(
                "SELECT active FROM confirmations WHERE id=?", (old["confirmation_id"],)
            ).fetchone() == (0,)
