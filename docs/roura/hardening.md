# Roura Hardened Mode

> **Status:** Phase 28B — patch landed in the Roura fork. Hardened mode
> is opt-in via a single environment variable. Roura HQ
> (`flaco-hq`) is **not** integrated with this fork yet.

## What is hardened mode?

OpenClaw's upstream defaults are appropriate for an end-user assistant
on a personal device. They are **not** appropriate for any context
where Roura HQ would route Slack traffic into OpenClaw — Roura HQ
guarantees Keychain-only secrets, no public listeners, no cloud models
by default, no shell execution, no app-repo writes, and a single
audit trail.

Hardened mode is a single-flag switch that flips OpenClaw's defaults
to match Roura HQ's posture. It is **off by default** so upstream
behavior — and upstream tests — are unchanged.

## Activating it

```sh
ROURA_HARDENED_MODE=1 ./openclaw.mjs ...
```

Truthy values: `1`, `true`, `yes`, `on` (case-insensitive, with
optional whitespace). Anything else — including `0`, `false`, `no`,
`off`, garbage strings, and an unset variable — keeps hardened mode
**disabled**.

## What hardened mode does

Centralized in `src/roura/hardened.ts`. When the flag is on:

| Surface | Forced behavior |
| --- | --- |
| **Gateway bind** (`src/cli/gateway-cli/run.ts`) | Effective bind must be one of `loopback`, `127.0.0.1`, `::1`, `localhost`. Any other value (including `auto`, `lan`, `tailnet`, `custom`, `0.0.0.0`, `::`) refuses startup with exit code 2 and a `RouraHardenedRefusal`. |
| **Workspace `.env`** (`src/infra/dotenv.ts::loadWorkspaceDotEnvFile`) | No-op. Refuses to read any `.env` file in the working directory. |
| **Global runtime `.env`** (`src/infra/dotenv.ts::loadGlobalRuntimeDotEnvFiles`) | No-op. Refuses to read state-dir `.env` or `~/.config/openclaw/gateway.env`. |
| **`loadDotEnv()`** (`src/infra/dotenv.ts`) | No-op composite — both of the above are skipped together. |
| **State-dir `.env`** (`src/config/state-dir-dotenv.ts::readStateDirDotEnvVarsFromStateDir`) | Returns `{}`. The durable-service env precedence chain still works for non-`.env` sources. |
| **Self-update** (`src/infra/update-runner.ts::runGatewayUpdate`) | Returns `{ status: "skipped", reason: "Roura hardened mode: self-update is disabled" }`. No `git checkout`, `git rebase`, or process respawn happens. |
| **Plugin services** (`src/plugins/services.ts::startPluginServices`) | Skips any service whose plugin id (or service id) is in `disabledPluginIds` ∪ `disabledProviderIds`. Logs a warn line per skipped service. |
| **Telemetry / proxy env keys** (`src/plugins/services.ts`) | `OTEL_EXPORTER_OTLP_*`, `OTEL_RESOURCE_ATTRIBUTES`, `PROMETHEUS_PUSH_GATEWAY`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (and lowercase variants) are deleted from `process.env` once at startup. |

## What's disabled by id

The denylists are exported from `src/roura/hardened.ts` as
`disabledPluginIds`, `disabledProviderIds`, `disabledEnvKeys`,
`refusedBindValues`, and `allowedBindValues`. Current contents:

**`disabledPluginIds`** (auto-startup plugins that open external
surface or need an explicit Roura bridge to be safe):

```
openshell, bonjour, webhooks, browser, voice-call, talk-voice,
phone-control, google-meet, diagnostics-otel, diagnostics-prometheus,
device-pair, file-transfer, skill-workshop
```

**`disabledProviderIds`** (cloud-model providers — refused under
hardened mode regardless of upstream config):

```
openai, anthropic, anthropic-vertex, google, gemini, openrouter,
azure-speech, amazon-bedrock, amazon-bedrock-mantle, alibaba,
byteplus, cerebras, chutes, cloudflare-ai-gateway, cohere, deepinfra,
deepseek, fireworks, groq, huggingface, kilocode, kimi-coding,
litellm, lmstudio, microsoft-foundry, minimax, mistral, moonshot,
openai-compat, perplexity, together, togetherai, vertex, xai
```

**`disabledEnvKeys`** (scrubbed before plugin activation):

```
OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
OTEL_EXPORTER_OTLP_HEADERS, OTEL_EXPORTER_OTLP_PROTOCOL,
OTEL_RESOURCE_ATTRIBUTES, PROMETHEUS_PUSH_GATEWAY,
HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY,
http_proxy, https_proxy, all_proxy, no_proxy
```

**`refusedBindValues`** (gateway bind refuses these):

```
0.0.0.0, ::, auto, lan, tailnet, custom
```

**`allowedBindValues`** (gateway bind accepts these):

```
loopback, 127.0.0.1, ::1, localhost
```

## Public API of `src/roura/hardened.ts`

| Name | Signature | Purpose |
| --- | --- | --- |
| `isRouraHardenedMode(env?)` | `(env?: ProcessEnv) => boolean` | True iff `ROURA_HARDENED_MODE` is truthy. |
| `rouraSafeConfigOverrides(env?)` | `(env?) => { applied: boolean, … }` | Returns `{ applied: false }` when off; the full forced-config block when on. |
| `isPluginDisabledByRoura(id, env?)` | `(string \| undefined, env?) => boolean` | False when off. True when on AND id is denylisted. |
| `isProviderDisabledByRoura(id, env?)` | `(string \| undefined, env?) => boolean` | Like above, restricted to provider IDs. |
| `assertRouraBindAllowed(bind, env?)` | `(string?, env?) => void` | Throws `RouraHardenedRefusal` for anything outside `allowedBindValues` when on; no-op when off. |
| `scrubEnvForHardenedMode(env?)` | `(env?) => string[]` | Mutates `env`: deletes keys in `disabledEnvKeys`. Returns the keys removed. No-op when off. |
| `assertRouraAllows(feature, detail?, env?)` | refuses any feature when on | Used as an explicit `RouraHardenedRefusal` throw site. |
| `hardenedModeSummary(env?)` | snapshot for diagnostics | Safe to log — contains no secrets. |
| `RouraHardenedRefusal` | `class extends Error` | Carries `feature: RouraHardenedFeature`. |

