#!/usr/bin/env python3
"""Run the Eclipse Paho interoperability suites against a running broker and
report an honest MQTT compatibility percentage.

The Paho suites (``client_test5.py`` for MQTT 5.0, ``client_test.py`` for MQTT
3.1.1) are ``unittest.TestCase`` classes whose ``__main__`` blocks parse argv
with getopt and call ``unittest.main()`` (which ``sys.exit()``s and prints no
machine-readable summary). We import each file as a module instead, set the
module-level globals the tests read (``host``/``port``/``topics``/... — normally
assigned only inside that ``__main__`` block) and run each ``Test`` method
**in its own subprocess with a hard timeout**.

Per-test subprocess isolation matters: the Paho clients do blocking waits with
no internal timeout, so a case where the broker never sends an expected packet
would otherwise hang the whole run, and a hung test would corrupt the
class-level shared clients (``aclient``/``bclient``) used by later tests. A
timed-out test is recorded as a (bounded) failure, keeping the run finite.

The reported percentage is the raw pass rate (passed / tests that ran). Cases
aedes intentionally does not satisfy yet are NOT removed from the denominator —
they are annotated as "expected" in the per-test table so the number stays
honest while reviewers still see why a case fails.

Pure standard library; no pip dependencies (the Paho suite ships its own MQTT
packet de/serialiser under ``interoperability/mqtt``).
"""

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import unittest


# Cases aedes intentionally does not (yet) satisfy. Keyed by protocol -> test
# name -> reason. These still count as failures in the raw %; they render with an
# "expected" marker and the reason in the per-test table.
EXPECTED_GAPS = {
    "v5": {
        "test_shared_subscriptions":
            "aedes advertises sharedSubscriptionAvailable=false "
            "(deferred until cluster-aware; lib/handlers/connect.js)",
        "test_flow_control1":
            "receiveMaximum is advertised but not yet enforced outbound (advisory; "
            "#829, deferred per #821)",
        # NOTE: test_flow_control2 is NOT listed here — it lives in HARNESS_LIMITED
        # below (skipped before the gap logic runs), so a duplicate entry here would
        # be unreachable. The receiveMaximum gap it probes is tracked via
        # test_flow_control1 above.
        "test_server_topic_alias":
            "broker-assigned (outbound) topic aliases are not implemented; inbound "
            "aliases work (#840 — spec-optional/MAY, deferred per #821)",
        "test_subscribe_identifiers":
            "a delivery matching multiple overlapping subscriptions echoes only one "
            "Subscription Identifier (#828 [MQTT-3.3.4-4] — deferred per #821)",
    },
    "v3": {},
}

PROTOCOL_LABEL = {"v5": "MQTT 5.0", "v3": "MQTT 3.1.1"}
TEST_FILES = {"v5": "client_test5.py", "v3": "client_test.py"}

# Tests the per-test runner cannot evaluate, independent of the broker under
# test. These are *excluded* from the denominator (rendered as skipped) because
# they also fail against the Eclipse Paho reference broker under this harness's
# per-test isolation — so a failure here says nothing about the broker. The
# underlying capability is still measured elsewhere where possible.
HARNESS_LIMITED = {
    "v5": {
        "test_flow_control2":
            "not evaluable under per-test isolation (reuses the persistent "
            "client id / background receiver the Paho suite only sets up in its "
            "single-process mode); the Paho reference broker also hangs it here. "
            "The receiveMaximum behaviour it probes is still measured by "
            "test_flow_control1.",
    },
    "v3": {},
}


def load_module(paho_dir, protocol):
    """Import a Paho test file as a uniquely-named module."""
    path = os.path.join(paho_dir, TEST_FILES[protocol])
    name = f"paho_{protocol}"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def set_globals(module, protocol, host, port):
    """Reproduce the module globals the suite's ``__main__`` block assigns.

    Values mirror each file's ``__main__`` block verbatim (including the v5
    ``client_test5/`` topic prefix) so results match a direct
    ``python3 client_testN.py --hostname H --port P`` run.

    This duplication is exactly what ``PAHO_REF`` (pinned in
    ``.github/workflows/mqtt-compat.yml``) protects: a Paho bump that renames or
    adds a module global the tests read would surface here as a ``NameError`` ->
    "error" status. When bumping the pin, re-check each suite's ``__main__`` block
    against this function.
    """
    module.host = host
    module.port = port
    module.nosubscribe_topics = ("test/nosubscribe",)
    if protocol == "v5":
        prefix = "client_test5/"
        names = ["TopicA", "TopicA/B", "Topic/C", "TopicA/C", "/TopicA"]
        wild = ["TopicA/+", "+/C", "#", "/#", "/+", "+/+", "TopicA/#"]
        module.topic_prefix = prefix
        module.topics = [prefix + t for t in names]
        module.wildtopics = [prefix + t for t in wild]
    else:
        module.topics = ("TopicA", "TopicA/B", "Topic/C", "TopicA/C", "/TopicA")
        module.wildtopics = ("TopicA/+", "+/C", "#", "/#", "/+", "+/+", "TopicA/#")


