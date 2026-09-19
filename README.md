<p align="center">
  <img src="https://raw.githubusercontent.com/782042369/dsh-octo-channel/main/assets/readme-hero.png" width="220" alt="Octo 聊天机器人与 DSH agent 会话相连的示意图">
</p>

<h1 align="center">dsh-octo-channel</h1>

<p align="center">把 Octo 即时通讯接入 DeepSeek Harness：每个私聊、群聊或话题各自拥有一个 DSH agent 会话，回答以文本消息回到 Octo。</p>

<p align="center">
  <a href="https://github.com/782042369/dsh-octo-channel/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-22C55E?style=flat-square" alt="License: Apache 2.0"></a>
  <img src="https://img.shields.io/badge/Node-%3E%3D20-3776AB?style=flat-square" alt="Node.js 20 及以上">
  <a href="https://www.npmjs.com/package/dsh-octo-channel"><img src="https://img.shields.io/npm/v/dsh-octo-channel?style=flat-square&color=F59E0B" alt="npm 版本"></a>
  <img src="https://img.shields.io/badge/DSH-plugin%20bundle-4F46E5?style=flat-square" alt="DeepSeek Harness 插件包">
</p>

这是一个 DeepSeek Harness（DSH）的 Cordis 插件，把 Octo 的机器人消息接进 DSH agent：收到消息后由宿主 agent 处理，提交的回答再作为文本消息发回聊天。协议层移植自 openclaw-channel-octo（Apache-2.0，见 NOTICE），插件结构沿用 dsh-feishu-channel 的「每会话一个自有 agent」模型。

## 核心能力

| 能力 | 说明 |
|---|---|
| 每个会话一个 agent | 私聊、群聊、话题各自持有独立 DSH 会话，重启后按会话键恢复，不会串话 |
| 群聊仅在被 @ 时响应 | `requireMention` 默认开启；@机器人、@所有AI 与广播 @ 都算命中，私聊始终响应 |
| 默认只服务 owner | `accessMode` 默认 `owner`（仅注册返回的 `owner_uid`），另支持白名单与显式 open |
| 长回答自动分片 | `maxReplyChars` 默认 3500，超长回答拆成多条，不会因超限被服务端拒收 |
| 连接就绪与自愈 | 等到 WuKongIM CONNACK 才对外可用；断线自动重连；致命失败重新注册并指数退避，避免同 token 互踢 |
| 面向对话的性能取舍 | `leanChat` 让聊天会话跳过每轮记忆/待办收尾；`ackDelayMs` 到点先回「收到，正在处理…」 |

## 快速安装

```bash
# 从 npm 安装指定版本（推荐）
dsh plugin --profile web add dsh-octo-channel@0.3.1

# 或从 GitHub 标签安装
dsh plugin --profile web add github:782042369/dsh-octo-channel#v0.3.1

# 或从本地目录 / tarball 安装
dsh plugin --profile web add file:/abs/path/dsh-octo-channel
dsh plugin --profile web add ./dsh-octo-channel-0.3.1.tgz
```

要求 Node.js >= 20 且本机已安装 DeepSeek Harness（`dsh` CLI）。安装后确认 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 含 `dsh-octo-channel`，然后重启 `dsh web`。

## 快速开始

1. 在 Octo BotFather（或管理台）创建机器人，取得 `bf_` 或 `app_` 开头的 botToken。
2. 在 `~/.dsh/settings.yaml` 写入最小配置：

```yaml
octo-channel:
  botToken: bf_your_bot_token_here
  apiUrl: https://im.example.com/api
```

3. 重启 `dsh web`，日志出现 `octo-channel: online as <robot_id> (owner <uid>)` 即已上线。
4. 在 Octo 里私聊该机器人，或在群里 @ 它，回答会以引用消息回到聊天。

## 配置

凭据来自 DSH 用户设置（`~/.dsh/settings.yaml`）的 `octo-channel` 段，也可写在 profile 组合里。

