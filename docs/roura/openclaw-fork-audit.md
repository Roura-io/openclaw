# Roura Fork Audit — OpenClaw

**Status:** Phase 28A — audit / pin / planning only.
**Roura HQ runtime is NOT integrated with this fork.** This document
exists in the fork repo so it travels with the audited tree, separate
from the `flaco-hq` codebase.

## 1. Pin

| Field | Value |
| --- | --- |
| Upstream remote | `https://github.com/openclaw/openclaw` |
| Upstream license | MIT (Copyright (c) 2025 Peter Steinberger) |
| Roura fork | `https://github.com/Roura-io/openclaw` |
| Roura branch | `roura/main` |
| Pinned upstream SHA | `ed97d628686dbda62eccf0f388b1f55d1fe8a140` (`upstream/main` HEAD at audit time) |
| Local clone path | `/Users/roura.io/Documents/dev/ai/openclaw` |
| Default branch in fork | `main` (untouched; tracks origin/main) |
| Audit date | 2026-05-01 |
| Auditor identity | `elGordoRoura` |

`origin` points at `Roura-io/openclaw`. `upstream` points at
`openclaw/openclaw`. The two are kept distinct on purpose — no
`git pull upstream main` will run during this phase.

## 2. License + attribution

- Upstream is MIT-licensed. The `LICENSE` file at the repo root is
  preserved verbatim in the fork. Any future Roura-side code added to
  the fork must keep the MIT notice intact.
- README, CHANGELOG, CONTRIBUTING, SECURITY, and INCIDENT_RESPONSE
  files are preserved as-is.
- No upstream branding (logo SVGs, Discord links, openclaw.ai URLs)
  has been removed.

## 3. Project shape

- ~17,200 files at the pinned SHA.
- Top-level: TypeScript (~93 MB), JavaScript, Swift, Kotlin, Go,
  Python, Shell.
- Multi-target: `apps/{android,ios,macos,macos-mlx-tts,shared}` plus a
  Node/TypeScript core in `src/`, `packages/`, `extensions/`, `skills/`.
- Node engine: `>=22.14.0`. Package manager: `pnpm@10.33.2`.
- Apple side: `apps/macos/Package.swift` targets macOS 15, Swift 6.2,
  with `swift-subprocess`, `swift-log`, `MenuBarExtraAccess`. No Roura
  iOS SDK packages are referenced.
- Build/run entry: `openclaw.mjs` + `node scripts/build-all.mjs`.
- Container artifacts: `Dockerfile`, `Dockerfile.sandbox*`,
  `docker-compose.yml`, `setup-podman.sh`, `fly.toml`, `render.yaml`.

## 4. Dependency inventory (root `package.json`, runtime deps)

35 runtime packages. Notable for Roura HQ posture:

| Dep | Why it matters |
| --- | --- |
| `dotenv` | Reads `.env` files for config + secrets. |
| `openai` | First-party cloud LLM client. |
| `@modelcontextprotocol/sdk` | MCP server/client transport. |
| `@agentclientprotocol/sdk` | ACP transport. |
| `playwright-core` | Headless Chromium / browser automation. |
| `@lydell/node-pty` | PTY / terminal multiplexing. |
| `croner` | In-process cron scheduling. |
| `chokidar` | Filesystem watching. |
| `web-push` | Web Push (VAPID) sender. |
| `proxy-agent`, `https-proxy-agent`, `global-agent` | Outbound proxy support. |
| `undici`, `ws` | HTTP / WebSocket client + server. |
| `tar`, `jszip` | Archive read/write. |
| `sqlite-vec` | SQLite + vector storage. |
| `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui` | Coding-agent harness. |

Extensions (`extensions/`) ship 131 sub-packages: messaging channels
(slack, discord, msteams, matrix, line, feishu, etc.), model providers
(anthropic, openai, google, azure-speech, deepseek, …), media
(elevenlabs, deepgram, fal), browser/firecrawl/duckduckgo/exa/brave,
diagnostics (otel, prometheus), and assistant skills.

Skills (`skills/`) ship 53 macOS-flavored helpers (1password,
apple-notes, apple-reminders, github, gh-issues, healthcheck, etc.).

## 5. Safety audit findings

