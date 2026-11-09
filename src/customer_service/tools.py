"""SQLite-backed fictional tools. All mutations are transactionally scoped."""

import hashlib
import json
import logging
import re
import secrets
import sqlite3
import time
from collections import Counter
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path

FIXTURE_PATH = Path(__file__).with_name("fixtures") / "orders.json"
FIXTURE_SHA256 = "3ba3becab9be35e39a468c31b8da396c95938577c4e0de52fc473146b588cfbe"
FIXTURE_MARKER = "synthetic-orders-v1"
ITEMS_MARKER = "synthetic-order-items-v1"
# Products and amounts are fictional; money is stored as integer paise.
CATALOG = (
    ("Cotton T-shirt", 79900),
    ("Insulated water bottle", 54900),
    ("Wireless mouse", 89900),
    ("Notebook set", 29900),
    ("Canvas tote bag", 44900),
    ("Desk lamp", 129900),
    ("Coffee mug", 34900),
    ("USB-C cable", 39900),
)
logger = logging.getLogger(__name__)


def load_order_fixture():
    """Validate the complete, immutable static fixture before opening the database."""
    try:
        raw = FIXTURE_PATH.read_bytes()
        if hashlib.sha256(raw).hexdigest() != FIXTURE_SHA256:
            raise ValueError("synthetic order fixture hash mismatch")
        fixture = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("synthetic order fixture unavailable or invalid") from exc
    if not isinstance(fixture, dict) or fixture.get("schema_version") != 1:
        raise ValueError("invalid synthetic order fixture schema")
    rows = fixture.get("orders")
    if not isinstance(rows, list) or len(rows) != 48:
        raise ValueError("invalid synthetic order fixture count")
    seen = set()
    counts = Counter()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"id", "customer", "status"}:
            raise ValueError("invalid synthetic order fixture row")
        order_id, customer, status = row["id"], row["customer"], row["status"]
        if (
            not isinstance(order_id, str)
            or not valid_id(order_id)
            or not isinstance(customer, str)
            or customer not in {"cust-a", "cust-b"}
            or not order_id.startswith(f"ord-{customer[-1]}-")
            or order_id in {"ord-a-100", "ord-b-200"}
            or order_id in seen
            or not isinstance(status, str)
            or status not in {"processing", "shipped", "delivered"}
        ):
            raise ValueError("invalid synthetic order fixture values")
        seen.add(order_id)
        counts[(customer, status)] += 1
    if any(
        counts[(customer, status)] != 8
        for customer in ("cust-a", "cust-b")
        for status in ("processing", "shipped", "delivered")
    ):
        raise ValueError("invalid synthetic order fixture distribution")
    return rows


class ToolError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def valid_id(value: str, limit: int = 80) -> bool:
    return bool(re.fullmatch(rf"[A-Za-z0-9-]{{1,{limit}}}", value))


