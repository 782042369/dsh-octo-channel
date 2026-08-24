# dsh-octo-channel

> Octo IM channel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): each Octo DM, group, or thread drives its own DSH agent session; committed answers return to Octo as text messages, with typing indicators and an online heartbeat.

This plugin ports the protocol layer of [openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo) (Apache-2.0, see [NOTICE](./NOTICE)) onto the DeepSeek Harness channel-plugin architecture (Cordis plugin + per-chat owned agents, as in [dsh-feishu-channel](https://github.com/whoisjiahao/dsh-feishu-channel)).

## What it does

- Registers your bot with the Octo server (`POST /v1/bot/register`) and keeps it **online** (WebSocket + 30s heartbeat).
- Receives DMs and group/thread messages over the WuKongIM WebSocket (auto-reconnect, dedupe).
- Group chats respond only when the bot is @-mentioned (`@bot`, `@所有AI`; `@所有人` passes too) — set `requireMention: false` to hear everything.
- Each conversation facet (DM / group / thread) owns its own DSH agent session, resumed across restarts. Replies land as quoted text messages and @-mention the sender in groups.

MVP scope: **text in, text out**. Images/files, rich cards, approvals, and slash commands are follow-up work.

## Install

```bash
# from a git tag (recommended)
dsh plugin --profile web add github:782042369/dsh-octo-channel#v0.1.0

# or from a local tarball / directory
dsh plugin --profile web add ./dsh-octo-channel-0.1.0.tgz
dsh plugin --profile web add file:/abs/path/dsh-octo-channel
```

Then make sure the plugin is in the profile bundle list (`~/.dsh/profiles/<profile>/package.json` → `dsh.profile.bundles` should contain `"dsh-octo-channel"`) and restart `dsh web`.

## Configure

Credentials are read from the `octo-channel` section of the DSH user settings (`~/.dsh/settings.yaml`), or from the profile composition:

```yaml
octo-channel:
  botToken: bf_your_bot_token_here   # bf_ (BotFather) or app_ (admin console)
  apiUrl: https://im.example.com/api
  # wsUrl: wss://...            # optional; auto-detected from register
  # requireMention: true        # default true for groups
  # sessionScope: chat          # chat | chat-sender
  # provider: deepseek-official # optional agent model routing
  # model: deepseek-v4-flash
```

| Field | Default | Description |
|---|---|---|
| `botToken` | — (required) | Octo bot token (`bf_...` user bot or `app_...` app bot) |
| `apiUrl` | — (required) | Octo server REST base URL |
| `wsUrl` | auto | WuKongIM WebSocket URL (from the register response) |
| `requireMention` | `true` | Group chats only respond to @-mentions |
| `sessionScope` | `chat` | `chat`: one agent per chat; `chat-sender`: per-sender in groups |
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