Search base: `src/`, `extensions/`, `packages/`, `scripts/`,
`skills/`, `apps/`. Vendored `node_modules`/`dist` excluded.

### 5.1 `.env` / dotenv

- `dotenv` IS imported at:
  - `src/infra/dotenv.ts` — workspace-scoped dotenv loader.
  - `src/config/state-dir-dotenv.ts` — reads `<stateDir>/.env`.
- Both loaders carry an explicit `BLOCKED_WORKSPACE_DOTENV_KEYS` deny
  list that excludes `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `CLAWHUB_AUTH_TOKEN`, proxy vars, etc., and pass through
  `host-env-security.ts::isDangerousHostEnvVarName`.
- All other `.env` hits in the grep are ordinary `process.env.<X>`
  reads (not file reads) — those are fine.
- **Net for Roura:** the deny list is good defense-in-depth, but the
  feature should be hard-disabled when running under a Roura adapter
  (we do not want any `.env` to override Keychain-derived secrets).

### 5.2 Public listener / bind defaults

- `src/gateway/net.ts::defaultGatewayBindMode()` returns:
  - `"loopback"` if Tailscale mode is enabled,
  - `"auto"` (→ `0.0.0.0`) if running inside a container,
  - `"loopback"` (→ `127.0.0.1`) otherwise.
- `0.0.0.0` literals appear in 18+ source/test files, mostly inside
  config validation, doctor checks, and test fixtures, plus the
  `probePortFree(port, host="0.0.0.0")` helper.
- Container deployment (Docker / fly.io / render.yaml) defaults to
  binding all interfaces, then relies on the surrounding network to
  scope access.
- **Net for Roura:** loopback default on the host is acceptable; the
  container default is **not** safe for Roura's posture. Any future
  Roura adapter must force `gateway.bind = "loopback"` regardless of
  environment, and never deploy in a context where the wrapper layer
  doesn't restrict ingress.

### 5.3 Shell / subprocess / PTY

- ~1,196 references to `child_process` / `spawn` / `exec` / PTY use
  across `src/`, `extensions/`, and `scripts/`.
- `extensions/openshell` is auto-activated on startup (`openshell/openclaw.plugin.json`)
  and provides remote shell access to the assistant.
- Update mechanism (`src/infra/update-runner.ts`) executes
  `git checkout`, `git rebase`, and `git rebase --abort` against its own
  install root.
- **Net for Roura:** OpenClaw is an OS-level assistant by design; shell
  access is fundamental. A Roura-safe deployment must:
  1. Disable `openshell` and any shell-capable tool by default in the
     Roura adapter config.
  2. Pin the update runner to a specific commit or disable auto-update.
  3. Never grant the Slack token bridge to any tool that has shell
     reach.

### 5.4 Cloud-model defaults

- Hardcoded base URLs:
  - `src/infra/google-api-base-url.ts` →
    `https://generativelanguage.googleapis.com/v1beta`.
  - `src/infra/provider-usage.fetch.claude.ts` →
    `https://api.anthropic.com/api/oauth/usage`.
  - `src/infra/net/proxy-env.ts` references `api.openai.com`,
    `api.anthropic.com`.
- 35 runtime deps include the `openai` client.
- **Net for Roura:** cloud is a primary target for OpenClaw. A
  Roura-safe deployment must default to a local-only model route
  (Ollama / pi-ai local providers) and refuse cloud routes unless an
  operator confirmation step explicitly approves them — same posture
  as Roura HQ today.

### 5.5 Filesystem + repo writes

- `src/infra/update-runner.ts` performs `git checkout` / `git rebase`
  on the install tree — self-update.
- `src/infra/git-commit.test.ts` shows there is git-commit
  resolution logic somewhere in the tree (test file only).
- Filesystem writes are pervasive (workspace state, plugin caches,
  pairing stores, agent state). All are scoped to the OpenClaw state
  dir (e.g., `~/Library/Application Support/OpenClaw` on macOS).
- **Net for Roura:** OpenClaw must NOT have write access to any Roura
  app repo, the Roura HQ workspace, or `agents/`. The Roura adapter
  must run OpenClaw with its own state dir (already its default), and
  any inter-process bridge must reject write requests targeting paths
  outside that dir.

### 5.6 Cloud / external service defaults via auto-start plugins

