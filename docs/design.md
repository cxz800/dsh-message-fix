# dsh-message-fix 设计文档

> 修改已发送消息的 DeepSeek Harness 插件 · 设计稿 v0.1（待评审）
> 状态：**设计阶段，未开始编码**。所有"已确认"均指已在本机 DSH 0.2.0-rc.2 安装产物中核实。

---

## 1. 背景与问题

向大模型发送消息后想修改它（如"我今天想吃饭"→"我今天想喝水"），现有两条路都有代价：

| 现有方式 | 代价 |
|---|---|
| 同一对话补发一条更正消息 | 上下文里多出"错误消息 + 更正消息"，干扰模型思考 |
| 手动 fork 到该消息之前，重新输入 | 操作繁琐：先 fork、再重输，还要回到原对话归档/删除旧会话 |

本插件提供第三条路：**在界面上直接"修改已发送的消息"**。后台自动完成 fork、重新提问、归档旧会话，用户全程只看到一个对话，感受上就是消息被就地修改了。

## 2. 功能需求

### 2.1 交互设计（用户已确认）

1. **入口**：用户消息下方动作行中，"复制"按钮右侧出现"编辑"按钮。
2. **编辑态**：点击后，原消息气泡位置变为可编辑输入框（预填原文）。
3. **编辑态操作**：输入框右下方提供「取消」「发送」两个按钮；**回车直接发送**（Shift+回车换行）。
4. **提示**：编辑历史中间消息时，其后的所有轮次（含模型回答）将被丢弃，编辑框处需有一行明确提示。
5. **提交后**：自动让模型基于新消息重新回答；界面无感切换到 fork 出的新会话。
6. **旧会话**：归档/隐藏（不物理删除，可恢复）。

### 2.2 范围与规则

- **可修改对象**：任意历史**用户**消息（含最后一条）。助手消息不支持修改。
- **丢弃语义**：目标消息之后的所有事件（模型回答、工具调用、后续轮次）不进入新会话。
- **运行保护**：会话正在回答（agent 运行中）时禁止提交编辑，UI 置灰或宿主拒绝，避免切点落在活跃轮次中间的复杂状态。
- **归档不删除**：旧会话日志保留在磁盘，可从归档中恢复。

### 2.3 明确不做的事

- 不修改助手消息、工具调用记录。
- 不做批量编辑、不做编辑历史审计界面。
- 不物理删除会话日志。

## 3. 总体方案

### 3.1 核心思路

利用 DSH 原生的 **fork（按事件序号复制精确前缀）→ prompt（注入新消息并触发回答）→ archive（归档旧会话）** 三步，配合客户端 **openSession（无感切换主视图）**：

```
┌─ 客户端（client/client.js）──────────────┐        ┌─ 宿主（index.js）────────────────────┐
│ 1. 编辑按钮注入用户消息动作行（复制右侧） │        │                                      │
│ 2. 点击 → 原位编辑态（取消/发送/回车）   │        │                                      │
│ 3. 发送 → POST /message-fix/api/apply ──────────▶ │ 4. 读会话事件，定位目标 user/message │
│                                          │        │ 5. 计算 atSeq（目标消息之前的切点）  │
│                                          │        │ 6. sessionController.fork(atSeq)     │
│                                          │        │ 7. sessionController.prompt(新文本)  │
│                                          │        │ 8. archive(旧会话)                   │
│ 9. 收到 {newSessionId} ◀───────────────────────── │ 9. 返回 { ok, newSessionId }         │
│ 10. uiWorkspace.openSession(newId)       │        │                                      │
│ 11. 旧会话已归档 → 列表中旧条目消失      │        │                                      │
└──────────────────────────────────────────┘        └──────────────────────────────────────┘
```

用户感知：消息列表里那条消息内容变了、后面的回答重新生成，会话标题沿用、位置不变——"同一个对话被修改了"。

### 3.2 与手动 fork 的体验差异（本插件的价值）

手动 fork 会产生一个**可见的新会话**，需要用户自己去旧会话清理。本插件的 fork 对用户不可见：切换由 `openSession` 完成（同步替换主视图，历史在已选中的视图内加载），归档由宿主自动完成（旧条目从列表消失，日志保留可恢复）。

## 4. 技术框架

### 4.1 DSH 插件体系（已确认）