```yaml
octo-channel:
  botToken: bf_your_bot_token_here   # bf_（BotFather）或 app_（管理台）
  apiUrl: https://im.example.com/api
  # wsUrl: wss://...            # 可选；默认由注册响应给出
  # accessMode: owner           # owner | allowlist | open（安全默认：owner）
  # allowedUserIds: [user_uid]  # allowlist 模式使用
  # allowedChatIds: [group_no]  # allowlist 模式使用
  # requireMention: true        # 群聊默认必须 @
  # sessionScope: chat          # chat | chat-sender
  # leanChat: true              # 跳过每轮记忆/待办收尾，回复更快
  # ackDelayMs: 3000            # 3 秒未出答案先回「收到，正在处理…」（0 = 关闭）
  # maxReplyChars: 3500         # 超长回答分片
  # turnIdleTimeoutMs: 1800000  # 30 分钟无宿主事件则收尾
  # provider: deepseek-official # 可选：为聊天 agent 指定模型路由
  # model: deepseek-v4-flash
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `botToken` | 必填 | Octo 机器人 token（`bf_...` 或 `app_...`） |
| `apiUrl` | 必填 | Octo REST 基础地址 |
| `wsUrl` | 自动 | WuKongIM WebSocket 地址（取注册响应） |
| `accessMode` | `owner` | `owner`：仅注册 owner；`allowlist`：显式名单；`open`：所有被允许的会话 |
| `allowedUserIds` / `allowedChatIds` | `[]` | 白名单；`allowlist` 模式需至少配置一项 |
| `deniedUserIds` / `deniedChatIds` | `[]` | 黑名单，先于白名单判定 |
| `requireMention` | `true` | 群聊仅响应 @ |
| `sessionScope` | `chat` | `chat`：每会话一个 agent；`chat-sender`：群内按发送者再分 |
| `leanChat` | `true` | 聊天会话跳过每轮记忆/待办收尾，工具仍可显式调用 |
| `ackDelayMs` | `3000` | 超时先回执；`0` 关闭 |
| `maxReplyChars` | `3500` | 出站消息分片阈值 |
| `turnIdleTimeoutMs` | `1800000` | 宿主长时间无事件则收尾该回合（typing 心跳 10 分钟后自停） |
| `maxMessageChars` | `12000` | 入站消息长度上限 |
| `maxQueuedTurns` | `3` | 每会话排队上限，超出回「正在处理较多任务」 |
| `heartbeatIntervalMs` | `30000` | 在线心跳周期 |
| `cwd` | `~/.dsh-octo` | 聊天 agent 的工作目录 |
| `provider` / `model` | 宿主默认 | 聊天 agent 的模型路由覆盖 |
| `denyTools` | `ask_user_question`、`exit_plan_mode` | 聊天里不可用的工具（回答无法回到聊天） |

## 自检与排障

```bash
# 确认 profile 里装的是哪个版本
node -e "console.log(require(process.env.HOME + '/.dsh/profiles/web/package.json').dependencies?.['dsh-octo-channel'])"

# 离线全套测试（无需 Octo 服务端）
npm test
```

常见日志：`online as ...` 上线成功；`warning - accessMode=open ...` 提醒处于开放模式；`accessMode=allowlist has no entries` 表示白名单为空、所有入站都会被拒；`connection lost, reconnecting` 表示断线重连中。

## 开发与测试

```bash
npm install
npm run build       # tsc -> lib/
npm run typecheck
npm test            # typecheck + build + 集成/回归/协议加密测试

# 需要真实 Octo 服务的在线测试
OCTO_TOKEN=bf_... OCTO_API_URL=https://im.example.com/api node scripts/apply-online-test.mjs
OCTO_TOKEN=bf_... OCTO_API_URL=https://im.example.com/api node scripts/smoke.mjs
```

## 目录结构

```text
src/
  index.ts              Cordis 入口（name / inject / Config / apply）
  config.ts             配置 schema 与默认值
  runtime.ts            apply()：设置、传输、装载 channel
  channel.ts            每会话 agent 装配与会话事件循环
  port.ts               Octo 传输（注册 / WS / 心跳 / 发送）
  agent-registry.ts     每会话 agent 生命周期
  turn-coordinator.ts   消息与宿主回合的关联
  reply-presenter.ts    文本回复、分片与 typing 保活
  conversation.ts       会话键与宿主 session id
  host.ts               DSH 宿主契约的窄接口
  protocol/             移植的 Octo 协议（见 NOTICE）
```

| 主题 | 内容 | 链接 |
|---|---|---|
| 版本变更 | 每个版本的改动与修复 | [CHANGELOG.md](./CHANGELOG.md) |
| 协议来源与许可 | 上游协议层的归属说明 | [NOTICE](./NOTICE) |
| DSH 插件装载 | 声明为 DSH profile bundle 的补丁 | [cordis.patch.yml](./cordis.patch.yml) |
| 测试脚本 | 集成、回归、加密与冒烟测试 | [scripts/](./scripts) |

## 许可证

Apache-2.0。`src/protocol/` 下的协议层移植自 [Mininglamp-OSS/openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo)（Apache-2.0），详见 [NOTICE](./NOTICE)。
