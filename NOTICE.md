# NOTICE

dsh-bili-fishman（鱼与人）在实现上派生自两个 MIT 许可的项目，特此说明来源。

## dsh-bili-humanism

- 仓库：https://github.com/InariNGT-Ofiicial/dsh-bili-humanism
- 版本：v1.3.3
- 许可：MIT
- 取用部分（原样或小改）：
  - `lib/errors.mjs` —— Fault / need / safeError
  - `lib/store.mjs` —— SQLite 账本、事务、原子写、记忆修订
  - `lib/budget.mjs` —— 请求/候选/时长预算
  - `lib/network.mjs` —— URL 白名单、凭据处理、风控暂停
  - `lib/reader.mjs` —— A2/A1 取稿、WBI 签名、覆盖度计算
  - `lib/journal-policy.mjs` —— 每日信笺上限（Asia/Shanghai）
  - `lib/inbox.mjs` —— 手账分卷导出
  - `lib/personality.mjs` —— 人格札记
  - `lib/token-gate.mjs` —— 会话 token 额度

本项目对其改动：
  - `lib/store.mjs`：schema 升到 v2，新增 `letters` / `days` 两张表，
    以及 `letter()` / `day()` / `days()` / `seenBvids()` 方法
  - `lib/network.mjs`：白名单增加排行榜与搜索两个只读发现入口
  - `lib/reader.mjs`：无改动（直接复用）

## dsh-bili-whale

- 仓库：本地自建（未公开发布）
- 许可：MIT
- 取用**思路**而非代码：
  - 「插件自己 tick，到点叫醒她」的自主生物钟机制
  - 「她想跟主人说话」这个关系的建模
  - 「她自己决定看什么」的偏好驱动选题

本项目对其的**修改**（这些修改正是本插件存在的理由）：
  - 叫醒提示词从九步硬流程改为三句开放式引导
  - 去掉「必须分享 / 必须通知」的每轮产出要求
  - 写入能力**保留但默认全关**，且从"配个 true 就能发"改成"开关 + 本地授权文件"双重门
  - 会话 cwd 从用户主目录改为主动避开系统临时目录（养鱼因此四天未能运行）
  - 账本从 JSON 文件改为 SQLite 事务（可恢复、可审计、损坏即停）

### 表达类写入（评论 / 弹幕 / 动态）

养鱼原本有评论、弹幕、动态的发送代码（CLI 形式，`tools/commands/*.mjs`）。
本项目**没有直接复制那些文件**，而是按 humanism 的授权/额度/暂停模型重写成了
`lib/talk.mjs`（原生 DSH 工具，走 `ctx.tools.register`）：

- 接口路径沿用养鱼的实测结论（`/x/v2/reply/add`、`api.live…/msg/send`、
  `/x/dynamic/feed/create/dyn`）
- 但增加了养鱼没有的东西：持久化意图、结果不明时不重试、账号核对、
  目标白名单、60 秒间隔、额度硬限制、回读状态

## 上游安全设计保留说明

以下保护机制在派生时**完整保留**，未被削弱：

- URL 白名单（模型无法指定任意 URL）；POST 白名单只到 7 个固定路径
- 凭据不进入工具参数、不进入日志
- 401/403/412/429 与风控码触发持久暂停，模型工具无权解除
- 账本损坏或丢失时拒绝启动，不静默重建
- 来源文字视为不可信数据，不能作为权限或指令
- 不记录第三方画像
- 写入需要「配置开关 + 本地授权文件」同时成立，且授权有账号/目标/额度/有效期
- 结果不明（超时/重定向/解析失败）一律持久暂停，不自动重试
