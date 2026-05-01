/**
 * Roura Hardened Mode — Phase 28B.
 *
 * Single source of truth for the Roura-controlled OpenClaw fork's
 * "hardened" defaults. Activated when the environment variable
 * `ROURA_HARDENED_MODE` is set to a truthy value (`1`, `true`, `yes`,
 * `on`). When unset or `0` / `false` / `off`, every helper here is a
 * no-op so upstream behavior — and upstream tests — are unchanged.
 *
 * This module is intentionally self-contained:
 * - No imports from anywhere else in OpenClaw.
 * - No filesystem reads, no subprocess, no network.
 * - No log side-effects beyond what `assertRouraAllows` emits when
 *   asked to refuse a feature.
 *
 * Roura HQ does NOT yet bridge to OpenClaw. This module exists so
 * that, when the bridge is built (Phase 28C+), the OpenClaw process
 * Roura HQ launches will already refuse the things Roura HQ would
 * never authorize: public network binds, dotenv secret loads, self-
 * update, dangerous startup plugins, and cloud-model providers.
 *
 * Public surface:
 *   isRouraHardenedMode(env?)        → boolean
 *   rouraSafeConfigOverrides(env?)   → forced-config object
 *   disabledPluginIds                → ReadonlySet<string>
 *   disabledProviderIds              → ReadonlySet<string>
 *   disabledEnvKeys                  → ReadonlySet<string>
 *   isPluginDisabledByRoura(id, env?)→ boolean
 *   isProviderDisabledByRoura(id, env?)→ boolean
 *   scrubEnvForHardenedMode(env)     → mutating: deletes telemetry/proxy
 *                                      keys when the flag is on
 *   assertRouraAllows(feature, env?) → throws RouraHardenedRefusal
 *                                      if the feature is forbidden
 *   hardenedModeSummary(env?)        → snapshot for diagnostics output
 */

export type RouraHardenedFeature =
  | "public-bind"
  | "dotenv-secret-read"
  | "self-update"
  | "shell-execution"
  | "cloud-provider-load"
  | "telemetry-exporter"
  | "background-cron";

export class RouraHardenedRefusal extends Error {
  readonly feature: RouraHardenedFeature;
  constructor(feature: RouraHardenedFeature, detail?: string) {
    super(
      detail
        ? `Roura hardened mode refused feature ${feature}: ${detail}`
        : `Roura hardened mode refused feature ${feature}.`,
    );
    this.name = "RouraHardenedRefusal";
    this.feature = feature;
  }
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["", "0", "false", "no", "off"]);

const ENV_FLAG = "ROURA_HARDENED_MODE";

/** Auto-startup plugin IDs that must be force-disabled in hardened mode. */
export const disabledPluginIds: ReadonlySet<string> = new Set([
  "openshell",
  "bonjour",
  "webhooks",
  "browser",
  "voice-call",
  "talk-voice",
  "phone-control",
  "google-meet",
  "diagnostics-otel",
  "diagnostics-prometheus",
  // Network/discovery surface that the upstream "auto-start" set tends to
  // include but Roura HQ would never authorize without an explicit bridge:
  "device-pair",
  "file-transfer",
  "skill-workshop",
]);

/**
 * Cloud-model provider plugin IDs (the directory names under
 * `extensions/`). Anything in this set is refused when the hardened
 * flag is on. The list is conservative — if a future provider name
 * isn't here, the bridge layer (Phase 28C) is still the authority on
 * what gets called from Slack.
 */
export const disabledProviderIds: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "anthropic-vertex",
  "google",
  "gemini",
  "openrouter",
  "azure-speech",
  "amazon-bedrock",
  "amazon-bedrock-mantle",
  "alibaba",
  "byteplus",
  "cerebras",
  "chutes",
  "cloudflare-ai-gateway",
  "cohere",
  "deepinfra",
  "deepseek",
  "fireworks",
  "groq",
  "huggingface",
  "kilocode",
  "kimi-coding",
  "litellm",
  "lmstudio",
  "microsoft-foundry",
  "minimax",
  "mistral",
  "moonshot",
  "openai-compat",
  "perplexity",
  "together",
  "togetherai",
  "vertex",
  "xai",
]);

/**
 * Environment variables that must be removed before any plugin is
 * activated. These either configure outbound telemetry or force a
 * proxy that could exfiltrate data.
 */