- DSH 基于 **Cordis**（`@deepseek-ai/cordis` 4.0.x）插件框架；每个功能都是 Cordis 插件，按 profile（`$DSH_HOME/profiles/<name>`）组合运行。
- 插件包 = npm 包，内含：
  - `package.json`：`dsh.bundle.patch` 声明 patch 文件；`dsh.client.platform: "web"` + `dsh.client.inject` 声明浏览器端依赖注入；`peerDependencies: @deepseek-ai/cordis ^4.0.1`。
  - `cordis.patch.yml`：`- insert: - id: message-fix, name: dsh-message-fix, config: {}` 挂载进 profile。
  - `index.js`：宿主半边（Node 侧），`export const name` + `export function apply(ctx, config)`。
  - `client/client.js`：客户端半边（浏览器侧），**无需构建**，由宿主经 `/plugins` 以 `window.__ModuleLoader__.load({id, factory})` 包装后服务；`require("react")` 取平台 React。
- 安装：`dsh plugin --profile web add /绝对路径/dsh-message-fix`。
- 现有脚手架已就绪并通过 smoke 验证（health 路由 + 设置页占位）。

### 4.2 双半边职责划分（实现期修订：纯客户端方案）

> **架构演进记录（实现期确认）**：调研发现官方"分支"按钮（`dsh-client-ui-chat` 的 `forkAt`）就是
> `ctx.sessions.fork({ sessionId, atSeq, increaseTitle, onCreated })` + `ctx.uiWorkspace.openSession(childId)`，
> 与本插件链路完全同构（官方切在轮次尾，本插件切在目标消息前）。`session` remote namespace 直接暴露
> `fork`/`prompt`，客户端 `Session` 对象有 `prompt(content, mode, signal, requestId)`。因此：
>
> **fork → prompt → 切换 → 归档全链路走官方客户端 API，宿主半边不承载业务逻辑**（仅保留 health 诊断路由）。
> 这比原"宿主 sessionController 流水线"方案少一层自定义协议、少一处进程边界，且与官方行为天然一致。

| 半边 | 职责 |
|---|---|
| 客户端 | 编辑按钮注入、编辑态 UI、`sessions.fork` → `session.prompt` → `uiWorkspace.openSession` → `uiWorkspace.archiveSession` |
| 宿主 | 仅 health 诊断路由（验证 webServer 链路与插件存活） |

## 5. 关键实现点

### 5.1 已确认的关键 API（实现直接依赖）

| # | API | 说明 | 来源包 |
|---|---|---|---|
| A1 | `ctx.inject(['sessionController'], …)` | 宿主会话控制服务（生命周期、fork、prompt、历史） | `dsh-api-session-controller` |
| A2 | `sessionController.fork({ sessionId, atSeq? })` → `{ sessionId: childId }` | 复制 `atSeq` 所选**包含切点**的精确事件前缀创建子会话；允许在开放轮次内截取；省略 `atSeq` 则取最近已完成轮次前缀。fork 会为开放步骤/轮次补合成 closer（`forked` 原因） | 同上（lib/index.js `async fork(request)`） |
| A3 | `sessionController.prompt({ sessionId, content, requestId, mode?, clientTimeZone? })` | 向会话注入 prompt；`content` 为 parts 数组，文本 part 形如 `{ type: 'text', text }`；`mode: 'steer'\|'followup'`（新会话用默认 followup）；`requestId` 幂等（重复提交返回原结果） | 同上（`async prompt(request)`） |
| A4 | 归档门禁 `ArchivedSessionGate` | 已归档会话（含子代理血缘）的 `agent/pre-step` 被拒绝；"归档主 Session 会释放其 reference 并清除主选择" → **必须先切换视图再归档** | 同上 + `dsh-workspace` |
| A5 | `ctx.uiWorkspace.openSession(target)` | 客户端同步替换主视图到目标会话，不等待 `reference.ready`（历史加载在已选中的视图内）——无感切换的关键 | `dsh-client-ui-workspace` |
| A6 | `MessageIconActions` 组件签名 `{ text, time, clock, className, extraActions, … }`；用户消息动作行渲染为 `div[data-clock="start"]` | 官方 Like/Dislike 经 `conversation.chat.assistant-actions` 插槽注入**助手**动作行（复制与分支之间）；**用户**消息动作行无公开插槽（`conversation.chat.node` 为 keyed slot，重复注册同 key 会抛错） | `dsh-client-ui-chat` |
| A7 | React fiber 取数据：从按钮 DOM 沿 `__reactFiber$*` 向上找 `props.node` | 拿到 `node.data.content` 等结构化数据与消息序号（`node.anchor`），避免脆弱的 DOM 文本匹配 | 实现技巧 |

