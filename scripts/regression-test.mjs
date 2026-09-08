import assert from "node:assert/strict";
import { createTextPresenter } from "../lib/reply-presenter.js";
import { createTurnTarget } from "../lib/conversation.js";
import { WKSocket } from "../lib/protocol/socket.js";

/** Build a stable target for presenter tests. */
function target() {
  return createTurnTarget("chat", { chatId: "chat", senderId: "user", messageId: "message", channelType: 1 });
}

/** Verify a pending final send keeps close pending until delivery settles. */
async function testPresenterDrain() {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const port = {
    typing: async () => undefined,
    send: async () => pending,
  };
  const presenter = createTextPresenter(port, target(), { typing: false, ackDelayMs: 0, onFailure: () => undefined });
  presenter.observe({ type: "assistant/message", data: { turn: 0, message: { content: [{ type: "text", text: "answer" }] } } });
  presenter.observe({ type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } });
  let settled = false;
  const closing = presenter.close().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "close must wait for the final send");
  release();
  await closing;
  assert.equal(settled, true);
}

/** Verify oversized malformed frames are contained by the socket parser. */
function testParserContainment() {
  const socket = new WKSocket({ wsUrl: "ws://invalid", uid: "u", token: "t", onMessage: () => undefined });
  assert.doesNotThrow(() => socket.handleRawData(new Uint8Array(256 * 1024)));
  assert.doesNotThrow(() => socket.handleRawData(new Uint8Array(5 * 1024 * 1024)));
  socket.disconnect();
}

await testPresenterDrain();
testParserContainment();
console.log("Octo regression tests OK");
