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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    port.sends.push({ to, input, options: options ?? {} });
    return { messageId: "sent-" + port.sends.length };
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
        resume: async () => {
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
              // Tests decide what the simulated host turn does.
              const behavior = ctxOut.onFollowup ?? defaultFollowup;
              void behavior(sessionId, message, ctxOut);
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

function assistantText(sessionId, text) {
  return { type: "assistant/message", data: { turn: 0, message: { content: [{ type: "text", text }] } } };
}

function defaultFollowup(sessionId, message, ctxOut) {
  queueMicrotask(() => {
    ctxOut.sessionEvent(sessionId, assistantText(sessionId, "reply to: " + message.content[0].text));
    ctxOut.sessionEvent(sessionId, { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } });
  });
}

const config = {
  cwd: "/tmp/dsh-octo-integration-test",
  provider: "mock",
  model: "mock-model",
  sessionScope: "chat",
  requireMention: true,
  leanChat: true,
  ackDelayMs: 3000,
  denyTools: ["ask_user_question"],
  heartbeatIntervalMs: 30000,
};

const ctxOut = { effects: [] };
const { ctx } = makeHost(ctxOut);
const port = makeFakePort();
installChannel(ctx, config, port, (line) => console.log("  notify:", line));

await sleep(50);

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
await sleep(100);
assert(port.sends.length === 1, "exactly one outbound send");
const dmSend = port.sends[0];
assert(dmSend.to === "user_abc", "send targets the DM peer uid");
assert(dmSend.input.text?.includes("reply to: hello bot") === true, "reply carries the agent answer");
assert(dmSend.options.replyTo === "m-1", "reply quotes the triggering message");
assert(dmSend.options.channelType === 1, "DM channel type preserved");
assert(port.tyings.length >= 1 && port.tyings[0].to === "user_abc", "typing indicator fired for the DM");

console.log("[test] a second DM in the same chat reuses the same agent session");
await port.emit("message", dmMessage({ messageId: "m-2", content: "again" }));
await sleep(100);
assert(port.sends.length === 2, "second reply sent");
assert(port.sends[1].options.replyTo === "m-2", "second reply quotes m-2");

console.log("[test] multi-step turn keeps every committed text (no dropped answer)");
ctxOut.onFollowup = (sessionId, message, out) => {
  queueMicrotask(() => {
    out.sessionEvent(sessionId, assistantText(sessionId, "the real answer to: " + message.content[0].text));
    out.sessionEvent(sessionId, assistantText(sessionId, "wrap-up: memory written"));
    out.sessionEvent(sessionId, { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } });
  });
};
await port.emit("message", dmMessage({ messageId: "m-3", content: "multi" }));
await sleep(100);
assert(port.sends.length === 3, "multi-step turn sends one message");
const multiText = port.sends[2].input.text ?? "";
assert(multiText.includes("the real answer to: multi"), "keeps the real answer");
assert(multiText.includes("wrap-up: memory written"), "keeps the later committed text too");

console.log("[test] slow turn gets an ack before the answer");
const slowFollowup = (sessionId, message, out) => {
  setTimeout(() => {
    out.sessionEvent(sessionId, assistantText(sessionId, "slow answer"));
    out.sessionEvent(sessionId, { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } });
  }, 150);
};
// Swap in a second channel with a short ack delay to exercise the timer.
const ctxOut2 = { effects: [] };
const { ctx: ctx2 } = makeHost(ctxOut2);
const port2 = makeFakePort();
installChannel(
  ctx2,
  { ...config, ackDelayMs: 50, cwd: "/tmp/dsh-octo-integration-test-2" },
  port2,
  () => undefined,
);
ctxOut2.onFollowup = slowFollowup;
await sleep(30);
await port2.emit("message", dmMessage({ messageId: "m-4" }));
// The slow followup fires 150ms after submission; wait well past it.
await sleep(450);
assert(port2.sends.length === 2, "ack + answer sent");
assert(port2.sends[0].input.text?.includes("\u6b63\u5728\u5904\u7406") === true, "first send is the ack note");
assert(port2.sends[1].input.text === "slow answer", "answer still delivered after the ack");
for (const effect of ctxOut2.effects) await effect.dispose();

console.log("[test] fast turn does NOT get an ack");
const ctxOut3 = { effects: [] };
const { ctx: ctx3 } = makeHost(ctxOut3);
const port3 = makeFakePort();
installChannel(
  ctx3,
  { ...config, ackDelayMs: 200, cwd: "/tmp/dsh-octo-integration-test-3" },
  port3,
  () => undefined,
);
await sleep(30);
await port3.emit("message", dmMessage({ messageId: "m-5" }));
await sleep(300);
assert(port3.sends.length === 1, "only the answer, no ack");
for (const effect of ctxOut3.effects) await effect.dispose();

console.log("[test] group message without mention is ignored (requireMention)");
await port.emit("message", Object.freeze({
  chatId: "group_1", channelType: 2, senderId: "user_bob", messageId: "g-1",
  content: "no mention here", botMentioned: false, timestamp: Date.now(),
}));
await sleep(100);
assert(port.sends.length === 3, "no send for un-mentioned group message");

console.log("[test] group message with mention gets a reply that @-mentions the sender");
ctxOut.onFollowup = defaultFollowup;
await port.emit("message", Object.freeze({
  chatId: "group_1", channelType: 2, senderId: "user_bob", messageId: "g-2",
  content: "@bot ping", botMentioned: true, timestamp: Date.now(),
}));
await sleep(100);
assert(port.sends.length === 4, "group reply sent");
assert(port.sends[3].to === "group_1" && port.sends[3].options.channelType === 2, "group target preserved");
assert(port.sends[3].options.mentionUids?.[0] === "user_bob", "group reply @-mentions the sender");
assert(port.sends[3].input.text?.includes("[群消息, 发送者 user_bob]") === true, "group speaker labeled in the prompt");

console.log("[test] shutdown disposes cleanly");
for (const effect of ctxOut.effects) await effect.dispose();
await sleep(50);

if (failures > 0) {
  console.error(failures + " assertion(s) failed");
  process.exit(1);
}
console.log("integration test OK");
process.exit(0);
