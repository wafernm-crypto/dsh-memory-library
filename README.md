# 记忆图书馆（Memory Library）

在你手动开启记忆的对话里，把聊天沉淀成本地记忆库，用「标题 → 简介 → 正文」三级结构控制读取量，并按放慢的艾宾浩斯曲线逐步压缩。规则文件只在你确认后才会被写入。默认每个工作区独立；也可以选择与另一个项目**共用**同一套记忆，或**只读接取**老库后继续写新库。

## 数据放在哪

每个工作区一个目录：`<工作区>/.dsh-memory/`

```
.dsh-memory/
├── RULES.md              # 你确认过的规则（优先级最高）
├── INDEX.md              # 自动生成的索引（标题 + 一句话简介）
├── settings.json         # 本工作区的覆盖设置（容量、遗忘倍率、注入预算）
├── mode.json             # 共用模式指针（可选；只读接取用 mounts.json）
├── mounts.json           # 只读接取的外部记忆库及其过滤条件
├── sessions.json         # 哪些对话手动开启了记忆（默认全部关闭）
├── .state.json           # 上次整理 / 容量检查时间
├── journal/
│   └── 2026-10-24.md     # 每轮聊天：你的原话 + AI 回复要点摘录
├── library/
│   └── mem-xxxx.md       # 记忆条目（front matter + 正文）
└── archive/
    └── mem-yyyy.md       # 已压缩到“仅标题”的条目
```

## 工作方式

1. **按对话手动开启**：每个新对话默认**关闭**记忆。可以在输入框工具行左侧点「记忆 开 / 关」按钮，或说“开启这个对话的记忆”让 AI 调 `memory_session action=on` 并弹出审批。按钮点击本身就是你的手动确认，不再二次弹窗。开启状态记在 `sessions.json`，恢复该对话后仍然有效；关闭用 `action=off` 或再点一次按钮。
2. **每轮落盘**：开启后的对话在 `turn/end` 时把本轮你的消息（原文）和 AI 回复的要点摘录写入当天 `journal/YYYY-MM-DD.md`。子代理默认不记录。
3. **自动注入**：每个 Agent 启动时注册一个系统提示 section；只有本对话已开启时才加载 `RULES.md`、本地条目索引、以及只读外链索引（受 `promptMaxChars` 限制）。规则永远排在最前。
4. **按需检索**：索引只给标题和一句话简介；细节用 `memory_search` / `memory_read` 读取，避免一次读太多文件。
5. **定时整理**：默认每天 3 次（每 8 小时）。后台用默认模型把新日志提炼成条目、合并重复、给到期条目降级；模型不可用时保留日志，30 分钟后重试，到期的确定性压缩仍会执行。
6. **容量上限**：默认 5 GiB。超限时依次：低重要度全文→简介 → 简介→仅标题 → 清理过期日志 → 压缩重要条目 → 删除低价值归档。重要度 5 永不自动压缩或删除。
7. **规则确认**：AI 调 `memory_propose_rule` 只会弹出审批；你点允许后才追加到 `RULES.md`。`write` / `edit` 工具被 guard 拦住，不能直接改 `.dsh-memory/` 下的任何文件。

## 工具

| 工具 | 用途 |
|---|---|
| `memory_session` | 开启/关闭**本对话**的记忆（默认关闭；开启需审批），`status` 查看状态；等价于点输入框左侧的开关 |
| `memory_search` | 关键词检索标题、简介、标签、正文 |
| `memory_read` | 按 id 读全文；也接受 `journal:YYYY-MM-DD`、`index`、`rules`。读条目会记为一次复习，减慢遗忘 |
| `memory_write` | 写入/更新一条长期记忆（标题、简介、正文、重要度 1-5、标签） |
| `memory_status` | 查看容量、条目数、日志天数、上次整理时间 |
| `memory_configure` | 改本工作区的容量上限、遗忘倍率、注入预算（写入 `settings.json`） |
| `memory_mode` | 三选一：共用 / 只读接取+新库 / 完全独立；`status` 查看当前模式 |
| `memory_link` | 只读接取另一个项目的记忆库：按标签/重要度/条数过滤，需你审批 |
| `memory_consolidate` | 立即执行一次整理（平时自动运行） |
| `memory_propose_rule` | 提议新增规则，需你在审批弹窗中确认 |

## 会话开关按钮

输入框工具行左侧有一个紧凑开关：

- **记忆 关**（灰色圆点）：本对话不捕获、不注入，记忆工具报“本会话尚未开启记忆”。
- **记忆 开**（绿色圆点 + 品牌色边框）：点击即开启；再点一次关闭。
- 点击按钮绕过了 `memory_session` 的审批弹窗，因为**按钮点击本身就是你的手动选择**。
- 状态每 5 秒同步一次；切换后下一轮开始注入/停止注入。
- 显示「记忆 !」表示本地 API 没连通，悬停可看错误（通常是页面需要刷新，或 Host 路由未加载）。

按钮走插件自己的本地接口：