Plugins with `"activation.onStartup": true`:

```
acpx, active-memory, bonjour, browser, device-pair, diagnostics-otel,
diagnostics-prometheus, file-transfer, google-meet, llm-task, lobster,
memory-wiki, openshell, phone-control, skill-workshop, talk-voice,
thread-ownership, voice-call, webhooks
```

- `bonjour` advertises a Bonjour/mDNS service on the LAN — visible to
  every device on the network segment.
- `webhooks` accepts inbound HTTP — depends on gateway bind mode.
- `browser` boots Playwright on startup.
- `diagnostics-otel` starts the OTLP exporter pipeline. **Mitigation
  exists upstream:** `extensions/diagnostics-otel/src/service.ts`
  returns `undefined` when no OTLP endpoint is configured, so no
  outbound telemetry leaves the host unless `OTEL_EXPORTER_OTLP_*`
  env vars are set.
- `diagnostics-prometheus` exposes a scrape endpoint inside the
  gateway — bind-mode-dependent.
- **Net for Roura:** the Roura adapter must ship a config that
  disables every onStartup plugin that opens a network port or
  advertises on the network: at minimum `bonjour`, `webhooks`,
  `browser`, `diagnostics-prometheus`, `voice-call`, `talk-voice`,
  `phone-control`, `google-meet`. Disable `openshell` for the same
  reason as §5.3.

### 5.7 Background jobs / cron

- 46 hits for `croner` / `setInterval` / `Worker` / `child_process.fork`.
- `src/cron/active-jobs.ts` and `src/infra/heartbeat-runner.ts`
  drive periodic work.
- Jobs include update checks, model warm-up, plugin probes, and skill
  refresh.
- **Net for Roura:** auto-update + heartbeat probes must not phone
  home from a Roura-hosted instance without explicit consent. The
  Roura adapter should set `update.enabled = false` and run with a
  stub `clawhub` URL.

### 5.8 MCP / plugin / tool loading

- 2,366 hits for `@modelcontextprotocol` / `plugin-sdk` / `loadPlugin`
  / `loadExtension` / `registerTool`. The plugin-SDK pathway is the
  central extensibility surface.
- Skills (`skills/`) include `coding-agent`, `github`, `gh-issues`,
  `apple-notes`, `apple-reminders` — many can write to user data
  stores or app repos.
- **Net for Roura:** every tool/skill the assistant can call from
  inside Slack must be allowlist-gated by the Roura adapter, not by
  OpenClaw's own per-skill flags. Default-deny.

### 5.9 Browser / network automation

- 69 hits for `playwright` / `chromium.launch` / `page.goto`.
- `extensions/browser` is auto-activated on startup.
- `Dockerfile.sandbox-browser` exists for a sandboxed Chromium image.
- **Net for Roura:** browser automation must be either disabled or
  sandboxed; in either case the Roura adapter must refuse to feed it
  Slack tokens, repo paths, or any HQ workspace path.

### 5.10 Keychain / secret store

- macOS Keychain is used via `security find-generic-password`:
  - `src/agents/cli-credentials.ts:262` — Codex Auth.
  - `src/agents/cli-credentials.ts:415` — Claude CLI Keychain service.
- This is the same pattern Roura HQ already uses. **Good.**
- **Net for Roura:** the Roura adapter can keep its own Keychain
  service (`io.roura.flaco-hq.slack`) and never share it with
  OpenClaw's namespaces. Slack tokens stay in `flaco-hq`'s Keychain
  service only.

### 5.11 Token-shaped strings in source

- Slack token literals (`xoxb-…`, `xapp-…`) appear ONLY in test
  fixtures (`gateway/server.cron.test.ts`, `cron.validation.test.ts`),
  always with the placeholder `xoxb-slack-token` / `xapp-slack-token`.
  No real tokens, no leaked secrets.

## 6. Risk register

