"""Summarize recorded voice attempts; this script does not run or judge voice calls.

Input JSON is an array of records exported by the voice metrics recorder, with
operator-added case_id, run_id and manually reviewed quality fields. Millisecond
intervals are client-observed boundaries, not internal model stage durations.
Each record must declare its measurement method; mixed methods for an interval
must be reported separately rather than combined into one percentile.
"""

import argparse
import collections
import json
import math
from pathlib import Path

ARMS = ("baseline", "live")
OUTCOMES = ("success", "error", "timeout", "cancelled")
MEASUREMENTS = ("automatic", "operator_estimated")
QUALITY = ("pass", "fail", "unreviewed")
INTERVALS = (
    "vad_stop_to_transcript_complete",
    "scope_request_to_result",
    "delete_request_to_ack",
    "response_request_to_output_started",
    "vad_stop_to_output_started",
    "tool_request_to_result",
    "utterance_end_to_first_audible",
    "utterance_end_to_first_useful_audible",
)


def percentile(values, q):
    return sorted(values)[max(0, math.ceil(q * len(values)) - 1)] if values else None


def summarize(attempts):
    if not isinstance(attempts, list):
        raise TypeError("attempts must be an array")
    seen = set()
    grouped = {arm: [] for arm in ARMS}
    for item in attempts:
        if not isinstance(item, dict) or item.get("arm") not in ARMS:
            raise ValueError("invalid attempt or arm")
        arm = item["arm"]
        case, run = item.get("case_id"), item.get("run_id")
        if not all(isinstance(x, str) and x.strip() for x in (case, run)):
            raise ValueError("case_id and run_id must be nonempty strings")
        identity = (arm, case, run)
        if identity in seen:
            raise ValueError("duplicate attempt")
        seen.add(identity)
        if item.get("outcome") not in OUTCOMES:
            raise ValueError("invalid outcome")
        if item.get("measurement") not in MEASUREMENTS:
            raise ValueError("invalid or missing measurement method")
        intervals = item.get("intervals_ms", {})
        if not isinstance(intervals, dict):
            raise TypeError("invalid intervals")
        if any(key not in INTERVALS for key in intervals):
            raise ValueError("unknown interval")
        invalid = item.get("invalid_intervals", [])
        if not isinstance(invalid, list) or any(
            key not in INTERVALS or intervals.get(key) is not None for key in invalid
        ):
            raise ValueError("invalid interval markers")
        for key, value in intervals.items():
            if value is not None and (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or value < 0
            ):
                raise ValueError(f"invalid interval: {key}")
        quality = item.get("quality", {})
        if not isinstance(quality, dict) or any(
            key not in ("scope", "task") or value not in QUALITY for key, value in quality.items()
        ):
            raise ValueError("invalid quality review")
        grouped[arm].append(item)

    for name in INTERVALS:
        methods = {
            item["measurement"]
            for item in attempts
            if item.get("intervals_ms", {}).get(name) is not None
        }
        if len(methods) > 1:
            raise ValueError(f"mixed measurement methods for {name}; report separately")

    report = {}
    for arm, group in grouped.items():
        outcomes = collections.Counter(item["outcome"] for item in group)
        metrics = {}
        for name in INTERVALS:
            values = [item.get("intervals_ms", {}).get(name) for item in group]
            values = [value for value in values if value is not None]
            metrics[name] = {
                "n": len(values),
                "measurement": next(
                    (
                        item["measurement"]
                        for item in group
                        if item.get("intervals_ms", {}).get(name) is not None
                    ),
                    None,
                ),
                "unmeasured": len(group) - len(values),
                "invalid": sum(name in item.get("invalid_intervals", []) for item in group),
                "p50": percentile(values, 0.5),
                "p95": percentile(values, 0.95),
                "small_sample": len(values) < 20,
            }
        quality_counts = {}
        for name in ("scope", "task"):
            counts = collections.Counter(
                item.get("quality", {}).get(name, "unreviewed") for item in group
            )
            quality_counts[name] = {result: counts[result] for result in QUALITY}
        other = "live" if arm == "baseline" else "baseline"
        paired = sum((other, item["case_id"], item["run_id"]) in seen for item in group)
        report[arm] = {
            "attempts": len(group),
            "paired_attempts": paired,
            "unpaired_attempts": len(group) - paired,
            "outcomes": {outcome: outcomes[outcome] for outcome in OUTCOMES},
            "intervals_ms": metrics,
            "quality": quality_counts,
        }
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="JSON array of recorded attempts")
    parser.add_argument("--output", type=Path, help="Optional output JSON path")
    args = parser.parse_args()
    attempts = json.loads(args.input.read_text())
    report = {
        "note": "Observed intervals across all outcomes; null means not measured. "
        "Percentiles with fewer than 20 samples are descriptive only. "
        "Event proxies are not model-internal stage timings.",
        "arms": summarize(attempts),
    }
    text = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.write_text(text)
    print(text, end="")


if __name__ == "__main__":
    main()
