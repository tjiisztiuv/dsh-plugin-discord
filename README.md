# dsh-plugin-discord

DeepSeek Harness（dsh）的 Discord 桥接插件：在手机或 Mac 的 Discord 里，和 DeepSeek 客户端**任意一个工作区**里的会话对话、接入桌面端正在用的会话、审批工具调用、随时停止任务。

## 它怎么工作

插件是一个标准的 dsh **bundle**，装进 DeepSeek 桌面端（或 `dsh web`）的 profile 后，**直接运行在 Harness Host 进程里**，调用的是桌面端界面本身用的同一套 Host API（`ctx.sessionController`、`ctx.workspaceRegistry`）：

- 从 Discord 新建的会话就是普通会话：立刻出现在桌面端侧边栏对应工作区下，用当前默认模型、默认 agent preset 和权限设置。
- 在桌面端打开的会话也可以从 Discord 接入（`/attach`），两边任意一端输入，回复都会同步到 Discord。
- 工具审批同时出现在 Discord（按钮）和桌面端，**谁先点算谁的**；Discord 先答时桌面端的审批框会自动收起。
- 不需要额外进程、不暴露任何端口，Discord bot 只做出站连接。

Discord 侧的映射：

| Discord | Harness |
|---|---|
| 私信（DM） | 一个会话；`/new` 换一个新会话 |
| 文字频道 | 一个默认工作区（`/use` 选择）；在频道里直接发消息会自动开一个线程 |
| 线程 | 一个会话；会话标题生成后线程会自动改名 |

## 1. 创建 Discord Bot

1. 打开 <https://discord.com/developers/applications> → **New Application**。
2. 左侧 **Bot** → **Reset Token**，复制 token。
3. 同页打开 **Privileged Gateway Intents → MESSAGE CONTENT INTENT**（必须，否则读不到消息正文）。
4. 左侧 **OAuth2 → URL Generator**：Scopes 勾选 `bot` 和 `applications.commands`；Bot Permissions 勾选 `View Channels`、`Send Messages`、`Create Public Threads`、`Send Messages in Threads`、`Manage Threads`、`Read Message History`、`Add Reactions`、`Attach Files`。用生成的链接把 bot 邀请进你自己的服务器。
5. 获取你的用户 ID：Discord 设置 → 高级 → 打开开发者模式 → 右键自己的头像 → 复制用户 ID。

> 私信 bot 的前提是你和 bot 在同一个服务器里。

## 2. 构建插件

```bash
git clone https://github.com/tjiisztiuv/dsh-plugin-discord.git
cd dsh-plugin-discord
npm install      # 或 pnpm install
npm run build    # 生成 lib/
```

## 3. 配置 token

token 不写进配置文件，而是通过 dsh 的凭据系统读取（默认变量名 `DISCORD_BOT_TOKEN`）。任选一种：

- 写到 `~/.dsh/.env`：`DISCORD_BOT_TOKEN=xxxxx`
- 或写到 `~/.dsh/.credentials.yaml`（dsh 本地凭据库）

> `.env` 只在桌面端启动时读取一次：写入或修改后要**彻底退出（Cmd+Q）再重新打开**，只在插件页重新启用读不到新值。变量名要和配置里的 `tokenEnv` 完全一致。

## 4. 安装进 DeepSeek 桌面端

**方式 A：桌面端界面**——侧边栏「插件」页 → 安装 → 填插件目录的绝对路径，例如 `/Users/you/code/dsh-plugin-discord`。

**方式 B：命令行**（`dsh web` 或其他 profile）：

```bash
dsh plugin --profile <profile> add /path/to/dsh-plugin-discord
```

本地路径以 link 方式安装，之后修改代码只需 `npm run build` 再在插件页里重新启用（或重启）即可。

## 5. 填写配置（必须）

插件默认 `allowedUserIds` 为空，此时 bot **不会上线**（日志里会提示）。在 profile 自己的 `cordis.patch.yml` 里覆盖 `discord` 这一行，例如桌面端是 `~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- id: discord
  config:
    tokenEnv: DISCORD_BOT_TOKEN
    allowedUserIds: ['123456789012345678']     # 你的 Discord 用户 ID
    stateFile: !!js dshHomePath('discord', 'state.json')
    defaultWorkspace: my-project                # 可选：没选工作区时默认用哪个（标题/路径/ID）
    # allowedGuildIds: ['...']                  # 可选：只在这些服务器响应
    # allowedChannelIds: ['...']                # 可选：只在这些频道（及其线程）响应
```

> patch 会整体替换这一行的 `config`，所以要把需要的键都写全。保存后启用了 HMR 的 profile 会自动重载；否则重启桌面端。

