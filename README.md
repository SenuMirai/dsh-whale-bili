# dsh-bili-fishman · 鱼与人

## 🐋 这是「DSH Whale 系」的一员

一套让陪伴角色**真的在过日子**的 DSH 插件。五个仓库各自独立，装哪个都行，但装在一起才是一整只：

| 仓库 | 管什么 |
|---|---|
| [dsh-whale-world](https://github.com/SenuMirai/dsh-whale-world) | 🧠 **世界**：跨会话记忆、生活作息、世界控制台。其他几个的记忆最后都落到这里 |
| [dsh-whale-qq](https://github.com/SenuMirai/dsh-whale-qq) | 💬 **QQ**：群聊/私聊接话、主动搭话、语音、唱歌、表情包、日记、看图 |
| [dsh-whale-wechat](https://github.com/SenuMirai/dsh-whale-wechat) | 💚 **微信**：私聊/群聊接话，会 @ 人、会引用、会发语音，后台发送不抢焦点 |
| [dsh-whale-bili](https://github.com/SenuMirai/dsh-whale-bili) | 📺 **刷 B 站**：她自己开 B 站看片子、记下看了什么、偶尔想跟你说一句 |
| [dsh-whale-douyin](https://github.com/SenuMirai/dsh-whale-douyin) | 🎵 **刷抖音**：在本地 Edge 里刷抖音电脑版，按兴趣和真实观看行为更新口味 |

> 命名统一用 `dsh-whale-` 前缀，看到这个前缀就是一家的。**npm 包名沿用旧 id**（`dsh-qq-group` 这种），因为几个插件之间靠 id 互相认亲，改名会把联动弄断。

### 推荐一起装的插件（别人做的，很好用）

| 插件 | 干什么 |
|---|---|
| [dsh-see-now](https://github.com/deepseek-ai/dsh-see-now) | 让她**看得见你的屏幕**——直播式连续画面，不是一张截图 |
| [dsh-loadout](https://github.com/YongjianWan/dsh-loadout) | 按需**装卸工具组**，几十个工具不至于一次全糊进上下文 |
| [dsh-persona-distill](https://github.com/Speraymer/dsh-persona-distill) | **人格蒸馏**：从聊天记录里蒸馏出人设，省得手写几万字提示词 |

### 好用的语料

| 语料 | 干什么 |
|---|---|
| [b-corpus](https://huggingface.co/datasets/Limour/b-corpus) | 开源的 **galgame 文本库**。想让她说话带那味儿，就拿去喂人格蒸馏、做语气样本 |

---


> 她有她的日子。让她理解人，但不用产出来证明自己活着。

这是把两个插件合起来的东西：

| 来自 | 拿走了什么 | 改造了什么 |
|---|---|---|
| **dsh-bili-whale**（养鱼） | 会自己醒来、记得看过什么、想跟主人说话；**七项写入能力的接口经验** | 九步硬流程、"今天必须分享"、默认就开着的写入 |
| **dsh-bili-humanism**（人文） | 诚实取稿、可修正的记忆、允许没有新发现、**授权与额度的写法** | 无（它是被继承的那一方） |

## 为什么要有它

养鱼那套是对的：**她该有自己的日子**，不该人戳一下才动。
但它把"过日子"做成了 KPI —— 每轮醒来必须走完九步，每一步都要产出。
结果它坏掉的那四天，她写的是「今天什么都没看成」，像在交检讨。

人文那套也是对的：**允许没有推荐、没有新发现**，取稿要诚实标出覆盖了多少。
但它没有骨架 —— 不会自己醒来，不记得昨天，也不想跟谁说话。

合起来就是：**有骨架，但不逼产出。**

## 三条写在代码里的规矩

1. **没有新发现是合法结果**
   任何工具都不因为"今天没产出"而报错。`status` 里专门有个 `posture.noDiscoveryIsFine: true`。

2. **读取永远不需要授权**
   看的权利不需要开关。只有对外写入才要授权。

3. **账本坏了就停**
   不悄悄重建空账本。那等于把她的日子清空。

## 写入能力：全都在，但默认关闭

评论、弹幕、动态、点赞、投币、收藏、历史 —— **七项全部实现**。

但关键是：**它们是能力，不是任务。**

- 工具**常驻注册**（这样在设置页拨开关立刻生效，不用重启），但**默认一个都发不出去**
- 要开需要**两件事同时成立**：配置里 `enableXxxWrites: true` **且** 本地授权文件里
  有对应的、未过期的、写了目标白名单的授权。一个布尔开关开不了写入 ✓
- 就算全开着，**她也可以今天不发**。指南里明说："没有想说的话就不写"

为什么不是一个开关就放行：**开关是"允许她考虑"，不是"授权去发"**。
公共空间说话和动自己账号是两件事，都值得多一道门。

### 打开某一项要做什么

1. 复制 `docs/write-policy.example.json` 成 `write-policy.json`，填 `accountId`、
   `expiresAt`、`targets`（能说哪些视频/直播间）、`maxWrites`
2. 在配置里把对应的 `enableXxxWrites` 改成 `true`
3. 重载插件

缺任何一样都会拒：没有文件 → `WRITE_POLICY_INVALID`；开关没开 → `WRITE_DISABLED`；
过期 → `WRITE_GRANT_EXPIRED`；目标不在白名单 → `WRITE_TARGET_DENIED`。

### 写入时的硬约束

| 约束 | 说明 |
|---|---|
| 一次一条 | 不批量、不铺量、不并发 |
| 60 秒间隔 | 同一账号两次写入至少隔一分钟 |
| 额度硬限制 | 每个授权 ID、每项能力都有 `maxWrites`（1–100） |
| 账号核对 | 发之前先查 nav，账号对不上就拒 |
| 目标白名单 | 只能发到授权里点名的地方 |
| 结果不明就停 | 超时/重定向/解析失败 → 记 pending + 持久暂停，**不重试** |
| 风控立刻停 | 401/403/412/429 或风控码 → 持久暂停，重启也不自动解除 |

**模型工具没有任何解除暂停、核对结果、确认消费的能力** —— 那些只有在本地 CLI 里。

## 工具（26 个：19 个看/记/倾听 + 7 个写入）

| 工具 | 作用 |
|---|---|
| `bili_fishman_guide` | 读人文指南（写手账前先读） |
| `bili_fishman_candidates` | 捞几条候选 —— **捞不到是正常结果** |
| `bili_fishman_read` | 读一个 BV 的文字稿（A2/A1），带诚实覆盖说明 |
| `bili_fishman_source` | 按偏移读已取来源的下一页 |
| `bili_fishman_journal` | 写信笺（每天至多 2 篇，零篇也行） |
| `bili_fishman_inbox` | 读完整手账（大收件箱走 index → volume 分卷） |
| `bili_fishman_letter` | 写给主人的信 —— **不是每天都要写** |
| `bili_fishman_letters` | 读自己写过的信 |
| `bili_fishman_day` | 记今天的心情（一行） |
| `bili_fishman_days` | 读最近几天 |
| `bili_fishman_diary` | **写日记**（两本：给主人看的 / 只给自己的，每天每本 1 篇） |
| `bili_fishman_diaries` | 读日记 |
| `bili_fishman_comment_digest` | **扫评论区**，找出值得回的（含"是不是主人"、"回过没"） |
| `bili_fishman_reply_draft` | **写回复草稿**（不直接发，等主人审） |
| `bili_fishman_status` | 看状态 / 暂停 / 任务 / 写入开关 |
| `bili_fishman_cancel` | 取消一个正在跑的读取任务 |
| `bili_fishman_memory` | 查看 / 修正 / 删除记忆 |
| `bili_fishman_import` | 挂本机产出的 ASR / 画面文字 |
| `bili_fishman_personality` | 读人格札记，或从信笺选一句 |

## 写入工具（7 个，常驻注册但默认不可用）

> 为什么常驻注册而不是"开关打开才出现"：一开始是后者，但那样在设置页拨开关
> **要重启 DSH 才生效** —— 又是一个"看起来没生效"。现在工具一直在，
> 每个执行时校验：开关没开 → `WRITE_DISABLED`；没有授权文件 → `WRITE_POLICY_INVALID`。

| 工具 | 开关 | 作用 |
|---|---|---|
| `bili_fishman_comment` | `enableCommentWrites` | 发一条评论（≤1000 字） |
| `bili_fishman_danmaku` | `enableDanmakuWrites` | 发一条直播弹幕（≤20 字） |
| `bili_fishman_dynamic` | `enableDynamicWrites` | 发一条纯文字动态（≤2000 字） |
| `bili_fishman_history` | `enableHistoryWrites` | 上报观看进度（需本地消费回执） |
| `bili_fishman_favorite` | `enableFavoriteWrites` | 收藏/取消收藏 |
| `bili_fishman_like` | `enableLikeWrites` | 点赞（只能加） |
| `bili_fishman_coin` | `enableCoinWrites` | 投币（累计目标，不附带点赞） |

## 生物钟

插件每 60 秒 tick 一次，到点用 `sessionController.prompt` 叫醒她那个会话。

叫醒的话只有三句：

> 【醒了】现在是 20:30（20:00–23:00）。
>
> 不用做任何事，也不用向谁交代。
>
> 如果你想看看什么…如果今天什么都没触动你 —— 那就什么都不做。这不是失败，是过日子的一部分。

**没有九步清单。** 那是养鱼压垮她的东西。

配置只有「可以在什么时候醒」，没有「必须醒几次」：

```yaml
night:
  windows:
    - { start: "20:00", end: "23:00" }
```

## 安装

```yaml
- id: bili-fishman
  name: dsh-bili-fishman
  config:
    dataDir: C:/Users/<你>/.dsh/bili-fishman
    credentialPath: C:/Users/<你>/.dsh/bili-fishman/credential.json
    maxSessionTokens: 600000
    enablePersonalityLearning: true
    # 授权文件：不存在 = 任何写入都开不了
    writePolicyPath: C:/Users/<你>/.dsh/bili-fishman/write-policy.json
    # 七项写入开关（默认全关；要开还要配合授权文件）
    enableCommentWrites: false
    enableDanmakuWrites: false
    enableDynamicWrites: false
    enableHistoryWrites: false
    enableFavoriteWrites: false
    enableLikeWrites: false
    enableCoinWrites: false
    persona:
      name: ""
      ownerTitle: 主人
    preferences:
      like: []
    night:
      windows:
        - { start: "20:00", end: "23:00" }
```

凭据至少要有 `sessdata`（**无 BOM 的 UTF-8**）。
只用读 → 一个字段就够；要写入还要加 `bili_jct`；弹幕/点赞/投币还要 `buvid3`：

```json
{ "sessdata": "..." }
```

### ⚠️ 关于会话工作目录

DSH 的 Windows ACL 沙箱有一条硬规矩：**工作区不能与系统临时目录互相嵌套**。
不满足的话 `materializeAclGrant()` 直接抛错，之后**每一次 shell 调用**都 EPERM。

养鱼就是死在这上面（它用 `C:\Users\<user>` 当会话 cwd，而 temp 正好在里面），
四天一条命令都没跑成。

本插件的 `pickSessionCwd()` 会主动挑一个不嵌套的目录（默认 `<DSH_HOME>/bili-fishman`），
并且用 `ctx.workingDirectory.set(agent, path)` 把**已存在的旧会话**也纠正过来。

> 实测记录：`ctx.sessionController` **没有** `setWorkingDirectory`。
> 真正能改的是 `ctx.workingDirectory.set(agent, path)`，agent 从 `ctx.agents.get(sessionId)` 拿。

## 设置界面

装好重启 DSH 后，在 **设置 → 鱼与人** 里有完整设置页：

| 分组 | 能改什么 |
|---|---|
| 她是谁 | 角色名、她怎么称呼你 |
| **她用哪个模型** | provider / model / 推理强度 + **测试模型**（只查目录，不花积分） |
| **登录凭证** | **扫二维码登录**，凭据写进本插件自己的文件（不回显） |
| 她喜欢看什么 | 爱看 / 不想看（挑候选用） |
| 作息 | 自己醒来开关、可以醒的时段、人格札记开关 |
| **全天监听（别人找她）** | 监听频率、全天最大回复数、同一人上限、同一视频上限、只回什么、我睡着时也守 |
| 说话能力 | 七项写入开关 + 主人 mid/昵称 + 分享开关 |
| **待审核的回复** | 她对别人的回复草稿，你点「发出去」才发 |
| **她写给我的信** | 按日期折叠，可导出文本、可打开存储文件夹 |
| **她的日记** | 两本切换，同样按日期折叠 + 导出 + 打开文件夹 |
| 当前状态 | 今天信笺额度、信数、暂停、已启用工具 |

**保存按钮在右上角吸顶**，滚到哪儿都能点。**保存后立刻生效，不用重启 DSH。**

右上角还有 **重新读取 / 测试 / 保存** 三个按钮，**测试在保存左边**：

### 测试按钮

点一下她就去 B 站逛一遍，把**当前激活的功能**都跑一遍 —— 而且**真的产出东西**，
这样您能核对，不是只看一片绿：

| 产出 | 在哪儿看 |
|---|---|
| 写一篇日记 | 「她的日记」里能看到 |
| 写一封信 | 「她写给我的信」里能看到 |
| 发一条 @你的评论 | 评论区（需要开评论写入 + 授权文件） |

检查项：登录态 / 模型目录 / 找候选 / 取稿链路 / 评论区扫描 / 全天监听 / 活动账本。

两条保证：

- **只发只读请求**做检查；唯一会写出去的是那条 **@你的测试评论**（且要你开了授权）
- **不计入当天额度** —— 跑之前快照 `listen:quota` / `listen:seen` / `listen:found`，跑完原样还原

### 她最近做了什么（活动账本）

设置页有一块「她最近做了什么」，按日期折叠，可以看到：

- **看了什么视频**（标题、作者、时长、字幕覆盖率、原视频链接）
- **发了什么评论/弹幕/动态**（正文、状态、链接）
- **点赞 / 收藏 / 投币 / 上报进度**
- **谁在找她**、**写了信笺/日记**
- **被安全词拦下的回复**（连"为什么没回"都记）

### 回复别人：审核与安全词

| 设置 | 默认 | 作用 |
|---|---|---|
| 免审核直接回 | 关 | 开着 = 她写好的回复直接发；关着 = 进待审队列 |
| 安全词 | 空 | 用「、」分隔；**命中任一个就不回** |

**安全词优先级最高** —— 即使开了免审核，命中安全词也直接拒，连草稿都不进。
检查范围包含**对方说的话**和**她要回的正文**，大小写不敏感。

### 模型选择

列出的是 **DSH 里真实可用的模型**（`ctx.llm` 的 provider 目录），
**没有「跟随默认」这一项** —— 选择框永远显示一个具体模型名，不会含糊。

### 全天监听（别人找她）

打开后她定时去读 B 站「回复我的」，把找她的评论变成待审草稿。三档额度**任一到顶就停止监听、次日刷新**：

| 额度 | 默认 | 范围 |
|---|---|---|
| 监听频率 | 300 秒 | ≥60 秒 |
| 全天最大回复数 | 10 | 1–50 |
| 同一个人上限 | 2 | 1–10（30 天窗口内） |
| 同一视频上限 | 3 | 1–20 |

> 到顶是**停**，不是"跳过这条继续听" —— 这条是主人明确要求的语义。
> 而且找到的回复**仍然先进待审队列**，你点头才发。

### 改了什么、没改什么

页面写入 `<dataDir>/settings.json`，它**覆盖** `cordis.patch.yml` 里的同一批键。

- ✅ 能改：人设、偏好、作息、七个写入开关
- ❌ **不能改**：`dataDir`、`credentialPath`、`writePolicyPath`、`accountStateDir`、`sessionCwd`
  —— 它们决定"数据写哪儿、用谁的凭据、授权文件在哪"，
  能改就等于能绕过安全检查。要改请编辑 `cordis.patch.yml`。

> ⚠️ 设置页的两个路由（`/bili-fishman/api/settings`、`/bili-fishman/api/status`）
> 都过 DSH 的 `connection.requestRejection` 信任栅栏 + 回环地址检查。
> 浏览器里任何网页都能向回环发请求，不加栅栏等于把配置开放给任意页面。

## 设置界面

装好重启 DSH 后，在 **设置 → 鱼与人** 里有完整设置页：

| 分组 | 能改什么 |
|---|---|
| 她是谁 | 角色名、她怎么称呼你 |
| 她喜欢看什么 | 爱看 / 不想看（挑候选用） |
| 作息 | 自己醒来开关、可以醒的时段、人格札记开关 |
| 说话能力 | 七项写入开关 |
| 当前状态 | 今天信笺额度、信数、暂停、已启用工具 |

**保存后立刻生效，不用重启 DSH。**（宿侧每次工具调用、每次 tick 都重读覆盖层）

### 改了什么、没改什么

页面写入 `<dataDir>/settings.json`，它**覆盖** `cordis.patch.yml` 里的同一批键。

- ✅ 能改：人设、偏好、作息、七个写入开关
- ❌ **不能改**：`dataDir`、`credentialPath`、`writePolicyPath`、`accountStateDir`、`sessionCwd`
  —— 它们决定"数据写哪儿、用谁的凭据、授权文件在哪"，
  能改就等于能绕过安全检查。要改请编辑 `cordis.patch.yml`。

> ⚠️ 设置页的两个路由（`/bili-fishman/api/settings`、`/bili-fishman/api/status`）
> 都过 DSH 的 `connection.requestRejection` 信任栅栏 + 回环地址检查。
> 浏览器里任何网页都能向回环发请求，不加栅栏等于把配置开放给任意页面。

## 本地 CLI

不消耗模型额度。

```sh
# 看和记（不需要授权）
node bin/cli.mjs status
node bin/cli.mjs read BVxxxxxxxxxx
node bin/cli.mjs candidates 5
node bin/cli.mjs letters
node bin/cli.mjs days 7
node bin/cli.mjs personality read

# 只有人能做的事（模型工具没有这些能力）
node bin/cli.mjs consumed <readingId> <秒>      # 确认真的看了这么多秒
node bin/cli.mjs write-resolve <id> applied     # 核对一条结果不明的写入
node bin/cli.mjs write-resume                   # 解除账号写入暂停
node bin/cli.mjs personality link AGENTS.local.md
```

凭据走环境变量，**不要写进命令行**：

```powershell
$env:BILI_FISHMAN_CREDENTIAL_FILE = "C:\Users\<你>\.dsh\bili-fishman\credential.json"
```

> `consumed` 是历史写入的前提：**只有人**能确认"我真的看了这么多秒"。
> 模型没有生成消费回执的能力，也不能把读字幕说成完整播放。

## 已知限制

- **搜索接口可能 412。** `/x/web-interface/search/type` 在某些号上即使带 WBI 签名也返回
  HTTP 412（风控页）。所以「找候选」改成：热门 + 排行榜为主，搜索只是锦上添花且失败静默跳过。
  搜索挂了不影响找候选，只是候选没那么贴偏好。
- **`node:sqlite` 是 Node 的实验特性**，每次跑会打印 `ExperimentalWarning`，不影响功能。
- **平台风控会持久暂停。** 401/403/412/429 或风控码会写进账本，重启也不自动解除。
  这是有意的：模型工具没有解除权限，得本地人工确认。
- **人格札记需要手动装入口。** `human-world.md` 默认不会被 DSH 自动读进来。
- **没有 webhook、没有桌面通知** —— 信只写本地文件。
- **写入能力已实现，但没有做真实账号写入实测。** 接口、授权、额度、暂停、回读核验
  都通过了离线测试，但**没有向真实账号发过评论/弹幕/动态/点赞/投币**。
  第一次真的要开，建议先挑一条无关紧要的目标试一次，并在平台上核对结果。
- **评论的可见性有延迟。** 工具返回的是"平台已接受请求"，不等于"别人现在能看到"。
  要确认请用本地 CLI 或直接去平台上翻。

## 数据在哪

```
<dataDir>/
  ledger.sqlite          账本（读过的、信笺、信、日子、记忆、暂停状态）
  ledger.initialized     标记（丢了就拒绝启动，不重建空账本）
  inbox.md / inbox.html  信笺导出（给主人看）
  letters.md             写给主人的信（本地）
  human-world.md         人格札记
  credential.json        凭据（只有 sessdata；写入还需要 bili_jct，弹幕/点赞/投币还要 buvid3）
  write-policy.json      写入授权（不存在 = 任何写入都开不了）
  assets/                本地媒体（ASR/抽帧用）

<accountStateDir>/<accountId>/
  ledger.sqlite          账号侧账本（额度用量、待核对意图、暂停、回执）
```

## 许可

MIT。取稿与账本层派生自 [dsh-bili-humanism](https://github.com/InariNGT-Ofiicial/dsh-bili-humanism)（MIT），
见 `NOTICE.md`。
