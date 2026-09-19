# dsh-octo-channel

> Octo IM channel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): each Octo DM, group, or thread drives its own DSH agent session; committed answers return to Octo as text messages, with typing indicators and an online heartbeat.

This plugin ports the protocol layer of [openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo) (Apache-2.0, see [NOTICE](./NOTICE)) onto the DeepSeek Harness channel-plugin architecture (Cordis plugin + per-chat owned agents, as in [dsh-feishu-channel](https://github.com/whoisjiahao/dsh-feishu-channel)).

## What it does

- Registers your bot with the Octo server (`POST /v1/bot/register`) and keeps it **online** (WebSocket + 30s heartbeat).
- Receives DMs and group/thread messages over the WuKongIM WebSocket (auto-reconnect, dedupe).
- Group chats respond only when the bot is @-mentioned (`@bot`, `@所有AI`, or broadcast mentions) — set `requireMention: false` to hear everything.
- Each conversation facet (DM / group / thread) owns its own DSH agent session, resumed across restarts. Replies land as quoted text messages and @-mention the sender in groups.

MVP scope: **text in, text out**. Images/files, rich cards, approvals, and slash commands are follow-up work.

## Install

```bash
# from a git tag (recommended)
dsh plugin --profile web add github:782042369/dsh-octo-channel#v0.2.0

# or from a local tarball / directory
dsh plugin --profile web add ./dsh-octo-channel-0.2.0.tgz
dsh plugin --profile web add file:/abs/path/dsh-octo-channel
```

Then make sure the plugin is in the profile bundle list (`~/.dsh/profiles/<profile>/package.json` → `dsh.profile.bundles` should contain `"dsh-octo-channel"`) and restart `dsh web`.

## Configure

Credentials are read from the `octo-channel` section of the DSH user settings (`~/.dsh/settings.yaml`), or from the profile composition.

Security defaults are owner-first: `accessMode: owner` accepts only the `owner_uid` returned by registration. For team use, choose `accessMode: allowlist` and configure explicit users/chats. `accessMode: open` is available only for a deliberately private deployment and emits a warning.

```yaml
octo-channel:
  botToken: bf_your_bot_token_here   # bf_ (BotFather) or app_ (admin console)
  apiUrl: https://im.example.com/api
  # wsUrl: wss://...            # optional; auto-detected from register
  # accessMode: owner           # owner | allowlist | open (secure default: owner)
  # allowedUserIds: [user_uid]  # used by allowlist mode
  # allowedChatIds: [group_no]  # used by allowlist mode
  # requireMention: true        # default true for groups
  # sessionScope: chat          # chat | chat-sender
  # leanChat: true              # default true; skip per-round memory/todo wrap-up for fast replies
  # ackDelayMs: 3000            # send "收到，正在处理…" if the answer is not ready after 3s (0 = off)
  # maxReplyChars: 3500         # longer answers are split into several messages
  # turnIdleTimeoutMs: 1800000  # finalize a turn when the host stops emitting events for 30 min
  # provider: deepseek-official # optional agent model routing
  # model: deepseek-v4-flash
```

| Field | Default | Description |
|---|---|---|
| `botToken` | — (required) | Octo bot token (`bf_...` user bot or `app_...` app bot) |
| `apiUrl` | — (required) | Octo server REST base URL |
| `wsUrl` | auto | WuKongIM WebSocket URL (from the register response) |
| `accessMode` | `owner` | `owner`: registration owner only; `allowlist`: explicit IDs; `open`: all permitted chats |
| `allowedUserIds` / `allowedChatIds` | `[]` | Explicit sender/chat allowlists; required for useful `allowlist` mode |
| `requireMention` | `true` | Group chats only respond to @-mentions |
| `sessionScope` | `chat` | `chat`: one agent per chat; `chat-sender`: per-sender in groups |
| `leanChat` | `true` | Chat agents skip per-round memory/todo wrap-up protocols so replies stay fast; the tools stay available on explicit request |
| `ackDelayMs` | `3000` | If the first committed answer takes longer than this, a “收到，正在处理…” note is sent first; `0` disables the ack |
| `maxReplyChars` | `3500` | Outbound replies longer than this are split into several messages so a long answer cannot be rejected by the server |
| `turnIdleTimeoutMs` | `1800000` | Finalize a turn in the chat when the host stops emitting events for this long (typing keep-alive also stops after 10 min) |
| `heartbeatIntervalMs` | `30000` | Online-status heartbeat cadence |
| `cwd` | `~/.dsh-octo` | Workspace directory for chat-driven agents |
| `provider` / `model` | host default | Provider/model routing override for chat agents |

## Verify

```bash
# the profile package should list the dependency
node -e "console.log(require(process.env.HOME + '/.dsh/profiles/web/package.json').dependencies?.['dsh-octo-channel'])"
```

Start `dsh web`, watch the plugin log for `octo-channel: online as <robot_id> (owner <uid>)`, then DM your bot in Octo and @-mention it in a group.

## Development

```bash
npm install
npm run build       # tsc -> lib/
npm run typecheck
```

### Tests

```bash
# Offline: drives fake inbound messages through the whole glue (DM reply,
# session reuse, group mention gating, clean shutdown). No server needed.
node scripts/integration-test.mjs

# Online: runs the real apply() activation path (register + WebSocket +
# heartbeat) against a live Octo server.
OCTO_TOKEN=bf_... OCTO_API_URL=https://im.example.com/api node scripts/apply-online-test.mjs

# Protocol-only smoke (register / heartbeat / WS CONNACK / greeting DM).
OCTO_TOKEN=bf_... OCTO_API_URL=https://im.example.com/api node scripts/smoke.mjs
```

### Layout

```
src/
  index.ts              Cordis entry (name / inject / Config / apply)
  config.ts             schema + defaults
  runtime.ts            apply(): settings, port, installChannel
  channel.ts            per-chat agent wiring + session event loop
  port.ts               Octo transport (register/WS/heartbeat/send)
  agent-registry.ts     owned-agent lifecycle per conversation
  turn-coordinator.ts   message ↔ turn correlation
  reply-presenter.ts    text reply + typing keep-alive
  conversation.ts       conversation keys + session ids
  host.ts               narrow DSH host contracts
  protocol/             ported Octo protocol (see NOTICE)
    socket.ts           WuKongIM binary WebSocket client
    api-fetch.ts        REST helpers (429-aware)
    api-error.ts        structured rate-limit error
    types.ts            wire types
```

## License

Apache-2.0. The protocol layer under `src/protocol/` is ported from [Mininglamp-OSS/openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo) (Apache-2.0); see [NOTICE](./NOTICE).