# Prefix the worker's JSON result so the parent can find it unambiguously. The
# Paho clients (and Python's interpreter shutdown) can emit stray stdout, so
# "the last line is the JSON" is not a safe contract — we scan for this sentinel
# instead, and a worker that prints after us still can't displace the result.
RESULT_SENTINEL = "__MQTT_COMPAT_RESULT__:"


def _last_line(text):
    """The final non-empty line of a traceback — the assertion/exception message."""
    lines = [ln.strip() for ln in (text or "").strip().splitlines() if ln.strip()]
    return lines[-1] if lines else ""


# --------------------------------------------------------------------------- #
# Worker: run a single test method in this process and print a JSON result.
# Status is derived from the result counters rather than per-test callbacks, so a
# setUpClass error (recorded against an _ErrorHolder, not the test method) is
# still attributed to this test instead of crashing the worker.
# --------------------------------------------------------------------------- #
def run_worker(args):
    module = load_module(args.paho, args.protocol)
    set_globals(module, args.protocol, args.host, args.port)
    suite = unittest.TestSuite([module.Test(args.test)])
    result = unittest.TestResult()
    suite.run(result)
    if result.skipped:
        status, message = "skip", result.skipped[0][1]
    elif result.failures:
        status, message = "fail", _last_line(result.failures[0][1])
    elif result.errors:
        status, message = "error", _last_line(result.errors[0][1])
    else:
        status, message = "pass", ""
    sys.stdout.write("\n" + RESULT_SENTINEL
                     + json.dumps({"status": status, "message": message}) + "\n")
    sys.stdout.flush()
    return 0


# --------------------------------------------------------------------------- #
# Parent: discover test names, run each in an isolated subprocess, aggregate.
# --------------------------------------------------------------------------- #
def run_one_subprocess(args, protocol, test_name):
    cmd = [
        sys.executable, os.path.abspath(__file__), "--worker",
        "--paho", args.paho, "--worker-protocol", protocol, "--test", test_name,
        "--host", args.host, "--port", str(args.port),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=args.timeout)
    except subprocess.TimeoutExpired:
        return ("timeout", f"exceeded {args.timeout}s timeout")
    # Find the sentinel-tagged result line (scan in reverse: last one wins if a
    # rerun ever printed more than once). Robust to arbitrary stray stdout before
    # or after it.
    line = next((ln[len(RESULT_SENTINEL):]
                 for ln in reversed(proc.stdout.splitlines())
                 if ln.startswith(RESULT_SENTINEL)), "")
    try:
        payload = json.loads(line)
        return (payload["status"], payload.get("message", ""))
    except (ValueError, KeyError):
        msg = (proc.stderr.strip().splitlines()[-1:] or ["worker produced no result"])[0]
        return ("error", msg[:200])


def run_protocol(args, protocol):
    module = load_module(args.paho, protocol)
    names = unittest.TestLoader().getTestCaseNames(module.Test)
    print(f"\n=== {PROTOCOL_LABEL[protocol]}: {len(names)} tests ===", file=sys.stderr)

    gaps = EXPECTED_GAPS.get(protocol, {})
    limited = HARNESS_LIMITED.get(protocol, {})
    results = []
    passed = ran = 0
    for name in names:
        if name in limited:
            print(f"  {name}: skipped (harness-limited)", file=sys.stderr)
            results.append({"name": name, "status": "skip",
                            "expected_gap": False, "note": limited[name]})
            continue
        status, message = run_one_subprocess(args, protocol, name)
        print(f"  {name}: {status}", file=sys.stderr)
        if status == "skip":
            results.append({"name": name, "status": status,
                            "expected_gap": False, "note": message})
            continue
        ran += 1
        if status == "pass":
            passed += 1
        # A test listed in EXPECTED_GAPS that now PASSES is an "unexpected pass":
        # the underlying feature was implemented (v5 is a work in progress), so the
        # gap annotation is stale and EXPECTED_GAPS must be updated.
        unexpected_pass = status == "pass" and name in gaps
        is_gap = name in gaps and status != "pass"
        if unexpected_pass:
            note = ("was an expected gap but now PASSES — remove it from "
                    "EXPECTED_GAPS in tools/mqtt-compat/run_compat.py")
        elif status == "pass":
            note = ""
        elif is_gap:
            note = gaps[name]
        else:
            note = message
        results.append({
            "name": name,
            "status": status,
            "expected_gap": is_gap,
            "unexpected_pass": unexpected_pass,
            "note": note,
        })

    percentage = round(100 * passed / ran) if ran else 0
    return {
        "protocol": protocol,
        "label": PROTOCOL_LABEL[protocol],
        "passed": passed,
        "total": ran,
        "skipped": len(names) - ran,
        "percentage": percentage,
        "results": results,
    }


