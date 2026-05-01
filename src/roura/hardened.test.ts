/**
 * Phase 28B unit tests for the Roura hardened-mode module.
 *
 * Coverage:
 *   - flag detection (truthy / falsy / unset)
 *   - safe-config overrides (off-default; populated when on)
 *   - bind allowlist + refusal
 *   - plugin/provider denylists
 *   - env scrub
 *   - assertRouraAllows()
 *   - hardenedModeSummary() shape
 *   - default-off path is non-destructive (dotenv loaders / update runner /
 *     plugin services keep their upstream behavior)
 */

import { describe, expect, it } from "vitest";
import {
  allowedBindValues,
  assertRouraAllows,
  assertRouraBindAllowed,
  disabledEnvKeys,
  disabledPluginIds,
  disabledProviderIds,
  hardenedModeSummary,
  isPluginDisabledByRoura,
  isProviderDisabledByRoura,
  isRouraHardenedMode,
  refusedBindValues,
  RouraHardenedRefusal,
  rouraSafeConfigOverrides,
  scrubEnvForHardenedMode,
} from "./hardened.js";

const HARDENED = { ROURA_HARDENED_MODE: "1" };
const HARDENED_ALT = { ROURA_HARDENED_MODE: "true" };
const HARDENED_YES = { ROURA_HARDENED_MODE: "yes" };
const HARDENED_ON = { ROURA_HARDENED_MODE: "on" };
const OFF_EMPTY = { ROURA_HARDENED_MODE: "" };
const OFF_ZERO = { ROURA_HARDENED_MODE: "0" };
const OFF_FALSE = { ROURA_HARDENED_MODE: "false" };
const OFF_NO = { ROURA_HARDENED_MODE: "no" };
const OFF_OFF = { ROURA_HARDENED_MODE: "off" };
const UNSET = {} as const;

describe("isRouraHardenedMode", () => {
  it.each([
    ["unset", UNSET, false],
    ["empty", OFF_EMPTY, false],
    ["0", OFF_ZERO, false],
    ["false", OFF_FALSE, false],
    ["no", OFF_NO, false],
    ["off", OFF_OFF, false],
    ["1", HARDENED, true],
    ["true", HARDENED_ALT, true],
    ["yes", HARDENED_YES, true],
    ["on", HARDENED_ON, true],
    // case-insensitive
    ["TRUE", { ROURA_HARDENED_MODE: "TRUE" }, true],
    ["YES", { ROURA_HARDENED_MODE: "YES" }, true],
    ["whitespace", { ROURA_HARDENED_MODE: "  1  " }, true],
  ])("recognizes %s", (_label, env, expected) => {
    expect(isRouraHardenedMode(env)).toBe(expected);
  });

  it("garbage values are treated as off (allowlist of truthy)", () => {
    expect(isRouraHardenedMode({ ROURA_HARDENED_MODE: "maybe" })).toBe(false);
    expect(isRouraHardenedMode({ ROURA_HARDENED_MODE: "2" })).toBe(false);
  });
});

describe("rouraSafeConfigOverrides", () => {
  it("returns applied:false when the flag is unset", () => {
    const o = rouraSafeConfigOverrides(UNSET);
    expect(o.applied).toBe(false);
  });

  it("returns the full forced-config block when the flag is set", () => {
    const o = rouraSafeConfigOverrides(HARDENED);
    expect(o).toMatchObject({
      applied: true,
      gatewayBind: "loopback",
      cloudEnabled: false,
      updateEnabled: false,
      telemetryDisabled: true,
    });
    expect(Array.isArray((o as { pluginsDisabled: string[] }).pluginsDisabled)).toBe(true);
    expect((o as { pluginsDisabled: string[] }).pluginsDisabled).toContain("openshell");
    expect((o as { providersDisabled: string[] }).providersDisabled).toContain("openai");
  });
});

describe("disabled denylists", () => {
  it("disables openshell and other auto-startup plugins", () => {
    expect(disabledPluginIds.has("openshell")).toBe(true);
    expect(disabledPluginIds.has("bonjour")).toBe(true);
    expect(disabledPluginIds.has("webhooks")).toBe(true);
    expect(disabledPluginIds.has("browser")).toBe(true);
    expect(disabledPluginIds.has("voice-call")).toBe(true);
    expect(disabledPluginIds.has("talk-voice")).toBe(true);
    expect(disabledPluginIds.has("phone-control")).toBe(true);
    expect(disabledPluginIds.has("google-meet")).toBe(true);
    expect(disabledPluginIds.has("diagnostics-otel")).toBe(true);
    expect(disabledPluginIds.has("diagnostics-prometheus")).toBe(true);
  });

  it("disables every recognized cloud-model provider", () => {
    for (const id of [
      "openai",
      "anthropic",
      "anthropic-vertex",
      "google",
      "gemini",
      "openrouter",
      "azure-speech",
      "amazon-bedrock",
      "cerebras",
      "cohere",
      "deepinfra",
      "deepseek",
      "fireworks",
      "groq",
      "huggingface",
      "litellm",
      "mistral",
      "moonshot",
    ]) {
      expect(disabledProviderIds.has(id)).toBe(true);
    }
  });

  it("disables OTEL/proxy env keys", () => {
    expect(disabledEnvKeys.has("OTEL_EXPORTER_OTLP_ENDPOINT")).toBe(true);
    expect(disabledEnvKeys.has("OTEL_EXPORTER_OTLP_HEADERS")).toBe(true);
    expect(disabledEnvKeys.has("HTTP_PROXY")).toBe(true);
    expect(disabledEnvKeys.has("HTTPS_PROXY")).toBe(true);
    expect(disabledEnvKeys.has("ALL_PROXY")).toBe(true);
  });
});