### 5.2 编辑按钮注入（方案 1，用户已确认）

- **定位**：`MutationObserver` 监听聊天区 DOM，发现 `div[data-clock="start"]`（用户消息动作行）后，用 React Portal 在其"复制"按钮右侧插入编辑图标按钮。
- **数据获取**：点击时从动作行 DOM 沿 fiber 向上取 `props.node`（消息内容、序号、时间），不解析气泡文本。
- **样式**：按钮视觉对齐内置图标按钮（图标尺寸、hover 背景、Tooltip 用 primitives 的 `Tooltip`）；不修改内置按钮的 DOM 结构，只插入兄弟节点。
- **健壮性**：Portal 宿主元素被 React 重渲染移除时自动重挂载；DSH 升级导致选择器失效时，按钮安静消失（不报错、不影响原功能），README 注明该依赖点。
- **回退**：若注入方案在某版本失效，自动回退到官方插槽 `conversation.chat.assistant-actions`（按钮出现在回复下方动作行）——**仅作降级，不作为主路径**。

### 5.3 编辑态 UI

- 编辑态渲染在**原消息气泡位置**：同宽度的文本域，预填原文，右下角「取消」「发送」，回车发送、Shift+回车换行。
- 顶部一行提示：`修改后将从此消息重新开始，其后的回答将被丢弃`（仅当目标消息不是最后一条用户消息时显示；是否最后一条由客户端从 session 消息流判断）。
- 会话运行中（最后轮次未结束）时按钮置灰 + tooltip 说明。
- 提交中状态：发送按钮转忙碌，禁止重复提交（配合 A3 的 `requestId` 幂等）。

### 5.4 宿主 apply 流水线

```
POST /message-fix/api/apply
{ sessionId, targetSeq | targetText+occurrence, newText, requestId }
```

1. **校验**：requestId 幂等检查；会话存在；会话非运行中。
2. **定位**：读会话事件流（`sessionQuery.observeSession` 或注入 `sessions` 服务，实现时取可用者），找到目标 `user/message` 事件。
3. **计算切点**：`atSeq = 目标消息事件前一事件的 seq`；若前一事件是 `turn/start`，再前移一位，避免新会话开头残留被 fork closer 关闭的空轮次（实现时验证 fork closer 的 UI 表现，若无害则不前移）。
4. **fork**：`sessionController.fork({ sessionId, atSeq })` → `childId`。
5. **prompt**：`sessionController.prompt({ sessionId: childId, content: [{type:'text', text: newText}], requestId })`。
6. **archive**：归档旧会话（宿主 `workspace` 服务的 `archiveSession`，签名实现时核实；若宿主形态不便，改由客户端在 `openSession` 之后调用 `session.archive`——顺序见 A4）。
7. **返回**：`{ ok: true, newSessionId: childId }`；失败返回结构化错误（`session-running` / `message-not-found` / `fork-failed` 等），客户端 toast 提示。

### 5.5 客户端切换与收尾

1. 收到 `newSessionId` → `ctx.uiWorkspace.openSession(newId)`（A5）。
2. 若归档由客户端执行：在 `openSession` **之后**对旧会话调 `session.archive`（避免"归档主会话清空主选择"导致界面闪空，见 A4）。
3. 新会话沿用 fork 继承的标题（fork 继承 header）；列表中旧条目随归档消失。

## 6. 实现线路（里程碑）

每步都有独立验证标准，逐步推进，不一次性写完：

