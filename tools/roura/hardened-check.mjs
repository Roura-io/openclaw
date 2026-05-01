// Standalone harness for src/roura/hardened.ts.
// Uses Node 25 --experimental-strip-types to import the TS source directly.
// Mirrors a subset of the vitest assertions in src/roura/hardened.test.ts.

import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the repo root from this file's location so the harness is
// portable across checkouts. tools/roura/hardened-check.mjs → repo root.
const __filename = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(__filename), "..", "..");
const mod = await import(path.join(repo, "src/roura/hardened.ts"));

const {
  isRouraHardenedMode,
  rouraSafeConfigOverrides,
  disabledPluginIds,
  disabledProviderIds,
  disabledEnvKeys,
  isPluginDisabledByRoura,
  isProviderDisabledByRoura,
  assertRouraBindAllowed,
  scrubEnvForHardenedMode,
  assertRouraAllows,
  hardenedModeSummary,
  RouraHardenedRefusal,
  refusedBindValues,
  allowedBindValues,
} = mod;

let pass = 0;
let fail = 0;
const failures = [];
function assert(name, cond) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(name);
    console.log("  FAIL:", name);
  }
}
function expectThrow(name, fn) {
  try {
    fn();
    fail += 1;
    failures.push(name);
    console.log("  FAIL (no throw):", name);
  } catch (e) {
    if (e instanceof RouraHardenedRefusal) {
      pass += 1;
    } else {
      fail += 1;
      failures.push(name);
      console.log("  FAIL (wrong type):", name, e?.message);
    }
  }
}

const HARDENED = { ROURA_HARDENED_MODE: "1" };
const UNSET = {};

// 1. flag detection
assert("flag unset → false", !isRouraHardenedMode(UNSET));
assert("flag '1' → true", isRouraHardenedMode(HARDENED));
assert("flag 'true' → true", isRouraHardenedMode({ ROURA_HARDENED_MODE: "true" }));
assert("flag 'YES' → true", isRouraHardenedMode({ ROURA_HARDENED_MODE: "YES" }));
assert("flag 'on' → true", isRouraHardenedMode({ ROURA_HARDENED_MODE: "on" }));
assert("flag '0' → false", !isRouraHardenedMode({ ROURA_HARDENED_MODE: "0" }));
assert("flag 'off' → false", !isRouraHardenedMode({ ROURA_HARDENED_MODE: "off" }));
assert("garbage → false", !isRouraHardenedMode({ ROURA_HARDENED_MODE: "maybe" }));
assert("whitespace '  1  ' → true", isRouraHardenedMode({ ROURA_HARDENED_MODE: "  1  " }));

// 2. denylists
for (const id of [
  "openshell", "bonjour", "webhooks", "browser",
  "voice-call", "talk-voice", "phone-control", "google-meet",
  "diagnostics-otel", "diagnostics-prometheus",
]) {
  assert(`disabledPluginIds includes ${id}`, disabledPluginIds.has(id));
}
for (const id of ["openai", "anthropic", "google", "openrouter", "deepseek"]) {
  assert(`disabledProviderIds includes ${id}`, disabledProviderIds.has(id));
}
for (const k of [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
]) {
  assert(`disabledEnvKeys includes ${k}`, disabledEnvKeys.has(k));
}

// 3. predicates
assert("plugin disabled when off → false", !isPluginDisabledByRoura("openshell", UNSET));
assert("plugin disabled when on → true", isPluginDisabledByRoura("openshell", HARDENED));
assert("safe plugin not disabled", !isPluginDisabledByRoura("active-memory", HARDENED));
assert("provider disabled when off → false", !isProviderDisabledByRoura("openai", UNSET));
assert("provider disabled when on → true", isProviderDisabledByRoura("openai", HARDENED));

// 4. bind
for (const b of allowedBindValues) {
  let threw = false;
  try { assertRouraBindAllowed(b, HARDENED); } catch { threw = true; }
  assert(`bind allows ${b}`, !threw);
}
for (const b of refusedBindValues) {
  expectThrow(`bind refuses ${b}`, () => assertRouraBindAllowed(b, HARDENED));
}
expectThrow("bind refuses unknown 192.168.1.1", () => assertRouraBindAllowed("192.168.1.1", HARDENED));
let threw = false;
try { assertRouraBindAllowed("0.0.0.0", UNSET); } catch { threw = true; }
assert("bind no-op when off", !threw);

// 5. env scrub
{
  const env = {
    ROURA_HARDENED_MODE: "1",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example",
    HTTP_PROXY: "http://proxy.example",
    KEEP_ME: "yes",
  };
  const removed = scrubEnvForHardenedMode(env);
  assert("scrub removed OTEL_EXPORTER_OTLP_ENDPOINT", removed.includes("OTEL_EXPORTER_OTLP_ENDPOINT"));
  assert("scrub removed HTTP_PROXY", removed.includes("HTTP_PROXY"));
  assert("scrub leaves unrelated keys", env.KEEP_ME === "yes");
  assert("scrub deleted env value", env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined);
}
{
  const env = { ROURA_HARDENED_MODE: "0", OTEL_EXPORTER_OTLP_ENDPOINT: "x" };
  const removed = scrubEnvForHardenedMode(env);
  assert("scrub no-op when off (return [])", removed.length === 0);
  assert("scrub no-op when off (key kept)", env.OTEL_EXPORTER_OTLP_ENDPOINT === "x");
}

// 6. assertRouraAllows
let allowsNoThrow = true;
try { assertRouraAllows("self-update", undefined, UNSET); } catch { allowsNoThrow = false; }
assert("assertRouraAllows no-op when off", allowsNoThrow);
for (const f of [
  "public-bind", "dotenv-secret-read", "self-update", "shell-execution",
  "cloud-provider-load", "telemetry-exporter", "background-cron",
]) {
  expectThrow(`assertRouraAllows refuses ${f}`, () => assertRouraAllows(f, undefined, HARDENED));
}

// 7. summary
{
  const off = hardenedModeSummary(UNSET);
  assert("summary disabled when off", off.enabled === false);
  assert("summary forced.gatewayBind null when off", off.forced.gatewayBind === null);
  const on = hardenedModeSummary(HARDENED);
  assert("summary enabled when on", on.enabled === true);
  assert("summary forced.gatewayBind = loopback when on", on.forced.gatewayBind === "loopback");
  assert("summary lists openshell", on.disabledPluginIds.includes("openshell"));
  assert("summary lists openai", on.disabledProviderIds.includes("openai"));
  assert("summary lists OTEL key", on.disabledEnvKeys.includes("OTEL_EXPORTER_OTLP_ENDPOINT"));
  const text = JSON.stringify(on);
  assert("summary has no xoxb-", !text.match(/xoxb-/));
  assert("summary has no xapp-", !text.match(/xapp-/));
}

// 8. overrides
{
  const off = rouraSafeConfigOverrides(UNSET);
  assert("overrides applied false when off", off.applied === false);
  const on = rouraSafeConfigOverrides(HARDENED);
  assert("overrides applied true when on", on.applied === true);
  assert("overrides bind=loopback", on.gatewayBind === "loopback");
  assert("overrides cloudEnabled=false", on.cloudEnabled === false);
  assert("overrides updateEnabled=false", on.updateEnabled === false);
  assert("overrides telemetryDisabled=true", on.telemetryDisabled === true);
}

console.log(`\nResults: ${pass} pass, ${fail} fail`);
if (fail) {
  console.log("Failures:", failures);
  process.exit(1);
}