# MQTT compatibility tests

Measures aedes's **actual** MQTT 5.0 and 3.1.1 protocol compatibility by running
the vendor-neutral [Eclipse Paho interoperability suite][paho] against a broker
booted from this repo, and reports an honest pass percentage. Wired into CI by
[`.github/workflows/mqtt-compat.yml`](../../.github/workflows/mqtt-compat.yml),
which posts the result as a sticky PR comment and a job summary.

Unlike `test/mqtt5.js` (which exercises aedes with the lenient `mqtt.js` client,
against our own reading of the spec), the Paho suite drives aedes with a strict,
independent client and its own packet de/serialiser — so it surfaces real interop
gaps our own tests can miss.

## Files

| File | Purpose |
|------|---------|
| `broker.js` | Boots aedes on a plain-TCP port (`MQTT_PORT`, default 1883) with the v5 capabilities the suite exercises enabled. |
| `run_compat.py` | Runs each Paho test in an isolated subprocess against the broker, emits `report.md` + `result.json`. Pure stdlib. |

## Running locally

```bash
# 1. Fetch the Paho suite (pin the SHA used in the workflow for reproducibility)
git clone https://github.com/eclipse-paho/paho.mqtt.testing /tmp/paho

# 2. Start the broker
MQTT_PORT=1883 node tools/mqtt-compat/broker.js &

# 3. Run the suites
python3 tools/mqtt-compat/run_compat.py \
  --paho /tmp/paho/interoperability \
  --host localhost --port 1883 \
  --out report.md --json result.json
```

`--protocols v5,v3` selects the suites; `--timeout` bounds each test (default 45s).

## How the score is computed

Each Paho `Test` method runs in its **own subprocess** with a hard timeout. This
matters because the Paho clients do blocking waits with no internal timeout: a
case where the broker never sends an expected packet would otherwise hang the
whole run, and a hung test would corrupt the class-level shared clients later
tests reuse. A timed-out test is recorded as a bounded failure.

The percentage is the raw pass rate (`passed / evaluated`). Two categories are
handled specially:

- **Expected gaps** (`EXPECTED_GAPS` in `run_compat.py`) — features aedes
  intentionally does not implement yet (e.g. shared subscriptions, which the
  broker advertises as `sharedSubscriptionAvailable=false`). These still count as
  failures; they are only annotated with the reason so the table is readable.
  Because v5 is a work in progress, the harness also detects the reverse: when an
  `EXPECTED_GAPS` test starts **passing** (the feature got implemented), the report
  highlights it with a 🎉 banner and the workflow emits a CI warning, prompting you
  to remove the now-stale entry from `EXPECTED_GAPS`.
- **Harness-limited** (`HARNESS_LIMITED`) — tests that cannot be evaluated under
  per-test isolation against *any* broker (currently only `test_flow_control2`,
  which depends on the persistent client the suite sets up only in single-process
  mode). These are **excluded** from the denominator. The capability they probe is
  still measured elsewhere (`test_flow_control1` for receive-maximum).

## Coverage scope — read the percentage correctly

The percentage is **"% of the Paho functional suite that passes"**, not
"% MQTT-5.0-compliant". The Paho suite is a third-party **happy-path functional**
test: it exercises the user-facing v5 features well (session expiry, will + will
delay, message expiry, RH/RAP/NL, request/response, payload format, assigned client
id, server keep alive, inbound topic aliases, max-packet-size rejection, PUBLISH
user properties), but it touches only 5 reason codes and deliberately omits large
parts of the spec:

- **Error / negative paths** — most of aedes's 19 reason codes (`lib/constants.js`):
  `0x87` not-authorized acks, `0x8E` session takeover, `0x82` protocol errors,
  `0x8C` bad auth method, `0x9E`, the CONNACK reject codes, broker-initiated
  DISCONNECT with ReasonString, the oversized-frame read latch, wildcard
  ResponseTopic rejection. These are covered by **`test/mqtt5.js`**, which is the
  authoritative place aedes's v5 error semantics are pinned.
- **Whole spec chapters** — AUTH / enhanced auth (§4.12), Server Reference
  (`0x9C`/`0x9D`), CONNACK capability flags, ReasonString round-trips, and
  UserProperty on non-PUBLISH packets. Some of these aedes does not implement; the
  test gap left by *both* suites is tracked in
  [#1096](https://github.com/moscajs/aedes/issues/1096).

So treat this workflow as the **cross-implementation functional gauge** and
`test/mqtt5.js` as the **gap-filler** — they are complementary, not redundant.

Some Paho failures are intentional aedes design decisions rather than bugs (see
`EXPECTED_GAPS`), and at least one is a genuine spec bug found by this suite:
[#1095](https://github.com/moscajs/aedes/issues/1095) (zero-length ClientId +
CleanSession=0 must be rejected on v3.1.1).

## Harness validation

The harness was validated against the Paho project's own fully-compliant
reference broker (`startbroker.py`): it scores **26/26** evaluated v5 tests
(100%, with `test_flow_control2` excluded as above). Every test aedes fails, the
reference broker passes under the identical harness — so a failure here reflects a
real difference between aedes and a spec-compliant broker, not a harness artifact.

[paho]: https://github.com/eclipse-paho/paho.mqtt.testing
