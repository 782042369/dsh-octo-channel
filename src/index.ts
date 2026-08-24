/**
 * Octo IM channel for DeepSeek Harness: each DM, group, or thread drives its
 * own DSH agent, and committed answers return to Octo as text messages.
 * @module dsh-octo-channel
 */

/** Cordis plugin name; keep this stable after publishing. */
export const name = "octo-channel";

/** Services that must exist before the plugin is applied. */
export const inject: string[] = ["agents"];

export { Config } from "./config.js";
export { apply } from "./runtime.js";