| # | Risk | Severity | Path | Why it matters for Roura HQ | Mitigation | Target |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `.env` reads can override config + (with deny-list bypass) inject secrets | Med | `src/infra/dotenv.ts`, `src/config/state-dir-dotenv.ts` | Roura HQ guarantees Keychain-only secrets. A Roura-managed OpenClaw must not reintroduce file-based secrets. | `OPENCLAW_DOTENV_DISABLE=1` flag enforced at adapter boot; document that Roura never ships a `.env`. | **Phase 28B patch + adapter** |
| 2 | Container default bind = `0.0.0.0` | High | `src/gateway/net.ts:297` | Any Docker/fly/render deployment exposes the gateway publicly by default. | Force `bind=loopback` in Roura config; refuse to start if effective bind is non-loopback. | **Phase 28B patch + adapter** |
| 3 | `extensions/openshell` auto-activates and runs shell | High | `extensions/openshell/openclaw.plugin.json` | Roura HQ forbids agents from running shell. A bridge that exposes openshell to Slack is a worst-case path. | Disable plugin in Roura config; refuse to load `openshell` in adapter; never give it Slack token. | **Phase 28B patch + adapter** |
| 4 | Update runner runs `git checkout` / `git rebase` on its own tree | Med | `src/infra/update-runner.ts` | Self-update can replace audited code with a new SHA Roura hasn't reviewed. | Pin via `update.enabled=false`; lock the install path; document that updates require a fresh audit cycle. | **Phase 28B patch + adapter** |
| 5 | Cloud-model defaults present (OpenAI, Anthropic, Google) | High | `src/infra/google-api-base-url.ts`, `src/infra/provider-usage.fetch.claude.ts`, `extensions/openai`, `extensions/anthropic`, … | Roura HQ defaults to local Ollama only. Cloud routes must be opt-in. | Adapter forces `cloud.enabled=false`; allowed model routes limited to local providers. | **Future Roura adapter** |
| 6 | `bonjour` auto-advertises on LAN | Med | `extensions/bonjour/openclaw.plugin.json` | Network discoverability isn't appropriate for an HQ-bridged instance. | Disable plugin in Roura config; refuse to load. | **Phase 28B patch + adapter** |
| 7 | `webhooks`, `browser`, `voice-call`, `talk-voice`, `phone-control`, `google-meet`, `diagnostics-prometheus` auto-activate | Med | `extensions/*/openclaw.plugin.json` | Each opens external surface area or external connectors. | Roura adapter ships `OPENCLAW_PLUGINS_DENY` containing this set. | **Phase 28B patch + adapter** |
| 8 | OTel exporter activation on startup | Low | `extensions/diagnostics-otel/openclaw.plugin.json` | Could exfiltrate diagnostics if `OTEL_*` env vars leak. | Already gated by env-var presence; adapter unsets `OTEL_EXPORTER_OTLP_*` and disables the plugin anyway. | **Phase 28B patch + adapter** |
| 9 | MCP / plugin / tool surface is huge (2.3k hits) | High | pervasive | Roura HQ default-denies tools; the inverse here is unsafe by default for an HQ-bridged instance. | Adapter ships an *allow* list (likely empty in V1); plugin loader rejects anything not on it. | **Phase 28B patch + adapter** |
| 10 | Filesystem writes scoped only by OpenClaw state dir | Med | pervasive | OpenClaw must not write into Roura HQ workspace, agent prompts, or app repos. | Run OpenClaw under a launchd/launchctl process whose `WorkingDirectory` is its own state dir; sandbox profile blocks the rest. | **Future Roura adapter (deployment)** |
| 11 | Background cron + heartbeat | Low | `src/cron/`, `src/infra/heartbeat-runner.ts` | Periodic outbound checks (auto-update, model probes). | Disable update + clawhub URL in adapter config. | **Phase 28B patch + adapter** |
| 12 | Keychain reads for Codex / Claude CLI | Low | `src/agents/cli-credentials.ts` | Reads other apps' Keychain entries — fine on the user's host machine, but Roura's Keychain service stays separate. | Document namespace separation; Roura adapter never points OpenClaw at the `io.roura.flaco-hq.slack` service. | **Documentation** |
| 13 | `xoxb-` / `xapp-` test fixtures in source | Low | `src/gateway/server.cron.test.ts`, `cron.validation.test.ts` | These look like tokens to grep-based scanners. | Document that these are placeholder strings only; consider linter rules in Roura's CI. | **Documentation** |

## 7. Phase 28B patch recommendations (minimal)

Phase 28B should land a small, *upstream-friendly* set of patches in
the Roura fork that flip safe defaults under a feature flag. None of
these patches forks behavior that breaks upstream tests.