```
GET  /dsh-memory-api/session?id=<sessionId>   -> { enabled, mode, dir }
POST /dsh-memory-api/session {sessionId, enabled}
```

接口要求页面内注入的随机 `x-dsh-memory-token`，并在 Host 侧复用同一套 store/mode 解析。如果浏览器的 CSP 拦掉了内联 token 脚本，同源请求（`Sec-Fetch-Site: same-origin` 或匹配的 `Origin`/`Referer`）以及本机回环请求也会被接受；跨站请求拒绝。

## 遗忘曲线

- 基础间隔：全文 → 简介 4 天，简介 → 归档 12 天。
- 实际间隔 = 基础间隔 × `slowdown`（默认 2.5，比经典艾宾浩斯慢 2.5 倍）× 重要度系数 × 2^复习次数。
- 重要度系数：1→0.35，2→0.7，3→1.3，4→4，5→永不。
- 复习来源：`memory_read`、整理时被合并/更新。
- 归档条目在 180 天后、且重要度 ≤1 时删除。

## 三种记忆模式

先在本对话开启记忆（`memory_session action=on`），再选模式；**模式是工作区级设置，会话开关单独控制这个对话用不用记忆**。在目标工作区的会话里说一句即可，AI 会调 `memory_mode` 并弹审批：

| 模式 | 你可以这样说 | 行为 |
|---|---|---|
| 共用 | 「当前项目和 `S:\23_DshMod` 共用记忆库」 | 读写都落到源库：条目、日志、规则、整理全部共用 |
| 只读 + 新建 | 「只读接取 `S:\23_DshMod` 的 shared 标签、重要度 ≥3、最多 30 条，新记忆写本地」 | 老库只读；当前项目继续写自己的新库 |
| 完全独立 | 「切回完全独立的记忆库」 | 清空外链，只用本地库；原有本地库保留 |

### 共用模式

- 在目标库写 `mode.json`：

```json
{
  "mode": "shared",
  "source": "S:\\23_DshMod\\.dsh-memory"
}
```

- 之后目标项目的读写、日志、整理、规则都直接操作源库，等于两个项目共用一套记忆。
- 目标项目原来自带的库不会被删除，只是暂不使用；切回独立模式就恢复使用。
- 禁止链式共用（源库本身不能再是另一个库的 shared 目标），避免循环。

### 只读 + 新建模式

- 源库以「外部接取（只读）」出现在系统提示里，条目 id 形如 `m-xxx:mem-yyy`。
- `memory_search` 同时搜本地和外链；`memory_read` 可读外链正文。
- 实时同步：源库条目更新、压缩、归档后，目标项目下次读取就是最新状态。
- **永远只读**：不能写回源库；外链读取也不改变源库的复习计数和遗忘进度。
- 过滤条件写在 `mounts.json`（`tags` 任一命中、`minImportance`、`limit`），可用 `memory_link action=list` 查看、`action=remove` 断开。

```json
[
  {
    "id": "m-abc123",
    "label": "23_DshMod",
    "source": "S:\\23_DshMod\\.dsh-memory",
    "tags": ["shared"],
    "minImportance": 3,
    "limit": 30
  }
]
```

### 完全新建模式

- 默认状态，不读别人的库；别人也不会自动读到它（除非对方显式接取）。
- 切回时删除 `mode.json` 并清空 `mounts.json`；本地库内容不受影响。

## 配置（`cordis.patch.yml`）

插件默认值，可被每个工作区的 `.dsh-memory/settings.json` 覆盖（可用 `memory_configure` 工具改）：

```yaml
maxStorageBytes: 5368709120   # 5 GiB
consolidationsPerDay: 3
slowdown: 2.5
captureSubagents: false
indexMaxChars: 3500
promptMaxChars: 7000
baseFullDays: 4
baseSummaryDays: 12
journalRetentionDays: 45
archiveRetentionDays: 180
provider: ''                  # 留空使用默认模型
model: ''
```

```json
// .dsh-memory/settings.json（只写你想覆盖的键）
{
  "maxStorageBytes": 10737418240,
  "slowdown": 3,
  "promptMaxChars": 9000
}
```

## 已知边界

- 记忆默认关闭：新对话不会捕获、不会注入，也不能调用记忆工具；必须由你手动开启本对话。
- 记忆默认按工作区隔离；跨项目需要显式选择 `memory_mode` 的共用或只读接取。
- 共用模式下两个项目操作同一套文件，条目/规则/日志都会混在一起；不要两边同时改规则。
- 外链只读：不能写回源库，源库的复习计数与遗忘进度也不受外链读取影响。
- guard 只能拦 `write` / `edit`；如果绕过工具用 shell 命令直接改文件，插件无法阻止。请勿让 AI 这样做。
- 原始对话只保留“用户原话 + 回复摘录”，不保留逐字全文；需要完整原文时以会话日志为准。
- 整理依赖当前默认模型；模型不可用时新日志会积压并在恢复后重试。