describe("isPluginDisabledByRoura", () => {
  it("is always false when the flag is unset", () => {
    expect(isPluginDisabledByRoura("openshell", UNSET)).toBe(false);
    expect(isPluginDisabledByRoura("openai", OFF_ZERO)).toBe(false);
  });

  it("returns true for denylisted plugins under the flag", () => {
    expect(isPluginDisabledByRoura("openshell", HARDENED)).toBe(true);
    expect(isPluginDisabledByRoura("diagnostics-otel", HARDENED)).toBe(true);
  });

  it("treats provider IDs as disabled too", () => {
    expect(isPluginDisabledByRoura("openai", HARDENED)).toBe(true);
    expect(isPluginDisabledByRoura("anthropic", HARDENED)).toBe(true);
  });

  it("returns false for safe IDs", () => {
    expect(isPluginDisabledByRoura("active-memory", HARDENED)).toBe(false);
    expect(isPluginDisabledByRoura("memory-wiki", HARDENED)).toBe(false);
    expect(isPluginDisabledByRoura("llm-task", HARDENED)).toBe(false);
    expect(isPluginDisabledByRoura("lobster", HARDENED)).toBe(false);
  });

  it("undefined/empty is not disabled", () => {
    expect(isPluginDisabledByRoura(undefined, HARDENED)).toBe(false);
    expect(isPluginDisabledByRoura("", HARDENED)).toBe(false);
  });
});

describe("isProviderDisabledByRoura", () => {
  it("only fires under the flag and only for cloud providers", () => {
    expect(isProviderDisabledByRoura("openai", UNSET)).toBe(false);
    expect(isProviderDisabledByRoura("openai", HARDENED)).toBe(true);
    expect(isProviderDisabledByRoura("openshell", HARDENED)).toBe(false);
  });
});

describe("assertRouraBindAllowed", () => {
  it("is a no-op when the flag is unset", () => {
    expect(() => assertRouraBindAllowed("0.0.0.0", UNSET)).not.toThrow();
    expect(() => assertRouraBindAllowed("auto", UNSET)).not.toThrow();
    expect(() => assertRouraBindAllowed("lan", UNSET)).not.toThrow();
  });

  it.each(["loopback", "127.0.0.1", "::1", "localhost"])(
    "accepts %s under the flag",
    (bind) => {
      expect(() => assertRouraBindAllowed(bind, HARDENED)).not.toThrow();
    },
  );

  it.each([...refusedBindValues])("refuses %s under the flag", (bind) => {
    expect(() => assertRouraBindAllowed(bind, HARDENED)).toThrow(
      RouraHardenedRefusal,
    );
  });

  it("refuses unknown bind values (allowlist semantics)", () => {
    expect(() =>
      assertRouraBindAllowed("192.168.1.1", HARDENED),
    ).toThrow(RouraHardenedRefusal);
  });

  it("attaches feature='public-bind' to the refusal", () => {
    try {
      assertRouraBindAllowed("0.0.0.0", HARDENED);
    } catch (e) {
      expect(e).toBeInstanceOf(RouraHardenedRefusal);
      if (e instanceof RouraHardenedRefusal) {
        expect(e.feature).toBe("public-bind");
      }
    }
  });
});