STATUS_ICON = {"pass": "✅", "fail": "❌", "error": "💥", "timeout": "⏱️", "skip": "⏭️"}


def render_markdown(reports):
    lines = [
        "## 📊 MQTT Compatibility Report",
        "",
        "Aedes tested against the "
        "[Eclipse Paho interoperability suite]"
        "(https://github.com/eclipse-paho/paho.mqtt.testing) "
        "(the vendor-neutral broker conformance suite used by Mosquitto, EMQX, mochi-mqtt, …).",
        "",
        "| Protocol | Compatibility | Passed | Total |",
        "|----------|---------------|--------|-------|",
    ]
    for r in reports:
        lines.append(f"| {r['label']} | **{r['percentage']}%** | "
                     f"{r['passed']} | {r['total']} |")
    lines.append("")

    # Surface unexpected passes (a known gap that now works) prominently: v5 is a
    # work in progress, so this means a feature got implemented and the gap list is
    # now stale.
    xpass = [(r["label"], t["name"]) for r in reports for t in r["results"]
             if t.get("unexpected_pass")]
    if xpass:
        listed = ", ".join(f"`{name}` ({label})" for label, name in xpass)
        lines += [
            f"> 🎉 **{len(xpass)} test(s) marked as an expected gap now PASS:** {listed}.",
            ">",
            "> A previously-unsupported feature now works. Please update "
            "`EXPECTED_GAPS` in `tools/mqtt-compat/run_compat.py` so it is no longer "
            "treated as a known failure.",
            "",
        ]

    for r in reports:
        gaps = sum(1 for t in r["results"] if t["expected_gap"])
        summary = f"{r['label']} — {r['passed']}/{r['total']} passed"
        if gaps:
            summary += f" ({gaps} expected gap{'s' if gaps != 1 else ''})"
        lines += [f"<details><summary>{summary}</summary>", "",
                  "| Test | Result | Notes |", "|------|--------|-------|"]
        for t in r["results"]:
            cell = STATUS_ICON.get(t["status"], "❔")
            if t.get("unexpected_pass"):
                cell += " 🎉 update gaps"
            elif t["expected_gap"]:
                cell += " ⚠️ expected"
            note = t["note"].replace("|", "\\|") if t["note"] else ""
            lines.append(f"| `{t['name']}` | {cell} | {note} |")
        lines += ["", "</details>", ""]

    lines.append("<sub>⚠️ expected = a feature aedes intentionally does not "
                 "implement yet, counted as a failure in the raw percentage. "
                 "🎉 update gaps = an expected gap that now passes — update "
                 "`EXPECTED_GAPS`.</sub>")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paho", required=True,
                        help="path to paho.mqtt.testing/interoperability")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=1883)
    parser.add_argument("--out", default="report.md", help="Markdown report path")
    parser.add_argument("--json", dest="json_out", default="result.json",
                        help="machine-readable JSON path")
    parser.add_argument("--protocols", default="v5,v3",
                        help="comma-separated subset of: v5,v3")
    parser.add_argument("--timeout", type=int, default=45,
                        help="per-test timeout in seconds")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    # Internal worker flag; named distinctly from the public --protocols to avoid a
    # one-character-off mix-up. dest=protocol keeps run_worker reading args.protocol.
    parser.add_argument("--worker-protocol", dest="protocol", help=argparse.SUPPRESS)
    parser.add_argument("--test", help=argparse.SUPPRESS)
    args = parser.parse_args()

    # The suite imports its own `mqtt` package relative to the interoperability dir.
    sys.path.insert(0, os.path.abspath(args.paho))

    if args.worker:
        sys.exit(run_worker(args))

    reports = [run_protocol(args, p.strip())
               for p in args.protocols.split(",") if p.strip()]

    markdown = render_markdown(reports)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(markdown + "\n")
    with open(args.json_out, "w", encoding="utf-8") as fh:
        json.dump({"protocols": reports}, fh, indent=2)

    for r in reports:
        print(f"{r['label']}: {r['percentage']}% ({r['passed']}/{r['total']})",
              file=sys.stderr)

    # CI-agnostic signal for "expected gap now passes" so the workflow can turn it
    # into a warning annotation without re-parsing the report.
    xpass = [(r["label"], t["name"]) for r in reports for t in r["results"]
             if t.get("unexpected_pass")]
    if xpass:
        listed = ", ".join(f"{name} ({label})" for label, name in xpass)
        print(f"UNEXPECTED_PASS: {listed}", file=sys.stderr)
        print("These tests are in EXPECTED_GAPS but now pass; update "
              "tools/mqtt-compat/run_compat.py.", file=sys.stderr)


if __name__ == "__main__":
    main()