### 7.1 New env / config flag: `ROURA_HARDENED_MODE=1`

Detected once during gateway startup (in `src/cli/gateway-cli/run.ts`).
When set:

| Setting | Forced value |
| --- | --- |
| `gateway.bind` | `loopback` (rejects `auto` / `lan` / `tailnet` / `0.0.0.0`) |
| `update.enabled` | `false` |
| `cloud.enabled` (any provider extension) | `false` (refuses to load any plugin in `extensions/{openai,anthropic,anthropic-vertex,google,gemini,…}`) |
| `dotenv` workspace + state-dir loaders | no-op (reads only `process.env`, writes a one-line warning) |
| Plugin allowlist | hard `["lobster","active-memory","memory-wiki","llm-task"]` (or whatever Roura needs) — every other plugin's `onStartup` is ignored |
| `openshell`, `webhooks`, `browser`, `bonjour`, `voice-call`, `talk-voice`, `phone-control`, `google-meet`, `diagnostics-otel`, `diagnostics-prometheus` | force-disabled regardless of plugin config |
| `OTEL_EXPORTER_OTLP_*` env | scrubbed before plugin load |
| Keychain service for any future Roura-side helper | `io.roura.openclaw` (separate from `io.roura.flaco-hq.slack`) |

### 7.2 New file: `src/roura/hardened.ts`

Single point of truth for the hardening rules above. Imported by:

- `src/cli/gateway-cli/run.ts` (validates bind + emits an explicit
  refusal if effective bind is non-loopback under the flag),
- `src/plugins/services.ts` (filters the activation list against the
  Roura allowlist),
- `src/infra/dotenv.ts` + `src/config/state-dir-dotenv.ts` (early
  return + log line),
- `src/infra/update-runner.ts` (early return).

### 7.3 Documentation

- Replace `docs/roura/openclaw-fork-audit.md` (this file) with the
  Phase 28B-final version once the patches land.
- Add `docs/roura/hardening.md` describing the flag, its forced
  defaults, and the allowlist.
- Document that Roura HQ continues to enforce its own Keychain-only,
  policy-gated, audit-trailed Slack runtime — OpenClaw is *not* the
  authority for any Roura HQ surface.

### 7.4 Tests

- A new `src/roura/hardened.test.ts` that asserts:
  - bind != loopback under the flag → refusal,
  - dotenv loaders are no-ops under the flag,
  - update runner does nothing under the flag,
  - the auto-startup plugin list shrinks to the Roura allowlist.
- All upstream tests continue to pass with the flag UNSET (default).

### 7.5 Roura HQ side (separate phase, not part of 28B)

Phase 28C / later: build the Roura HQ adapter that talks to a
hardened OpenClaw via Roura HQ's existing policy + audit. This
adapter:

- Lives inside `flaco-hq` (not in OpenClaw).
- Exposes nothing new to Slack until policy admits it.
- Uses Roura HQ's existing `find_policy()` for authorization.
- Records every cross-process call as `origin="openclaw-bridge"` in
  the same JSONL audit log Roura HQ already uses.
- Never gives OpenClaw the Slack token — Roura HQ stays the only
  Slack-authorized process.

## 8. Phase 28A out-of-scope confirmations

- Roura HQ source code: **unchanged**.
- `flaco-hq` version: **0.4.13** (no bump needed; this phase is
  audit/pin only).
- `slack-runtime.json`: **unchanged**.
- LaunchAgent: **unchanged**, kickstarted clean for the unrelated
  v0.4.13 Phase-27 cycle, last verified state `running`, single
  socket process, no public listener.
- Cockpit readiness: **READY** at `flaco-hq --cockpit-status`.
- Slack policies: **4 blocks validated**.
- Tokens: never read or printed.
- No public listener bound on the Roura HQ side.
- Roura HQ origins remain distinct: `cli`, `tui-chat`, `slack-socket`.

## 9. Sign-off

- **Phase 28A status:** complete — fork pinned, audit doc landed in
  the fork repo, no Roura HQ runtime change.
- **Next gate:** Phase 28B patches in the fork, behind
  `ROURA_HARDENED_MODE=1`. Roura HQ stays untouched until Phase 28C
  introduces an explicit, policy-gated bridge.
