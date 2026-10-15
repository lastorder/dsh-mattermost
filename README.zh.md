# dsh-mattermost

[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 插件：把 Mattermost 接到 DSH 会话上。它监听你指定的 Mattermost 消息——@提及、私聊机器人，或者匹配你自定义规则的消息——交给 **DSH 会话**处理，再把回答回复到 Mattermost 的原消息串里。

- **路由：** 同一个机器人账号可以响应多个 `@名称`，各自在自己的 DSH 工作区中回答——例如 `@orion-agent` 在 `orion-agent` 工作区、`@orion-wizard` 在 `orion-wizard` 工作区，分别使用各自工作区的技能和说明。
- **每条路由的会话模式：** 所有请求共用一个会话、每个 Mattermost 消息串一个新会话，或每条消息一个新会话。
- **多个环境**（服务器 / 机器人账号）可同时接入，全部在插件设置页配置。

[English](README.md) | 中文

它相当于 mm-agent-bridge（把 @提及转发给 OpenCode/Copilot 的 Python 机器人）的 DSH 内置版：不需要额外进程或 agent 服务，插件直接运行在 DSH 里，直接和会话交互。

## 工作方式

```
Mattermost ──WebSocket "posted" 事件──▶ dsh-mattermost（DSH Host 插件，每个环境一条连接）
                                         │ 是否触发？哪条路由（@名称）？频道/用户是否允许？
                                         │ 通道：同一共享会话或消息串内按顺序；其余并行
                                         ▼
              路由所在工作区的 DSH 会话（提示 = 来源说明 + 消息串上下文 + @用户: 内容）
                                         │ 等待这条提示对应的那一轮结束
                                         ▼
Mattermost 消息串 ◀──REST 更新/发帖── 最终回答（过长时自动拆分）
```

1. 每个启用的环境用自己的机器人 Token 登录（`GET /api/v4/users/me`），保持事件 WebSocket 连接（Token 认证、心跳、断线指数退避重连）。
2. 消息满足[触发规则](#触发规则)并通过该环境的频道、用户过滤时才处理；消息中使用的 `@名称` 决定**路由**——由哪个 DSH 工作区、以哪种会话模式回答。忽略自己的消息、系统消息、其他机器人和 Webhook。
3. 发往同一个共享会话（或线程模式下同一个消息串）的请求**按顺序**处理；不同路由、不同消息串和新会话**并行**处理，上限为 `maxConcurrent`。需要等待的请求先收到“已排队”提示；开始处理时同一条帖子变为“正在处理…”，最后被替换成回答——每个请求只占一条帖子，与 mm-agent-bridge 一致。
4. 发给 DSH 的内容包括一行来源说明（`[Mattermost] Message from @alice in ~town-square …`）、消息串里之前的消息（如果是在消息串中提问）以及 `@alice: <内容>`。它和在 DSH 窗口里输入的提示完全一样进入会话，你可以在 DSH 里实时看到对话。
5. 插件按请求 ID 精确等待**消费了这条提示的那一轮**结束（而不是“agent 空闲了”），然后回复该轮最后一条助手消息。失败、取消、被阻止或超时的轮次会回复相应说明。
6. 如果这一轮在 DSH 里等待人工处理——权限审批或 `ask_user_question` 提问——消息串里会显示 *Waiting for a permission approval in DSH: `bash`*，让提问者知道为什么慢。

## 安装

从 DSH 侧边栏 → **插件** 安装 [npm 包 `dsh-mattermost`](https://www.npmjs.com/package/dsh-mattermost)，或运行 `dsh plugin --profile <profile> add dsh-mattermost`。

开发时可以安装本地代码目录：

```sh
git clone https://github.com/lastorder/dsh-mattermost.git
cd dsh-mattermost
pnpm install          # 在本地解析 @deepseek-ai/schemastery（在 DSH 下次重启前需要）
```

然后在侧边栏 → **插件** 中按路径安装，或运行 `dsh plugin --profile <profile> add /path/to/dsh-mattermost`。也可以请 DSH agent 通过 `plugin_manager` 安装该目录。

添加环境之前，插件处于空闲状态。

> **更新已安装的插件：** DSH 会一直使用已加载的插件代码，修改或拉取本插件代码后需要**重启 DSH**；修改配置无需重启。

## 在 Mattermost 创建机器人账号

1. 系统控制台 → 集成 → **机器人账号**：允许创建机器人账号。
2. 集成 → 机器人账号 → **添加机器人账号**；设置用户名（如 `dsh-bot`），复制生成的**访问令牌**。
3. 把机器人加入需要监听的频道（私聊不需要）。

普通账号的个人访问令牌也可以（个人资料 → 安全 → 个人访问令牌）。请使用**专用账号**：插件会忽略自己发的消息，所以 @提及必须来自其他账号。

> 不要让 mm-agent-bridge 和本插件同时使用同一个机器人 Token，否则每条 @提及都会被回复两次。

## 在设置页配置

侧边栏 → **插件** → *Mattermost 桥接*。所有配置都可以在这里完成，点击**保存**立即生效：服务器地址或令牌变化的环境会重连，新增/删除/停用的环境会连接或断开，其余设置（包括路由）从下一条消息开始生效。

**Mattermost 环境**——每个服务器/机器人账号一张卡片，显示实时状态（*已连接 @bot*、*令牌无效*、*已停用*……）：

| 项目 | 说明 |
|---|---|
| 名称、启用开关 | 区分环境；停用的环境保留配置但断开连接。 |
| 服务器地址 | 如 `https://mattermost.example.com`（不写协议时默认 https，支持子路径部署）。 |
| 访问令牌 | 作为密钥保存：保存后不再显示，也不会发送到页面。留空表示保持不变。 |
| **测试连接** | 用填写的（或已保存的）令牌登录并验证 WebSocket，显示机器人账号或错误原因。 |
| **路由** | `@名称` → 工作区目录 → 会话模式（→ 会话），见下文。 |
| 触发方式 | @提及路由名称、私聊、已回复消息串中的后续消息、服务器提及列表、自定义正则表达式及标志。 |
| 范围 | 频道过滤（ID、名称或显示名）与用户白名单。 |
| 上线/下线通知 | 在指定频道发送上线/下线消息。 |
| 重新连接 / 删除此环境 | 针对单个环境。 |

**通用设置**（对所有环境生效）：自动新建会话、默认工作区目录（下拉选项来自当前 DSH 环境已登记的工作区）、会话标题前缀、同时处理的请求数（`maxConcurrent`）、回复内容（最后一条 / 全部助手消息）、回复超时、消息串上下文条数、排队上限、单条帖子最大长度、回复时 @提问者、“正在输入”提示、附加主机名、忽略机器人消息、提示首行。**回复文案**可替换机器人发送的所有提示语；**诊断**可设置调试日志文件和状态文件。

### 路由：由哪个工作区、哪个会话回答

一个环境（一个机器人令牌）可以有多条路由，每条路由包括：

| 项目 | 说明 |
|---|---|
| `@名称` | 选中这条路由的提及，如 `orion-agent`。留空时使用机器人账号的用户名。不必是 Mattermost 中真实存在的用户——机器人能看到所在频道的每条消息。 |
| 工作区目录 | 从当前 DSH 已登记的工作区下拉选择（显示名称和完整路径，使用该工作区的技能、`AGENTS.md`、MCP 服务）；可点“刷新”重新获取。留空时继承通用设置中的默认工作区。若旧配置路径已不在列表中，它仍显示并保持原值，直到你改选；手动在 YAML 中指定的现有目录依然可在首次使用时自动登记。 |
| 会话模式 | **同一个会话**——所有请求在同一个会话中处理；**每个消息串一个新会话**——消息串中第一次提问时新建会话，串内追问继续使用它（重启后仍然有效）；**每条消息一个新会话**——每个请求都新建会话。 |
| 会话（同一个会话模式） | 从列表中选择（列出该工作区的会话），或选“自动”：使用 `/mattermost bind` 绑定的会话，否则在第一条消息时于该工作区新建（标题 *Mattermost · @名称*）并记住。绑定的会话被删除后会自动替换。 |

**第一条路由**还负责不带 @名称的私聊、正则匹配和服务器提及；开启“后续消息无需再 @”时，消息串中的追问由回答过该消息串的路由处理。没有路由的环境相当于一条路由：`@机器人用户名` → 一个共享会话。

新建的会话标题为 *Mattermost · @名称*（同一个会话模式）或 *Mattermost · @名称 · \<请求开头\>*（消息串 / 每条消息模式），便于在 DSH 侧边栏中查找和归档。

### 触发规则

| 触发方式 | 默认 |
|---|---|
| @提及路由名称（整词匹配：`@orion-agent-dev` 不会触发 `@orion-agent`） | 开启 |
| 私聊机器人的任何消息（由第一条路由处理，除非提及了其他路由） | 开启 |
| 匹配正则表达式的消息（第一条路由）；命名分组 `prompt` 指定发给 DSH 的文字，如 `^!ask\s+(?<prompt>[\s\S]+)` | 关闭 |
| 机器人回复过的消息串里的后续消息，无需再 @（该消息串的路由） | 关闭 |
| 服务器解析的提及列表（包含 `@channel`/`@all`） | 关闭 |

通用设置中的 `ignoreBots`（默认开启）会忽略机器人和 Webhook 的消息。

## 在 cordis.patch.yml 中配置（可选）

设置页写入的是 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/<profile>/cordis.patch.yml`），你也可以手动编辑。patch 会整体替换该行的 `config`，所以要写全你设置的字段：

```yaml
- id: mattermost
  name: dsh-mattermost
  config:
    connections:
      - id: company                    # 稳定标识：改名时请保留
        name: 公司
        serverUrl: https://mattermost.example.com
        token: <机器人访问令牌>          # 或：!!js process.env.MM_TOKEN
        allowedUsers: [alice, bob]
        routes:
          - id: orion-agent
            mentionName: orion-agent
            workspace: /path/to/orion-agent
            sessionMode: shared        # shared | thread | new
          - id: orion-wizard
            mentionName: orion-wizard
            workspace: /path/to/orion-wizard
            sessionMode: new
    maxConcurrent: 3
    replyTimeoutMinutes: 30
```

全部配置项见 [README.md 的 All options](README.md#all-options)。

## `/mattermost` 命令

在任意 DSH 会话中运行。`[目标]` 可以是环境（`local`）、路由（`@orion-agent`、`local/@orion-agent`）或 `all`；只有一个选择时可省略：

| 命令 | 作用 |
|---|---|
| `/mattermost` 或 `/mattermost status` | 查看每个环境和路由的连接状态、机器人账号、工作区、会话模式和会话、队列、最近一次请求和错误 |
| `/mattermost bind [目标]` | 让**当前会话**负责回复目标中“同一个会话”模式的路由（其他模式的路由会跳过） |
| `/mattermost unbind [目标]` | 解除绑定（不带参数：解除所有绑定到当前会话的路由） |
| `/mattermost reconnect [环境\|all]` | 重新连接（默认全部） |
| `/mattermost log` | 查看最近的日志 |

## 注意事项

- **审批**：如果会话的权限模式需要审批，这一轮会暂停，直到有人在 DSH 里批准；消息串里会提示。请据此为工作区选择合适的权限预设——远程的 Mattermost 用户无法批准任何操作。
- **共享会话**：绑定的会话是普通 DSH 会话，你仍可以在 DSH 窗口中继续使用它；Mattermost 的提示会排在你自己的轮次之后，反之亦然。
- **按消息 / 按消息串新建的会话**会累积在工作区的会话列表中，可在 DSH 侧边栏归档旧会话。每个新会话都会启动工作区的 MCP 服务，所以第一次回答会慢几秒。
- **离线消息**：DSH 未运行或连接断开期间发出的消息不会补发。
- **附件**不会转发；提示中只列出文件名。

## 与 mm-agent-bridge 的配置对应

| mm-agent-bridge（`.env`） | dsh-mattermost |
|---|---|
| `MM_URL`、`MM_PORT`、`MM_SCHEME` | 环境的“服务器地址”（如 `https://host:443`） |
| `MM_TOKEN` | 环境的“访问令牌” |
| `BOT_MENTION_NAME` | 路由的“@名称”（每个名称一条路由） |
| `MENTION_BY_ID` | 环境的“同时信任服务器的提及列表” |
| `MM_USERNAME_WHITELIST` | 环境的“只允许这些用户” |
| `OPENCODE_SESSION_ID` / `COPILOT_SESSION_ID` | 路由的“会话”（同一个会话模式），或 `/mattermost bind` |
| `GREETING_*`、`GOODBYE_MESSAGE` | 环境的“上线 / 下线通知” |
| `QUEUE_MAX_SIZE` | “排队上限” |
| `THREAD_CONTEXT_MAX_MESSAGES` | “消息串上下文条数” |
| `MSG_*` | “回复文案” |
| `MSG_SHOW_HOST` | “在每条消息末尾附加主机名” |
| `AGENT_TYPE`、`OPENCODE_*`、`COPILOT_*` | 不需要——使用工作区会话自身的模型和预设 |

## 用本地 Mattermost 手动测试

仓库自带一个可随时丢弃的 Mattermost 服务器（`docker-compose.yml`：`mattermost/mattermost-preview` 镜像，自带数据库），以及一个准备测试数据的辅助脚本（`scripts/mm-local.mjs`）。

**前提：** 安装了带 Compose v2 的 Docker（Docker Desktop、OrbStack 或 colima）。该镜像只有 `linux/amd64` 版本，在 Apple Silicon 上通过 Rosetta/QEMU 模拟运行，首次启动约需一分钟。

### 1. 启动并初始化服务器

```sh
pnpm run mm:up      # 启动容器，并等到健康检查通过
pnpm run mm:setup   # 创建管理员、团队、测试用户和机器人，并打印机器人令牌
```

`mm:setup` 可以重复执行，结果保存在 `.mm-local.json`（已加入 .gitignore）；`pnpm run mm:info` 可再次打印。

| 项目 | 值 |
|---|---|
| 地址 | http://localhost:8065 —— 团队 **DSH Test**，频道 ~town-square 和 ~off-topic |
| 测试用户 | `alice`、`bob`、`carol` —— 密码 `Dsh-Test-2026!` |
| 管理员 | `dsh-admin` / `Dsh-Admin-2026!` |
| 机器人 | `@dsh-bot`；访问令牌由 `mm:setup` / `mm:info` 打印 |

8065 端口被占用？两个命令都换端口：`MM_PORT=8066 pnpm run mm:up && MM_PORT=8066 pnpm run mm:setup`。

### 2. 在 DSH 中接入

如果改过本插件的代码，先重启 DSH。然后 侧边栏 → **插件** → *Mattermost 桥接* → **添加环境**：名称 `Local`、服务器地址 `http://localhost:8065`、填入机器人令牌 → **测试连接**（应显示“连接成功：已登录为 @dsh-bot”）→ **保存**。卡片状态变为“已连接 @dsh-bot”。

要测试路由，在卡片中添加两条，例如 `@orion-agent` → 一个工作区、“同一个会话”，`@orion-wizard` → 另一个工作区、“每条消息一个新会话”，然后**保存**。在 Mattermost 中直接输入 `@orion-agent` 即可，即使没有这个用户——机器人能看到所在频道的每条消息。

### 3. 测试清单

在 http://localhost:8065 以 `alice` 登录，打开 **DSH Test → Town Square**：

| # | 操作 | 预期 |
|---|---|---|
| 1 | 发送 `@dsh-bot hello`（未配置路由时） | 消息串中先出现 *Processing your request…*，随后被回答替换；DSH 会话中能看到这条提示。 |
| 2 | 在该消息串中回复 `@dsh-bot 我刚才说了什么？` | 回答会参考消息串上下文。 |
| 3 | 打开“机器人回复过的消息串里，后续消息无需再 @”，在消息串中不带 @ 回复 | 得到回答。 |
| 4 | 和 `dsh-bot` 私聊，不带 @ | 得到回答（由第一条路由处理）。 |
| 5 | 对同一条“同一个会话”路由连续发两条 @提及（如 alice 一条，bob 在另一个浏览器一条） | 第二条先显示 *queued*，在第一条之后被回答。 |
| 6 | 配置两条路由后，分别让两个 `@名称` “只回复你的当前工作目录” | 各自从自己的工作区回答；DSH 中对应工作区下出现会话。 |
| 7 | 对 `@orion-agent` 和 `@orion-wizard` 各问两次 | `@orion-agent` 始终使用同一个会话 *Mattermost · @orion-agent*；`@orion-wizard` 每次新建会话。 |
| 8 | 把一条路由改为“每个消息串一个新会话”；提问后在同一消息串追问 | 追问继续使用该消息串的会话；新的消息串新建会话。 |
| 9 | 同时向两条路由发消息 | 两条互不等待、同时处理（`/mattermost status` 显示 2 running）。 |
| 10 | “只允许这些用户”设为 `alice`；以 `carol` 发消息 | 回复 *You do not have permission to use this agent.* |
| 11 | “只监听这些频道”设为 `town-square`；在 ~off-topic 发消息 | 不回复。 |
| 12 | 自定义匹配设为 `^!ask\s+(?<prompt>[\s\S]+)`；发送 `!ask 2+2 等于几` | 无需 @ 即得到回答（第一条路由）。 |
| 13 | “单条帖子最大长度”设为 1000；让它逐行输出 1 到 300 | 回答分成多条帖子发出。 |
| 14 | 运行 `docker restart dsh-mattermost-mm` | 卡片显示“重连中”，约一分钟内恢复“已连接”。 |
| 15 | 在 DSH 会话中运行 `/mattermost status` | 显示每条路由的工作区、会话模式、会话，以及最近一次请求。 |

也可以用 `pnpm run mm:post` 在终端发消息：它以测试用户身份发帖，并等待机器人的最终回复（没有回复时退出码为 2）。

```sh
pnpm run mm:post "@dsh-bot hello"                              # alice 在 ~town-square 发帖
pnpm run mm:post "@orion-wizard what can you do?"              # 某条路由
pnpm run mm:post --as bob --dm "hello"                         # 私聊
pnpm run mm:post --reply-to <postId> "@dsh-bot and then?"      # 在消息串中回复
pnpm run mm:post --channel off-topic --timeout 20 "@dsh-bot hi"
pnpm run mm:post --no-wait "@orion-agent one" & pnpm run mm:post --as bob --no-wait "@orion-wizard two" & wait   # 同时发两条
```

### 4. 停止

`docker compose stop` 会保留数据（之后 `docker compose start` 继续使用）；`pnpm run mm:down` 会删除容器及全部 Mattermost 数据（下次 `mm:up` 后需重新运行 `mm:setup`，并在 DSH 中更新令牌）。

## 开发

```sh
pnpm install
pnpm test            # 单元测试 + 集成测试（模拟 Mattermost 服务器、模拟 DSH、设置页逻辑与服务端渲染）
pnpm run verify      # 语法检查 + 测试
pnpm run fake-mattermost -- --port 18065 --token test-token   # 手动联调用的模拟服务器
```

模拟服务器（`scripts/fake-mattermost.js`）实现了插件用到的 REST 接口和 WebSocket，并提供控制接口：`POST /_test/post {"message":"@dsh-bot hi","user":"user-alice"}` 注入一条消息，`GET /_test/state` 查看机器人发出的内容。把它添加为一个环境（`http://127.0.0.1:18065`，令牌 `test-token`），就可以在没有 Mattermost 服务器的情况下端到端试用插件。

## 发布（维护者）

CI 流水线（`.github/workflows/ci.yml`）在推送和 PR 时运行 `pnpm run verify` 并检查 npm 包内容。发布流水线（`.github/workflows/publish.yml`）使用 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) 的 GitHub OIDC 身份，**不使用 GitHub Secrets 中的 npm token**；非预发布的 GitHub Release 且 tag 恰好为 `v<package.json 中的版本>` 时，流水线将 npm 包**暂存**，随后由 npm 包所有者使用 2FA 审批才正式发布。请仅从受保护、经过审查的 tag 发版。已有 Release 的暂存重试可手动运行同一个工作流，输入原 `tag=v0.1.1`，无需移动 tag。

**首版 `0.1.0`** 在维护者自己的电脑上发布一次：先执行 `npm login --registry=https://registry.npmjs.org/`、`pnpm run verify`，再执行 `npm publish --access public`。`prepublishOnly` 会再跑一次校验。不要提交 `.npmrc`、`.mm-local.json` 或任何凭据。已发布的版本不能再次发布。

首版发布后，包所有者须在 **npmjs.com → dsh-mattermost → Settings → Trusted Publishers** 添加 GitHub Actions 发布者：owner `lastorder`、repository `dsh-mattermost`、workflow 文件名 **`publish.yml`**，允许**暂存** npm 包即可；不必允许直接 `npm publish`，由所有者稍后审批暂存版本。无须配置 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN`。设置后需在两天内完成首次可信发布，否则按 [npm 文档](https://docs.npmjs.com/trusted-publishers/) 重新配置。后续从公开 GitHub 仓库审批发布的版本会带 provenance；本机首版不会补发 provenance。

后续发版先递增版本、提交并推送 tag，再创建 GitHub Release（以下 `0.1.2` 换成当次版本）：

```sh
npm version patch --no-git-tag-version
pnpm install --lockfile-only
pnpm run verify
git add package.json pnpm-lock.yaml
git commit -m "release: v0.1.2"
git tag v0.1.2
git push origin main v0.1.2
gh release create v0.1.2 --verify-tag --title "v0.1.2" --generate-notes
```

工作流成功后，在 npmjs.com 用 2FA 审批暂存版本（也可以由已登录的维护者运行 `npm stage list dsh-mattermost` 和 `npm stage approve <stage-id>`），再检查 `npm view dsh-mattermost version`。**暂存成功不代表已正式发布**。不要为本机已发布的 `v0.1.0` 创建 GitHub Release，否则流水线会尝试重复发布同一版本。

## 许可证

MIT