### 全部配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `tokenEnv` | `DISCORD_BOT_TOKEN` | bot token 的凭据引用名 |
| `allowedUserIds` | `[]` | 允许使用 bot 的用户 ID；为空时 bot 不上线 |
| `allowedGuildIds` | `[]` | 服务器白名单，空 = 不限制（不影响私信） |
| `allowedChannelIds` | `[]` | 频道白名单，线程按父频道匹配，空 = 不限制（不影响私信） |
| `stateFile` | `~/.dsh/discord/state.json` | 频道 ↔ 会话绑定的持久化文件 |
| `defaultWorkspace` | — | 频道没选工作区时使用的工作区 |
| `timeZone` | 本机时区 | 随 prompt 发送的 IANA 时区 |
| `approvals` | `race` | `race`：Discord 与桌面端同时可审批，先答者生效；`desktop`：只在桌面端审批 |
| `toolCalls` | `compact` | `compact`：每轮一条可编辑的工具调用进度消息；`off`：不显示 |
| `showReasoning` | `false` | 以引用格式显示模型思考过程 |
| `mirrorDesktopInput` | `true` | 把在桌面端输入的消息同步到 Discord |
| `registerCommands` | `true` | 上线时注册全局斜杠命令 |
| `commandPrefix` | `!` | 文本命令前缀 |
| `messageChunkSize` | `1900` | 单条 Discord 消息最大字符数（上限 2000） |
| `sessionListLimit` | `10` | `/sessions` 列出的会话数 |
| `progressMaxLines` | `12` | 进度消息保留的工具调用行数 |
| `progressEditIntervalMs` | `1500` | 进度消息最小编辑间隔 |
| `typingIntervalMs` | `8000` | 运行中「正在输入」提示的刷新间隔 |
| `maxImageBytes` | `8 MiB` | 转发给模型的图片附件上限 |
| `approvalArgumentChars` | `900` | 审批卡片里展示的工具参数字符数 |
| `requestTimeoutMs` | `60000` | 调用 Host API（新建、发送、列表）的超时 |

## 使用

直接发消息 = 发给这里绑定的会话；没有绑定时，会在当前默认工作区新建一个会话（文字频道里会自动开线程）。图片附件会作为图片输入发给模型，其他附件以链接形式附在消息里。

| 斜杠命令 | 文本命令 | 作用 |
|---|---|---|
| `/ws` | `!ws` | 列出工作区（👉 为当前默认） |
| `/use workspace` | `!use <名称/序号>` | 设置这里新建会话用的工作区 |
| `/new [prompt] [workspace]` | `!new [内容]` | 新建会话 |
| `/sessions [workspace]` | `!sessions` | 最近会话（▶️ 运行中，📍 当前绑定） |
| `/attach session` | `!attach <序号>` | 接入已有会话，例如桌面端正在跑的那个 |
| `/detach` | `!detach` | 解绑（不删除会话） |
| `/stop` | `!stop` | 停止当前任务（排队的消息保留） |
| `/steer text` | `!steer <内容>` | 任务运行中插话引导 |
| `/status` | `!status` | 查看绑定的工作区和会话 |
| — | `!help` | 帮助 |

斜杠命令的 workspace / session 参数都支持自动补全。全局命令首次注册后可能要等几分钟才出现在客户端里，期间可以先用文本命令。

一个会话同一时间只绑定一个 Discord 位置：在别处 `/attach` 同一个会话时，原来的位置会收到「已转到 …」的提示。

## 安全须知

- 这个插件让 Discord 消息直接驱动你本机的 agent 读写文件、执行命令，**等同远程 shell**。务必配置 `allowedUserIds`，只把 bot 放进你自己的私人服务器。
- 审批策略沿用会话自己的权限预设；在完全放行（full access）的预设下不会出现审批。
- token 只放在本机凭据里，不要提交到仓库。

## 开发

```bash
npm run typecheck          # 类型检查
npm test                   # 单元测试（vitest）
npm run typecheck:compat   # 用旁边的 deepseek-harness 源码校验 src/dsh.ts 里的 Host API 类型是否仍然匹配
```

插件刻意不依赖具体版本的 `@deepseek-ai/dsh-*` 包：用到的 Host API 在 `src/dsh.ts` 里以结构类型声明，`typecheck:compat` 负责在 Harness 升级时发现不兼容。运行时只用到 Host 提供的 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`（peer 依赖）和 `discord.js`。

代码结构：

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：注入 Host 服务、订阅 `session/event` 与 `approval/request`、管理 bot 生命周期 |
| `src/bridge.ts` | 与 Discord 无关的核心：频道↔会话绑定、发 prompt、渲染会话事件、审批竞速 |
| `src/commands.ts` | 斜杠命令定义与命令实现（斜杠命令和 `!` 文本命令共用） |
| `src/discord.ts` | discord.js 客户端：权限校验、消息路由、交互、按钮、发送队列实现 |
| `src/state.ts` | 绑定关系的 JSON 持久化 |
| `src/format.ts` | 分段（保持代码块完整）、工具调用摘要等纯函数 |
| `src/dsh.ts` | 用到的 Harness Host API 结构类型 |

## 已知限制

- `ask_user_question`（模型向用户提问）目前只在桌面端作答。
- 回复在每个模型步骤结束后整段发送，不做逐字流式编辑。
- token 写在 `~/.dsh/.env` 时需要彻底重启桌面端才会上线；写在 `~/.dsh/.credentials.yaml` 时在插件页重新启用即可。