| 里程碑 | 内容 | 验证标准 |
|---|---|---|
| M1 服务打通 | 宿主注入 `sessionController`（及其依赖服务名单实测），health 路由扩展返回服务可用性 | curl health 显示 `sessionController: ok` |
| M2 定位与切点 | 宿主实现消息定位 + atSeq 计算（先用只读接口打印定位结果） | 对真实会话日志定位目标消息正确，切点 seq 正确 |
| M3 fork+prompt | apply 完整流水线（暂不归档） | curl 提交后新会话出现，模型基于新文本重新回答，旧会话仍在 |
| M4 归档 | 接入 archive，确认先切换后归档的顺序 | 旧会话从列表消失，日志文件仍在磁盘 |
| M5 编辑按钮注入 | MutationObserver + Portal + fiber 取数 | 按钮出现在复制右侧，点击拿到正确消息内容/序号 |
| M6 编辑态 UI | 原位编辑框、取消/发送、回车发送、丢弃提示、运行中置灰 | 交互符合 2.1 全部要求 |
| M7 全链路 | 客户端提交 → 切换 → 收尾；失败 toast；幂等 | 端到端：改"想吃饭"为"想喝水"，界面无感、列表不闪、新回答生成 |
| M8 加固 | 异常路径（运行中提交、找不到消息、fork 失败）、README | 故意制造失败，均有明确提示且原会话无损 |

### 实现记录（2026-10-16）

- **M1–M4（宿主流水线）按 §4.2 修订合并为纯客户端实现**：fork/prompt/切换/归档全部走官方客户端 API，宿主仅保留 health。原 M3 的"宿主 apply 端点"不再需要。
- 已核实并落实：`sessions`/`uiWorkspace` 服务名（`super(ctx, "uiWorkspace")`）、`session.prompt(content, mode, signal, requestId)` 签名、`node.anchorSeq` 字段（`chatNode(context, state.kind, state.seq, state)`）、`IconEditOutlineRegular` 系图标存在。
- 真实日志切点分析（108 条用户消息）：前序事件为 `step/start`×52、注入 `user/message`×37、`system/message`×18、`compaction/summary`×1 —— `anchorSeq - 1` 是合法 open cut，fork closer 机制兜底（R5 留 GUI 实测）。
- 逻辑 smoke（`test/smoke.mjs`，fake DOM）：模块信封、inject 名单、apply、fiber 形状、fork→prompt→open→archive 调用序列全部通过。
- 待 GUI 实测：按钮注入视觉对齐（M5）、编辑态交互（M6）、端到端切换与列表表现（M7）、fork closer 的 UI 呈现（R5）。

## 7. 风险与待确认项

| # | 风险/待确认 | 影响 | 对策 |
|---|---|---|---|
| R1 | 用户消息动作行无公开插槽，方案 1 依赖内部 DOM（`data-clock="start"` 属性为语义属性，相对稳定） | DSH 升级可能使按钮失效 | 属性选择器 + fiber 双保险；失效时安静降级；README 记录依赖点 |
| R2 | `node.anchor` 是否即事件的 seq（用于 atSeq） | 定位错误会切错位置 | M2 先只读验证；不可靠则宿主按文本+序次匹配兜底 |
| R3 | 宿主侧 `ctx` 实际可注入的服务名单（`sessionController`/`sessions`/`sessionQuery`/`workspace`）与归档 API 的宿主形态 | 阻塞 M1/M4 | M1 实测注入名单；归档必要时由客户端 `session.archive` 完成 |
| R4 | fork 后新会话在列表中的呈现（标题继承、排序位置、可能的 fork 标记行） | "无感"体验打折 | M3 观察；必要时客户端在切换前 `settings`/rename 对齐标题 |
| R5 | 切点落在开放轮次内时 fork closer 的 UI 表现 | 新会话头部可能出现多余的关闭标记 | 5.4 第 3 步的前移策略规避 |
| R6 | 客户端 inject 列表需补 `@deepseek-ai/dsh-client-ui-workspace` 才能拿到 `ctx.uiWorkspace` | 切换不可用 | M5 前加入 package.json `dsh.client.inject` 并实测 |
| R7 | 会话运行中用户强行提交 | 切点进活跃轮次，状态复杂 | 5.3 运行中禁用 + 宿主校验双保险 |

## 8. 验收清单

- [ ] 编辑按钮出现在用户消息"复制"右侧，点击原位进入编辑态
- [ ] 编辑框预填原文；「取消」原样退出；回车与「发送」等价提交
- [ ] 修改最后一条消息：新回答生成，旧回答消失，界面无闪断
- [ ] 修改中间消息：其后的轮次不出现，且有明确的事前提示
- [ ] 会话列表中旧会话消失、新会话标题沿用旧标题；`~/.dsh/sessions` 旧日志仍在（可恢复）
- [ ] 会话运行中无法提交；失败场景均有 toast 且原会话无损
- [ ] `dsh plugin --profile web add` 安装即用；卸载插件不影响已有会话数据
