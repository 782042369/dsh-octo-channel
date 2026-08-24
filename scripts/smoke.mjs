/**
 * Live smoke test for the Octo protocol layer against a real server.
 *
 * Usage: OCTO_TOKEN=bf_... OCTO_API_URL=https://im.example.com/api node scripts/smoke.mjs
 *        (OCTO_SEND_TEST=0 skips the greeting DM to the bot owner)
 */
import { registerBot, sendHeartbeat, sendMessage } from "../lib/protocol/api-fetch.js";
import { WKSocket } from "../lib/protocol/socket.js";

const token = process.env.OCTO_TOKEN;
const apiUrl = process.env.OCTO_API_URL;
if (!token || !apiUrl) {
  console.error("usage: OCTO_TOKEN=... OCTO_API_URL=... node scripts/smoke.mjs");
  process.exit(2);
}

console.log("[1/4] register");
const reg = await registerBot({ apiUrl, botToken: token, agentPlatform: "dsh", pluginVersion: "0.1.0" });
console.log(
  "  robot_id   =", reg.robot_id,
  "\n  ws_url     =", reg.ws_url,
  "\n  api_url    =", reg.api_url,
  "\n  owner_uid  =", reg.owner_uid,
);

console.log("[2/4] heartbeat");
await sendHeartbeat({ apiUrl, botToken: token });
console.log("  ok");

console.log("[3/4] websocket");
let connected = false;
const socket = new WKSocket({
  wsUrl: reg.ws_url,
  uid: reg.robot_id,
  token: reg.im_token,
  onMessage: (message) => console.log("  WS message:", JSON.stringify(message).slice(0, 400)),
  onConnected: () => {
    connected = true;
    console.log("  WS CONNECTED (CONNACK received)");
  },
  onDisconnected: () => console.log("  WS DISCONNECTED"),
  onError: (error) => console.log("  WS ERROR:", error.message),
});
socket.connect();
const deadline = Date.now() + 20_000;
while (!connected && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!connected) {
  console.error("  WS did not connect within 20s");
  socket.disconnect();
  process.exit(1);
}

console.log("[4/4] test send");
if (process.env.OCTO_SEND_TEST !== "0" && reg.owner_uid) {
  const sent = await sendMessage({
    apiUrl,
    botToken: token,
    channelId: reg.owner_uid,
    channelType: 1,
    content: "dsh-octo-channel 冒烟测试：bot 注册/心跳/WS 均正常，DSH 渠道插件已就绪。",
  });
  console.log("  sent to owner, message_id =", sent?.message_id);
} else {
  console.log("  skipped (OCTO_SEND_TEST=0)");
}

socket.disconnect();
console.log("smoke OK");
process.exit(0);