## What is intentionally **not** wired in Phase 28B

These were considered and deferred to keep the patch minimal and
non-invasive:

- **Shell / subprocess guard.** OpenClaw uses ~1,196 distinct shell
  / `child_process` / PTY call sites across `src/`, `extensions/`,
  and `scripts/`. Hardened mode disables the auto-start `openshell`
  plugin (the most exposed surface) but does **not** add a global
  refusal hook. The Roura HQ adapter (Phase 28C) is responsible for
  ensuring no Slack-bound code path can reach a shell. Risk tracked
  in the audit doc.
- **Background cron / heartbeat.** `src/cron/active-jobs.ts` and
  `src/infra/heartbeat-runner.ts` schedule periodic work. Hardened
  mode disables the self-update path (the one user-visible cron
  effect) and the diagnostics exporters. The remaining periodic
  callbacks are local-only state-keeping. Phase 28C may revisit.
- **MCP / plugin loader allowlist.** Hardened mode currently denies
  by id. A more principled "default-deny + Roura allowlist" change
  belongs in the Roura HQ adapter where the allowlist is anchored to
  Roura's existing Slack policy engine, not inside the fork.
- **Roura HQ adapter / Slack bridge.** Phase 28C. Lives in
  `flaco-hq`, not here. Will use Roura HQ's `find_policy()` for
  authorization and audit cross-process calls as
  `origin="openclaw-bridge"`. No Slack token will ever be handed to
  OpenClaw.

## What hardened mode does **not** make safe

Hardened mode is a defense-in-depth flag, not a sandbox. **None of
these are safe even with the flag on**:

1. **Don't give OpenClaw the Roura HQ Slack token.**
   Roura HQ's Keychain service is `io.roura.flaco-hq.slack`. OpenClaw
   uses different services (`Codex Auth`, `claude-cli`). Keep them
   namespace-isolated. A future Roura adapter must talk to OpenClaw
   over IPC with no Slack token present in OpenClaw's process.
2. **Don't give OpenClaw write access to a Roura app repo.**
   Hardened mode does not constrain the OpenClaw working directory.
   The Phase 28C deployment runs OpenClaw under its own state dir
   (sandbox profile + `WorkingDirectory` outside any app-repo path)
   so even an exploited tool cannot reach a repo.
3. **Don't expose OpenClaw on a public network.**
   Hardened mode forces loopback bind. This is correct on a host —
   but in a container without Tailscale or a private network in
   front, the container's own networking can still expose loopback
   to other tenants. Run inside a private subnet only.
4. **Don't write a `.env` to dodge Keychain.**
   Hardened mode no-ops dotenv loaders. Adding a `.env` does
   nothing. Adding it as a workaround is a policy break — Roura's
   posture is that secrets only ever exist in macOS Keychain.

## Tests

The hardened module ships with a vitest unit-test file at
`src/roura/hardened.test.ts`. Coverage:

- flag detection (truthy / falsy / unset / case / whitespace)
- `rouraSafeConfigOverrides` shape (off / on)
- denylist contents
- predicate behavior (off / on; safe IDs not affected)
- bind allowlist semantics (allowed / refused / unknown)
- env scrub (off no-op; on removes; unrelated keys survive)
- `assertRouraAllows` for every feature
- summary shape, no secret-shaped strings
- default-off non-destructive guarantees

The Phase 28B harness at `tools` proves the same coverage runs
end-to-end without `pnpm install` (Node 25's `--experimental-strip-types`
is enough). When you eventually do `pnpm install` and `pnpm test`,
nothing in this module touches a network or filesystem so it runs in
~ms.

## How to run hardened-mode tests safely

This is the **only** safe Phase 28B verification path:

```sh
# 1. Pure-module standalone harness (no install required, Node 25+):
node --experimental-strip-types tools/roura/hardened-check.mjs

# 2. After pnpm install (when you're ready to run upstream's full
#    suite — outside the scope of Phase 28B):
pnpm install
node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.full-core-runtime.config.ts \
  src/roura/hardened.test.ts
```

**Do not** run `pnpm dev`, `pnpm start`, `pnpm test:e2e`,
`pnpm test:live`, or any `OPENCLAW_LIVE_*` test from this checkout
without an explicit Roura review. Several of those scripts touch the
network, start gateway listeners, or expect cloud credentials.

## Phase 28C plan (preview)

Lives in `flaco-hq`, not here:

1. New module `flaco/openclaw_bridge.py` with the same posture as
   `flaco/slack_runtime.py`: Keychain-only secrets, JSONL audit, no
   public listener, `find_policy()` gate.
2. `flaco-hq` learns to optionally launch a hardened OpenClaw
   instance under its own LaunchAgent. The two LaunchAgents are
   completely separate; OpenClaw's never has the Slack Keychain
   service in its environment.
3. Slack policy gains an `openclaw-bridge` agent name. Default
   policies do not admit it. Adding it for Christopher's `*`-policy
   DM only happens after a manual operator step.
4. Audit log entries originated by the bridge tag
   `origin="openclaw-bridge"` so they're distinguishable from `cli`,
   `tui-chat`, and `slack-socket`.
