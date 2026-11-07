import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "evaluate", Path(__file__).parents[2] / "scripts/evaluate.py"
)
evaluate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluate)


def test_checks_independent_expected_state_and_trace():
    case = {
        "expected": {
            "paths": ["/api/order"],
            "appointment_slot": "slot-1",
            "handoffs": 0,
            "status": "shipped",
        }
    }
    actual = {
        "trace": [{"path": "/api/order", "status": 200, "response": {"status": "shipped"}}],
        "appointment_slot": "slot-1",
        "handoffs": 0,
    }
    assert evaluate.check_case(case, actual) == []
    actual["appointment_slot"] = "slot-2"
    assert evaluate.check_case(case, actual)
    actual["appointment_slot"] = "slot-1"
    actual["trace"][0]["response"]["status"] = "processing"
    assert evaluate.check_case(case, actual)


def test_percentiles_and_empty_samples():
    assert evaluate.percentile([10, 20, 30, 40], 0.5) == 20
    assert evaluate.percentile([10, 20, 30, 40], 0.95) == 40
    assert evaluate.percentile([], 0.95) is None


def test_forbidden_claim_and_wrong_arguments_fail():
    case = {
        "expected": {
            "paths": ["/api/order"],
            "request_fields": [{"order_id": "ord-a-100"}],
            "appointment_slot": "slot-1",
            "handoffs": 0,
        }
    }
    actual = {
        "trace": [
            {
                "path": "/api/order",
                "request": {"order_id": "ord-b-200"},
                "response": {},
                "status": 200,
            }
        ],
        "appointment_slot": "slot-1",
        "handoffs": 0,
        "messages": ["A human has joined"],
    }
    assert len(evaluate.check_case(case, actual)) == 2
    actual["messages"] = ["Request recorded locally; no human was contacted."]
    actual["trace"][0]["request"]["order_id"] = "ord-a-100"
    assert evaluate.check_case(case, actual) == []


def test_missing_proposal_details_and_missing_visible_output_fail():
    case = {
        "expected": {
            "paths": [],
            "appointment_slot": "slot-1",
            "handoffs": 0,
            "visible_turn_fragments": [["appt-a-1", "slot-1", "slot-2", "2030-01-10T10:00:00Z"]],
        }
    }
    actual = {"trace": [], "appointment_slot": "slot-1", "handoffs": 0, "turn_messages": [[]]}
    assert len(evaluate.check_case(case, actual)) == 4
    actual["turn_messages"] = [["appt-a-1: slot-1 → slot-2, 2030-01-10T10:00:00Z"]]
    assert evaluate.check_case(case, actual) == []