class Store:
    def __init__(self, path: Path, clock: Callable[[], float] = time.time):
        self.path, self.clock = path, clock
        orders = load_order_fixture()
        collisions = 0
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, customer TEXT NOT NULL, status TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS order_items(
                    order_id TEXT NOT NULL REFERENCES orders(id), line INTEGER NOT NULL,
                    name TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price_paise INTEGER NOT NULL,
                    PRIMARY KEY(order_id, line));
                CREATE TABLE IF NOT EXISTS slots(id TEXT PRIMARY KEY, time_utc TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS appointments(id TEXT PRIMARY KEY, customer TEXT NOT NULL,
                    slot TEXT NOT NULL UNIQUE REFERENCES slots(id), version INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS confirmations(id TEXT PRIMARY KEY, session TEXT NOT NULL,
                    customer TEXT NOT NULL, appointment TEXT NOT NULL, original_slot TEXT NOT NULL,
                    version INTEGER NOT NULL, target_slot TEXT NOT NULL, expires REAL NOT NULL, active INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS operations(session TEXT NOT NULL, customer TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(session, customer, kind, key));
                CREATE TABLE IF NOT EXISTS handoffs(id TEXT PRIMARY KEY, session TEXT NOT NULL,
                    customer TEXT NOT NULL, issue TEXT NOT NULL, language TEXT NOT NULL, summary TEXT NOT NULL);
            """)
            # executescript completes DDL before beginning the serialized seed transaction.
            db.execute("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY)")
            db.execute("BEGIN IMMEDIATE")
            # Seed only once; never restore changed state on restart.
            if not db.execute("SELECT 1 FROM metadata WHERE key='seeded'").fetchone():
                db.executemany(
                    "INSERT INTO slots VALUES (?, ?)",
                    [
                        ("slot-1", "2030-01-10T09:00:00Z"),
                        ("slot-2", "2030-01-10T10:00:00Z"),
                        ("slot-3", "2030-01-10T11:00:00Z"),
                    ],
                )
                db.executemany(
                    "INSERT INTO orders VALUES (?, ?, ?)",
                    [("ord-a-100", "cust-a", "shipped"), ("ord-b-200", "cust-b", "processing")],
                )
                db.executemany(
                    "INSERT INTO appointments VALUES (?, ?, ?, ?)",
                    [("appt-a-1", "cust-a", "slot-1", 1), ("appt-b-1", "cust-b", "slot-3", 1)],
                )
                db.execute("INSERT INTO metadata VALUES ('seeded')")
            if not db.execute("SELECT 1 FROM metadata WHERE key=?", (FIXTURE_MARKER,)).fetchone():
                for order in orders:
                    inserted = db.execute(
                        "INSERT INTO orders(id, customer, status) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
                        (order["id"], order["customer"], order["status"]),
                    )
                    if inserted.rowcount == 0:
                        collisions += 1
                db.execute("INSERT INTO metadata VALUES (?)", (FIXTURE_MARKER,))
            if not db.execute("SELECT 1 FROM metadata WHERE key=?", (ITEMS_MARKER,)).fetchone():
                # Backfill only matching fictional owners. Never overwrite existing lines.
                candidates = [
                    {"id": "ord-a-100", "customer": "cust-a"},
                    {"id": "ord-b-200", "customer": "cust-b"},
                    *orders,
                ]
                for index, order in enumerate(candidates):
                    if not db.execute(
                        "SELECT 1 FROM orders WHERE id=? AND customer=?",
                        (order["id"], order["customer"]),
                    ).fetchone():
                        continue
                    for line in range(1, 2 + index % 3):
                        name, unit_price = CATALOG[(index + line - 1) % len(CATALOG)]
                        quantity = 1 + (index + line) % 2
                        db.execute(
                            "INSERT INTO order_items VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                            (order["id"], line, name, quantity, unit_price),
                        )
                db.execute("INSERT INTO metadata VALUES (?)", (ITEMS_MARKER,))
        if collisions:
            logger.warning(
                "Preserved %d existing order(s) colliding with synthetic fixture IDs", collisions
            )

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def require_id(value: str, limit: int = 80):
        if not valid_id(value, limit):
            raise ToolError("invalid_id")

    @staticmethod
    def appointment(db, customer, appointment_id):
        row = db.execute(
            "SELECT * FROM appointments WHERE id=? AND customer=?", (appointment_id, customer)
        ).fetchone()
        if row is None:
            raise ToolError("not_found")
        return row

    @staticmethod
    def replay(db, session, customer, kind, key, payload):
        fingerprint = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        prior = db.execute(
            "SELECT fingerprint,result FROM operations WHERE session=? AND customer=? AND kind=? AND key=?",
            (session, customer, kind, key),
        ).fetchone()
        if prior:
            if prior["fingerprint"] != fingerprint:
                raise ToolError("idempotency_conflict")
            return fingerprint, json.loads(prior["result"])
        return fingerprint, None

    @staticmethod
    def save_result(db, session, customer, kind, key, fingerprint, result):
        db.execute(
            "INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?)",
            (session, customer, kind, key, fingerprint, json.dumps(result)),
        )

    def order(self, customer, order_id):
        self.require_id(order_id)
        with self.connect() as db:
            row = db.execute(
                "SELECT id,status FROM orders WHERE id=? AND customer=?", (order_id, customer)
            ).fetchone()
            if not row:
                raise ToolError("not_found")
            return dict(row)

    def order_details(self, customer, order_id):
        self.require_id(order_id)
        with self.connect() as db:
            row = db.execute(
                "SELECT id,status FROM orders WHERE id=? AND customer=?", (order_id, customer)
            ).fetchone()
            if row is None:
                raise ToolError("not_found")
            rows = db.execute(
                "SELECT i.name, i.quantity, i.unit_price_paise FROM order_items i "
                "JOIN orders o ON o.id=i.order_id WHERE o.id=? AND o.customer=? ORDER BY i.line",
                (order_id, customer),
            ).fetchall()
        items = [dict(item) for item in rows]
        return {
            **dict(row),
            "currency": "INR",
            "items": items,
            "total_paise": sum(item["quantity"] * item["unit_price_paise"] for item in items)
            if items
            else None,
        }

    def order_history(self, customer):
        with self.connect() as db:
            ids = [
                row[0]
                for row in db.execute(
                    "SELECT id FROM orders WHERE customer=? ORDER BY id", (customer,)
                )
            ]
        return {"orders": [self.order_details(customer, order_id) for order_id in ids]}

    def slots(self, customer, appointment_id):
        self.require_id(appointment_id)
        with self.connect() as db:
            self.appointment(db, customer, appointment_id)
            return [
                dict(row)
                for row in db.execute(
                    "SELECT id,time_utc FROM slots WHERE id NOT IN (SELECT slot FROM appointments) ORDER BY time_utc"
                )
            ]

    def propose(self, session, customer, appointment_id, slot_id):
        self.require_id(appointment_id)
        self.require_id(slot_id)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            appt = self.appointment(db, customer, appointment_id)
            if appt["slot"] == slot_id:
                db.execute(
                    "UPDATE confirmations SET active=0 WHERE session=? AND appointment=?",
                    (session, appointment_id),
                )
                return {
                    "no_op": True,
                    "appointment_id": appointment_id,
                    "slot_id": slot_id,
                    "version": appt["version"],
                }
            slot = db.execute("SELECT * FROM slots WHERE id=?", (slot_id,)).fetchone()
            occupied = db.execute(
                "SELECT 1 FROM appointments WHERE slot=? AND id<>?", (slot_id, appointment_id)
            ).fetchone()
            if not slot or occupied:
                raise ToolError("unavailable")
            db.execute(
                "UPDATE confirmations SET active=0 WHERE session=? AND appointment=?",
                (session, appointment_id),
            )
            token = secrets.token_hex(16)
            expires = self.clock() + 300
            db.execute(
                "INSERT INTO confirmations VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
                (
                    token,
                    session,
                    customer,
                    appointment_id,
                    appt["slot"],
                    appt["version"],
                    slot_id,
                    expires,
                ),
            )
            return {
                "confirmation_id": token,
                "appointment_id": appointment_id,
                "original_slot": appt["slot"],
                "slot_id": slot_id,
                "time_utc": slot["time_utc"],
                "expires_at": expires,
            }

    def reject(self, session, confirmation_id):
        self.require_id(confirmation_id)
        with self.connect() as db:
            result = db.execute(
                "UPDATE confirmations SET active=0 WHERE id=? AND session=? AND active=1",
                (confirmation_id, session),
            )
            if not result.rowcount:
                raise ToolError("stale_confirmation")
            return {"rejected": True}

    def confirm(self, session, customer, confirmation_id, key):
        self.require_id(confirmation_id)
        self.require_id(key, 128)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            fingerprint, prior = self.replay(
                db,
                session,
                customer,
                "change",
                key,
                {"session": session, "confirmation_id": confirmation_id},
            )
            if prior is not None:
                return prior
            proposal = db.execute(
                "SELECT * FROM confirmations WHERE id=? AND session=? AND customer=?",
                (confirmation_id, session, customer),
            ).fetchone()
            if not proposal or not proposal["active"]:
                raise ToolError("stale_confirmation")

            def invalidate(code):
                # Preserve the invalidation even though the operation returns an error.
                db.execute("UPDATE confirmations SET active=0 WHERE id=?", (confirmation_id,))
                db.commit()
                raise ToolError(code)

            if proposal["expires"] <= self.clock():
                invalidate("stale_confirmation")
            appt = self.appointment(db, customer, proposal["appointment"])
            if appt["version"] != proposal["version"] or appt["slot"] != proposal["original_slot"]:
                invalidate("stale_confirmation")
            if db.execute(
                "SELECT 1 FROM appointments WHERE slot=? AND id<>?",
                (proposal["target_slot"], appt["id"]),
            ).fetchone():
                invalidate("unavailable")
            version = appt["version"] + (appt["slot"] != proposal["target_slot"])
            db.execute(
                "UPDATE appointments SET slot=?, version=? WHERE id=? AND customer=?",
                (proposal["target_slot"], version, appt["id"], customer),
            )
            db.execute("UPDATE confirmations SET active=0 WHERE id=?", (confirmation_id,))
            result = {
                "appointment_id": appt["id"],
                "slot_id": proposal["target_slot"],
                "version": version,
            }
            self.save_result(db, session, customer, "change", key, fingerprint, result)
            return result

    def handoff(self, session, customer, issue, language, summary, key):
        self.require_id(key, 128)
        if not issue.strip() or not summary.strip():
            raise ToolError("invalid_id")
        payload = {"session": session, "issue": issue, "language": language, "summary": summary}
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            fingerprint, prior = self.replay(db, session, customer, "handoff", key, payload)
            if prior is not None:
                return prior
            handoff_id = secrets.token_hex(16)
            db.execute(
                "INSERT INTO handoffs VALUES (?, ?, ?, ?, ?, ?)",
                (handoff_id, session, customer, issue, language, summary),
            )
            result = {
                "handoff_id": handoff_id,
                "message": "Request recorded locally. No human was contacted.",
            }
            self.save_result(db, session, customer, "handoff", key, fingerprint, result)
            return result
