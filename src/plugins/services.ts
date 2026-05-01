import { STATE_DIR } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emitTrustedDiagnosticEvent,
  onInternalDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isPluginDisabledByRoura,
  isRouraHardenedMode,
  scrubEnvForHardenedMode,
} from "../roura/hardened.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import type { PluginRegistry } from "./registry.js";
import type { OpenClawPluginServiceContext, PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");
function createPluginLogger(): PluginLogger {
  return {
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
    debug: (msg) => log.debug(msg),
  };
}

function createServiceContext(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  service?: PluginServiceRegistration;
}): OpenClawPluginServiceContext {
  const grantsInternalDiagnostics =
    params.service?.origin === "bundled" &&
    params.service.pluginId === params.service.service.id &&
    (params.service.service.id === "diagnostics-otel" ||
      params.service.service.id === "diagnostics-prometheus");

  return {
    config: params.config,
    workspaceDir: params.workspaceDir,
    stateDir: STATE_DIR,
    logger: createPluginLogger(),
    ...(grantsInternalDiagnostics
      ? {
          internalDiagnostics: {
            emit: emitTrustedDiagnosticEvent,
            onEvent: onInternalDiagnosticEvent,
          },
        }
      : {}),
  };
}

export type PluginServicesHandle = {
  stop: () => Promise<void>;
};

export async function startPluginServices(params: {
  registry: PluginRegistry;
  config: OpenClawConfig;
  workspaceDir?: string;
}): Promise<PluginServicesHandle> {
  // Roura hardened mode: scrub telemetry/proxy env keys once at startup
  // so any plugin that initializes lazily later cannot read stale values.
  // This is a no-op when ROURA_HARDENED_MODE is unset.
  if (isRouraHardenedMode()) {
    const scrubbed = scrubEnvForHardenedMode();
    if (scrubbed.length > 0) {
      log.info(
        `Roura hardened mode: scrubbed ${scrubbed.length} env key(s) before plugin activation`,
      );
    }
  }

  const running: Array<{
    id: string;
    stop?: () => void | Promise<void>;
  }> = [];
  for (const entry of params.registry.services) {
    const service = entry.service;
    // Roura hardened mode: skip any service whose plugin id (or its own
    // service id, for bundled plugins where they match) is on the
    // Roura-disabled set. No-op when the flag is unset.
    if (
      isPluginDisabledByRoura(entry.pluginId) ||
      isPluginDisabledByRoura(service.id)
    ) {
      log.warn(
        `Roura hardened mode: skipping plugin service ${service.id} (plugin=${entry.pluginId})`,
      );
      continue;
    }
    const serviceContext = createServiceContext({
      config: params.config,
      workspaceDir: params.workspaceDir,
      service: entry,
    });
    try {
      await service.start(serviceContext);
      running.push({
        id: service.id,
        stop: service.stop ? () => service.stop?.(serviceContext) : undefined,
      });
    } catch (err) {
      const error = err as Error;
      const stack = error?.stack?.trim();
      log.error(
        `plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${error?.message ?? String(err)}${stack ? `\n${stack}` : ""}`,
      );
    }
  }

  return {
    stop: async () => {
      for (const entry of running.toReversed()) {
        if (!entry.stop) {
          continue;
        }
        try {
          await entry.stop();
        } catch (err) {
          log.warn(`plugin service stop failed (${entry.id}): ${String(err)}`);
        }
      }
    },
  };
}
