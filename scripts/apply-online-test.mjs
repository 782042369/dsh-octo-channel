/**
 * Online test for the real apply() activation path against a live Octo server.
 * Registers, connects the WuKongIM socket, and starts the heartbeat through the
 * exact code the DSH host runs. Exits 0 once the "online as <robot_id>" line
 * appears on stderr.
 *
 * Usage: OCTO_TOKEN=... OCTO_API_URL=... node scripts/apply-online-test.mjs
 */
import { apply } from "../lib/runtime.js";

const token = process.env.OCTO_TOKEN;
const apiUrl = process.env.OCTO_API_URL;
if (!token || !apiUrl) {
  console.error("usage: OCTO_TOKEN=... OCTO_API_URL=... node scripts/apply-online-test.mjs");
  process.exit(2);
}

const effects = [];
let online = false;
let robotIdSeen = "";
const originalWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  const text = typeof chunk === "string" ? chunk : String(chunk);
  if (text.includes("online as ")) {
    online = true;
    const match = /online as (\S+)/.exec(text);
    if (match) robotIdSeen = match[1];
  }
  return originalWrite(chunk, ...rest);
};

const ctx = {
  agents: {
    get: () => undefined,
    resume: async () => { throw new Error("not expected in the online test"); },
    create: async (options) => {
      const agent = {
        id: "a1",
        session: { id: options.sessionId, requestContext: () => ({ provider: "p", model: "m" }) },
        followup: () => undefined,
        cancel: () => undefined,
      };
      return { agent, dispose: async () => undefined };
    },
  },
  get: (name) => {
    if (name === "loader") return { await: async () => undefined };
    if (name === "settings") {
      return {
        register: () => ({
          get: () => ({ botToken: token, apiUrl, requireMention: true }),
          update: async () => undefined,
        }),
      };
    }
    if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "p", model: "m" }) };
    return undefined;
  },
  effect: (fn, label) => {
    const c = fn();
    effects.push({ label, dispose: async () => { if (typeof c === "function") await c(); } });
  },
  on: () => undefined,
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
};

apply(ctx, {});

const deadline = Date.now() + 30_000;
while (!online && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
}
console.log(online ? "APPLY-ONLINE OK: online as " + robotIdSeen : "APPLY-ONLINE FAILED");
for (const e of effects) await e.dispose();
await new Promise((r) => setTimeout(r, 300));
process.exit(online ? 0 : 1);