describe("scrubEnvForHardenedMode", () => {
  it("returns [] when the flag is unset and leaves env intact", () => {
    const env = {
      ROURA_HARDENED_MODE: "0",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example",
      HTTP_PROXY: "http://proxy.example:8080",
    };
    expect(scrubEnvForHardenedMode(env)).toEqual([]);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://otel.example");
    expect(env.HTTP_PROXY).toBe("http://proxy.example:8080");
  });

  it("removes OTEL/proxy keys under the flag", () => {
    const env: Record<string, string | undefined> = {
      ROURA_HARDENED_MODE: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example",
      OTEL_EXPORTER_OTLP_HEADERS: "x=y",
      HTTP_PROXY: "http://proxy.example:8080",
      HTTPS_PROXY: "http://proxy.example:8080",
      KEEP_ME: "yes",
    };
    const removed = scrubEnvForHardenedMode(env);
    expect(removed).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(removed).toContain("OTEL_EXPORTER_OTLP_HEADERS");
    expect(removed).toContain("HTTP_PROXY");
    expect(removed).toContain("HTTPS_PROXY");
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    // unrelated keys survive
    expect(env.KEEP_ME).toBe("yes");
  });

  it("ignores absent / empty env keys", () => {
    const env = { ROURA_HARDENED_MODE: "1", HTTP_PROXY: "" };
    const removed = scrubEnvForHardenedMode(env);
    expect(removed).toEqual([]);
  });
});

describe("assertRouraAllows", () => {
  it("is a no-op when the flag is unset", () => {
    expect(() => assertRouraAllows("self-update", undefined, UNSET)).not.toThrow();
    expect(() => assertRouraAllows("dotenv-secret-read", undefined, OFF_NO)).not.toThrow();
  });

  it("throws RouraHardenedRefusal for every known feature under the flag", () => {
    for (const f of [
      "public-bind",
      "dotenv-secret-read",
      "self-update",
      "shell-execution",
      "cloud-provider-load",
      "telemetry-exporter",
      "background-cron",
    ] as const) {
      expect(() => assertRouraAllows(f, undefined, HARDENED)).toThrow(
        RouraHardenedRefusal,
      );
    }
  });

  it("preserves the feature tag on the thrown refusal", () => {
    try {
      assertRouraAllows("self-update", "git checkout would have run", HARDENED);
    } catch (e) {
      expect(e).toBeInstanceOf(RouraHardenedRefusal);
      if (e instanceof RouraHardenedRefusal) {
        expect(e.feature).toBe("self-update");
        expect(e.message).toContain("git checkout would have run");
      }
    }
  });
});

describe("hardenedModeSummary", () => {
  it("reports disabled state when flag is unset", () => {
    const s = hardenedModeSummary(UNSET);
    expect(s.enabled).toBe(false);
    expect(s.envFlag).toBe("ROURA_HARDENED_MODE");
    expect(s.envValue).toBeUndefined();
    expect(s.forced.gatewayBind).toBeNull();
    expect(s.forced.dotenvDisabled).toBe(false);
    expect(s.forced.selfUpdateDisabled).toBe(false);
    expect(s.forced.cloudProvidersDisabled).toBe(false);
    expect(s.forced.telemetryDisabled).toBe(false);
  });

  it("reports forced-loopback + everything-disabled when flag is set", () => {
    const s = hardenedModeSummary(HARDENED);
    expect(s.enabled).toBe(true);
    expect(s.envValue).toBe("1");
    expect(s.forced.gatewayBind).toBe("loopback");
    expect(s.forced.dotenvDisabled).toBe(true);
    expect(s.forced.selfUpdateDisabled).toBe(true);
    expect(s.forced.cloudProvidersDisabled).toBe(true);
    expect(s.forced.telemetryDisabled).toBe(true);
    expect(s.disabledPluginIds).toContain("openshell");
    expect(s.disabledProviderIds).toContain("openai");
    expect(s.disabledEnvKeys).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(s.refusedBindValues).toContain("0.0.0.0");
    expect(s.allowedBindValues).toContain("loopback");
  });

  it("never includes secret-shaped strings", () => {
    const s = hardenedModeSummary(HARDENED);
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/xoxb-/);
    expect(text).not.toMatch(/xapp-/);
    expect(text).not.toMatch(/Bearer\s/);
  });
});

describe("RouraHardenedRefusal class", () => {
  it("is an Error subclass with feature + name", () => {
    const e = new RouraHardenedRefusal("public-bind", "details");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("RouraHardenedRefusal");
    expect(e.feature).toBe("public-bind");
    expect(e.message).toContain("public-bind");
    expect(e.message).toContain("details");
  });
});

describe("default-off path", () => {
  it("allowedBindValues and refusedBindValues are disjoint", () => {
    for (const v of allowedBindValues) {
      expect(refusedBindValues.has(v)).toBe(false);
    }
  });

  it("disabledPluginIds and disabledProviderIds do not collide", () => {
    for (const id of disabledPluginIds) {
      expect(disabledProviderIds.has(id)).toBe(false);
    }
  });

  it("does not accidentally lock the gateway under unset flag", () => {
    // This is the contract upstream tests rely on.
    expect(isRouraHardenedMode(UNSET)).toBe(false);
    expect(rouraSafeConfigOverrides(UNSET).applied).toBe(false);
    expect(scrubEnvForHardenedMode({ ROURA_HARDENED_MODE: "" })).toEqual([]);
  });
});
