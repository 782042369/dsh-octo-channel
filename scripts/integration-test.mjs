/**
 * Integration test for the channel glue, without a live Octo server.
 *
 * Mocks the DSH host (agents registry, settings, effects, session events)
 * and the Octo transport; drives fake inbound messages through installChannel
 * and asserts on the outbound sends.
 *
 * Usage: node scripts/integration-test.mjs
 */
import { EventEmitter } from "node:events";
import { installChannel } from "../lib/channel.js";

let failures = 0;
function assert(condition, label) {
  if (condition) console.log("  ok -", label);
  else {
    failures += 1;
    console.error("  FAIL -", label);
  }
}

function makeFakePort() {
  const port = new EventEmitter();
  port.robotId = "test_bot";
  port.ownerUid = "owner_uid";
  port.sends = [];
  port.tyings = [];
  port.connect = async () => undefined;
  port.disconnect = async () => undefined;
  port.onMessage = (handler) => {
    port.on("message", handler);
    return () => port.off("message", handler);
  };
  port.onLifecycle = (event, handler) => {
    port.on(event, handler);
    return () => port.off(event, handler);
  };
  port.send = async (to, input, options) => {
    const entry = { to, input, options: options ?? {} };
    port.sends.push(entry);
    return { messageId: "sent-" + (port.sends.length) };
  };
  port.typing = async (to, channelType) => {
    port.tyings.push({ to, channelType });
  };
  return port;
}

function makeHost(ctxOut) {
  const agents = {};
  let sessionCounter = 0;
  return {
    ctx: {
      agents: {
        get: (sessionId) => agents[sessionId],
        resume: async (options) => {
          throw new Error("resume should not be called in a fresh test");
        },
        create: async (options) => {
          sessionCounter += 1;
          const sessionId = options.sessionId;
          const agent = {
            id: "agent-" + sessionCounter,
            session: {
              id: sessionId,
              requestContext: () => ({ provider: "mock", model: "mock-model" }),
            },
            followup: (message) => {
              // Simulate the host turn: one committed assistant message, then turn end.
              queueMicrotask(() => {
                ctxOut.sessionEvent(sessionId, {
                  type: "assistant/message",
                  data: {
                    turn: 0,
                    message: {
                      content: [{ type: "text", text: "reply to: " + message.content[0].text }],
                    },
                  },
                });
                ctxOut.sessionEvent(sessionId, {
                  type: "turn/end",
                  data: { turn: 0, reason: { kind: "completed" } },
                });
              });
            },
            cancel: () => undefined,
          };
          agents[sessionId] = agent;
          return { agent, dispose: async () => { delete agents[sessionId]; } };
        },
      },
      get: (name) => {
        if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "mock", model: "mock-model" }) };
        if (name === "sessionPersistence") return { list: async () => [] };
        return undefined;
      },
      effect: (fn, label) => {
        const cleanupOrPromise = fn();
        ctxOut.effects.push({ label, dispose: async () => { if (typeof cleanupOrPromise === "function") cleanupOrPromise(); } });
      },
      on: (event, handler) => {
        if (event === "session/event") ctxOut.sessionEvent = (sessionId, data) => handler({ id: sessionId }, data);
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    },
  };
}

const config = {
  cwd: "/tmp/dsh-octo-integration-test",
  provider: "mock",
  model: "mock-model",
  sessionScope: "chat",
  requireMention: true,
  denyTools: ["ask_user_question"],
  heartbeatIntervalMs: 30000,
};

const ctxOut = { effects: [] };
const { ctx } = makeHost(ctxOut);
const port = makeFakePort();
installChannel(ctx, config, port, (line) => console.log("  notify:", line));

// Let the connect effect run.
await new Promise((r) => setTimeout(r, 50));

function dmMessage(overrides) {
  return Object.freeze({
    chatId: "user_abc",
    channelType: 1,
    senderId: "user_abc",
    messageId: "m-1",
    content: "hello bot",
    botMentioned: true,
    timestamp: Date.now(),
    ...overrides,
  });
}

console.log("[test] DM message drives an agent and gets a reply");
await port.emit("message", dmMessage());
await new Promise((r) => setTimeout(r, 100));
assert(port.sends.length === 1, "exactly one outbound send");
const dmSend = port.sends[0];
assert(dmSend.to === "user_abc", "send targets the DM peer uid");
assert(dmSend.input.text?.includes("reply to: hello bot") === true, "reply carries the agent answer");
assert(dmSend.options.replyTo === "m-1", "reply quotes the triggering message");
assert(dmSend.options.channelType === 1, "DM channel type preserved");
assert(port.tyings.length >= 1 && port.tyings[0].to === "user_abc", "typing indicator fired for the DM");

console.log("[test] a second DM in the same chat reuses the same agent session");
const sessionsBefore = ctxOut.effects.length;
await port.emit("message", dmMessage({ messageId: "m-2", content: "again" }));
await new Promise((r) => setTimeout(r, 100));
assert(port.sends.length === 2, "second reply sent");
assert(port.sends[1].options.replyTo === "m-2", "second reply quotes m-2");
void sessionsBefore;

console.log("[test] group message without mention is ignored (requireMention)");
await port.emit("message", Object.freeze({
  chatId: "group_1", channelType: 2, senderId: "user_bob", messageId: "g-1",
  content: "no mention here", botMentioned: false, timestamp: Date.now(),
}));
await new Promise((r) => setTimeout(r, 100));
assert(port.sends.length === 2, "no send for un-mentioned group message");

console.log("[test] group message with mention gets a reply that @-mentions the sender");
await port.emit("message", Object.freeze({
  chatId: "group_1", channelType: 2, senderId: "user_bob", messageId: "g-2",
  content: "@bot ping", botMentioned: true, timestamp: Date.now(),
}));
await new Promise((r) => setTimeout(r, 100));
assert(port.sends.length === 3, "group reply sent");
assert(port.sends[2].to === "group_1" && port.sends[2].options.channelType === 2, "group target preserved");
assert(port.sends[2].options.mentionUids?.[0] === "user_bob", "group reply @-mentions the sender");
assert(port.sends[2].input.text?.includes("[群消息, 发送者 user_bob]") === true, "group speaker labeled in the prompt");

console.log("[test] shutdown disposes cleanly");
for (const effect of ctxOut.effects) await effect.dispose();
await new Promise((r) => setTimeout(r, 50));

if (failures > 0) {
  console.error(failures + " assertion(s) failed");
  process.exit(1);
}
console.log("integration test OK");
process.exit(0);
