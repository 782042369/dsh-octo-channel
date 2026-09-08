/**
 * Runtime boundary and Cordis activation for the plugin.
 * @module dsh-octo-channel/runtime
 */
import type { Context } from "@deepseek-ai/cordis";
import { Config, resolveConfig, type ResolvedConfig } from "./config.js";
import { installChannel } from "./channel.js";
import type { HostLoader, HostSettings } from "./host.js";
import { OctoPort } from "./port.js";

/** The user-settings namespace holding this plugin's section. */
const SETTINGS_NAMESPACE = "octo-channel";

/** The plugin version reported to the Octo server at registration. */
const PLUGIN_VERSION = "0.2.0";

/** A resolved configuration carrying enough credentials to connect. */
function hasCredentials(config: ResolvedConfig): boolean {
  return (
    typeof config.botToken === "string" && config.botToken !== "" &&
    typeof config.apiUrl === "string" && config.apiUrl !== ""
  );
}

/**
 * Apply the plugin to its Cordis context. With botToken + apiUrl configured
 * (profile composition or the octo-channel section of the host settings),
 * the transport registers, connects, and starts serving chats.
 * @param ctx - scoped plugin context; requires the agents service.
 * @param config - configuration resolved by Cordis from the exported schema.
 */
export function apply(ctx: Context, config: Config): void {
  let active = true;
  let started = false;

  const notify = (line: string): void => {
    void process.stderr.write(line + "\n");
  };

  ctx.effect(() => () => {
    active = false;
  }, "octo:lifetime");

  const start = (resolved: ResolvedConfig): void => {
    if (!active || started) return;
    started = true;
    const port = new OctoPort({
      botToken: resolved.botToken as string,
      apiUrl: resolved.apiUrl as string,
      ...(resolved.wsUrl === undefined ? {} : { wsUrl: resolved.wsUrl }),
      heartbeatIntervalMs: resolved.heartbeatIntervalMs,
      pluginVersion: PLUGIN_VERSION,
      log: notify,
    });
    installChannel(ctx, resolved, port, notify);
  };

  const bootstrap = async (): Promise<void> => {
    await (ctx.get("loader") as HostLoader | undefined)?.await();
    if (!active) return;

    let resolved = resolveConfig(config);
    const settings = ctx.get("settings") as HostSettings | undefined;
    if (settings !== undefined) {
      try {
        const scope = settings.register(SETTINGS_NAMESPACE, Config, { base: config });
        resolved = resolveConfig(scope.get() as Config);
      } catch (error) {
        ctx.logger.error(
          "settings registration failed; continuing with entry config only: %s",
          error instanceof Error ? error.message : error,
        );
      }
    }

    if (hasCredentials(resolved)) {
      if (resolved.accessMode === "open") {
        notify("octo-channel: warning - accessMode=open grants the bot to every permitted chat");
      } else if (resolved.accessMode === "allowlist" && resolved.allowedUserIds.length === 0 && resolved.allowedChatIds.length === 0) {
        notify("octo-channel: accessMode=allowlist has no entries; all inbound messages will be denied");
      } else if (resolved.accessMode === "owner") {
        notify("octo-channel: accessMode=owner (secure default)");
      }
      notify("octo-channel: starting bot (" + resolved.apiUrl + ")");
      start(resolved);
      return;
    }
    notify(
      "octo-channel: botToken/apiUrl are not configured - add an " +
        "'octo-channel:' section (botToken, apiUrl) to the host settings or the " +
        "profile composition, then restart.",
    );
  };

  void bootstrap().catch((error: unknown) => {
    ctx.logger.error("octo-channel bootstrap failed: %s", error instanceof Error ? error.message : error);
  });
}