export const disabledEnvKeys: ReadonlySet<string> = new Set([
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_RESOURCE_ATTRIBUTES",
  "PROMETHEUS_PUSH_GATEWAY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);

/** Bind values that are always rejected under the hardened flag. */
export const refusedBindValues: ReadonlySet<string> = new Set([
  "0.0.0.0",
  "::",
  "auto",
  "lan",
  "tailnet",
  "custom",
]);

/** Bind values that are always accepted under the hardened flag. */
export const allowedBindValues: ReadonlySet<string> = new Set([
  "loopback",
  "127.0.0.1",
  "::1",
  "localhost",
]);

type EnvLike = NodeJS.ProcessEnv | { [k: string]: string | undefined };

function readFlag(env: EnvLike): boolean {
  const raw = env?.[ENV_FLAG];
  if (raw === undefined || raw === null) {
    return false;
  }
  const v = String(raw).trim().toLowerCase();
  if (FALSY.has(v)) {
    return false;
  }
  return TRUTHY.has(v);
}

/** True iff `ROURA_HARDENED_MODE` is set to a truthy value. */
export function isRouraHardenedMode(env: EnvLike = process.env): boolean {
  return readFlag(env);
}

/** Minimal config-shape patch the gateway should merge under hardened mode. */
export function rouraSafeConfigOverrides(
  env: EnvLike = process.env,
): {
  applied: boolean;
  gatewayBind: "loopback";
  cloudEnabled: false;
  updateEnabled: false;
  telemetryDisabled: true;
  pluginsDisabled: string[];
  providersDisabled: string[];
} | { applied: false } {
  if (!readFlag(env)) {
    return { applied: false };
  }
  return {
    applied: true,
    gatewayBind: "loopback",
    cloudEnabled: false,
    updateEnabled: false,
    telemetryDisabled: true,
    pluginsDisabled: [...disabledPluginIds].sort(),
    providersDisabled: [...disabledProviderIds].sort(),
  };
}

/** Plugin-disabled predicate. Always false when the flag is unset. */
export function isPluginDisabledByRoura(
  pluginId: string | undefined,
  env: EnvLike = process.env,
): boolean {
  if (!pluginId) {
    return false;
  }
  if (!readFlag(env)) {
    return false;
  }
  return disabledPluginIds.has(pluginId) || disabledProviderIds.has(pluginId);
}

/** Provider-disabled predicate. Always false when the flag is unset. */
export function isProviderDisabledByRoura(
  providerId: string | undefined,
  env: EnvLike = process.env,
): boolean {
  if (!providerId) {
    return false;
  }
  if (!readFlag(env)) {
    return false;
  }
  return disabledProviderIds.has(providerId);
}

/** Bind-value validator. Throws on any non-loopback value under the flag. */
export function assertRouraBindAllowed(
  bind: string | undefined,
  env: EnvLike = process.env,
): void {
  if (!readFlag(env)) {
    return;
  }
  const v = (bind ?? "").trim().toLowerCase();
  if (allowedBindValues.has(v)) {
    return;
  }
  if (refusedBindValues.has(v)) {
    throw new RouraHardenedRefusal(
      "public-bind",
      `bind=${bind!}; loopback-only is enforced.`,
    );
  }
  // Unknown value → refuse. Hardened mode is allowlist, not denylist.
  throw new RouraHardenedRefusal(
    "public-bind",
    `bind=${bind ?? "<unset>"}; only loopback-style binds are accepted.`,
  );
}

/**
 * Strip telemetry / proxy env keys in-place. Returns the list of keys
 * that were actually removed (so callers can log a warning). When the
 * flag is unset this is a no-op and returns the empty array.
 */
export function scrubEnvForHardenedMode(
  env: EnvLike = process.env,
): string[] {
  if (!readFlag(env)) {
    return [];
  }
  const removed: string[] = [];
  for (const key of disabledEnvKeys) {
    if (env[key] !== undefined && env[key] !== "") {
      delete (env as Record<string, string | undefined>)[key];
      removed.push(key);
    }
  }
  return removed.sort();
}

/**
 * Refuse a feature outright. Most patch points are content with
 * `isRouraHardenedMode()` + an early return; this helper is for the
 * cases where we want a thrown error (update runner, cloud-provider
 * load, dotenv loader called explicitly) so the call site cannot
 * accidentally proceed.
 */
export function assertRouraAllows(
  feature: RouraHardenedFeature,
  detail?: string,
  env: EnvLike = process.env,
): void {
  if (!readFlag(env)) {
    return;
  }
  switch (feature) {
    case "public-bind":
    case "dotenv-secret-read":
    case "self-update":
    case "shell-execution":
    case "cloud-provider-load":
    case "telemetry-exporter":
    case "background-cron":
      throw new RouraHardenedRefusal(feature, detail);
    default: {
      // exhaustive guard
      const _never: never = feature;
      void _never;
      throw new RouraHardenedRefusal(
        "shell-execution",
        `unknown feature: ${String(feature)}`,
      );
    }
  }
}

export type HardenedModeSummary = {
  enabled: boolean;
  envFlag: string;
  envValue: string | undefined;
  forced: {
    gatewayBind: "loopback" | null;
    dotenvDisabled: boolean;
    selfUpdateDisabled: boolean;
    cloudProvidersDisabled: boolean;
    telemetryDisabled: boolean;
  };
  disabledPluginIds: string[];
  disabledProviderIds: string[];
  disabledEnvKeys: string[];
  refusedBindValues: string[];
  allowedBindValues: string[];
};

/** Diagnostic snapshot — safe to log. Contains no secrets or env values. */
export function hardenedModeSummary(
  env: EnvLike = process.env,
): HardenedModeSummary {
  const enabled = readFlag(env);
  const envValue =
    env[ENV_FLAG] === undefined ? undefined : String(env[ENV_FLAG]);
  return {
    enabled,
    envFlag: ENV_FLAG,
    envValue,
    forced: {
      gatewayBind: enabled ? "loopback" : null,
      dotenvDisabled: enabled,
      selfUpdateDisabled: enabled,
      cloudProvidersDisabled: enabled,
      telemetryDisabled: enabled,
    },
    disabledPluginIds: [...disabledPluginIds].sort(),
    disabledProviderIds: [...disabledProviderIds].sort(),
    disabledEnvKeys: [...disabledEnvKeys].sort(),
    refusedBindValues: [...refusedBindValues].sort(),
    allowedBindValues: [...allowedBindValues].sort(),
  };
}
