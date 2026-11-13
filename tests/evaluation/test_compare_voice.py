"""Checks for reporting actual observed voice attempts, including failures."""

import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "compare_voice", Path(__file__).parents[2] / "scripts/compare_voice.py"
)
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


def attempt(arm, run, status="success", **metrics):
    return {
        "arm": arm,
        "case_id": "en-order",
        "run_id": run,
        "measurement": "automatic",
        "outcome": status,
        "intervals_ms": metrics,
        "quality": {"scope": "unreviewed", "task": "pass"},
    }


def test_missing_stages_remain_unmeasured_and_failures_are_counted():
    report = comparison.summarize(
        [
            attempt(
                "baseline",
                "1",
                utterance_end_to_first_audible=500,
                vad_stop_to_transcript_complete=150,
            ),
            attempt("baseline", "2", "timeout"),
            attempt("live", "1", utterance_end_to_first_audible=400),
        ]
    )
    assert report["baseline"]["outcomes"] == {
        "success": 1,
        "error": 0,
        "timeout": 1,
        "cancelled": 0,
    }
    assert report["live"]["intervals_ms"]["vad_stop_to_transcript_complete"]["p50"] is None
    assert report["live"]["intervals_ms"]["utterance_end_to_first_audible"]["n"] == 1
    assert report["live"]["quality"]["scope"]["unreviewed"] == 1
    assert report["baseline"]["intervals_ms"]["utterance_end_to_first_audible"]["p95"] == 500
    assert (
        report["baseline"]["intervals_ms"]["utterance_end_to_first_audible"]["small_sample"] is True
    )


def test_rejects_duplicate_or_invalid_measurements():
    a = attempt("baseline", "1", utterance_end_to_first_audible=10)
    with pytest.raises(ValueError, match="duplicate"):
        comparison.summarize([a, a])
    with pytest.raises(ValueError, match="interval"):
        comparison.summarize([attempt("live", "1", scope_request_to_result=-1)])
    with pytest.raises(ValueError, match="quality"):
        comparison.summarize([{**a, "quality": {"scope": True}}])


def test_pairing_and_out_of_order_intervals_are_not_silently_hidden():
    baseline = attempt("baseline", "1", vad_stop_to_transcript_complete=None)
    baseline["invalid_intervals"] = ["vad_stop_to_transcript_complete"]
    live = attempt("live", "1")
    report = comparison.summarize([baseline, live, attempt("live", "2")])
    assert report["baseline"]["intervals_ms"]["vad_stop_to_transcript_complete"]["invalid"] == 1
    assert report["baseline"]["paired_attempts"] == 1
    assert report["live"]["unpaired_attempts"] == 1


def test_mixed_measurement_methods_and_unknown_intervals_are_rejected():
    baseline = {
        **attempt("baseline", "1", utterance_end_to_first_audible=50),
        "measurement": "automatic",
    }
    live = {
        **attempt("live", "1", utterance_end_to_first_audible=60),
        "measurement": "operator_estimated",
    }
    with pytest.raises(ValueError, match="mixed measurement"):
        comparison.summarize([baseline, live])
    with pytest.raises(ValueError, match="unknown interval"):
        comparison.summarize([attempt("baseline", "1", typo_metric=50)])
    with pytest.raises(ValueError, match="measurement"):
        comparison.summarize([{**baseline, "measurement": None}])
