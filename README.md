# dsh-message-fix

DeepSeek Harness 插件：**修改已发送给大模型的消息**。在用户消息动作行（"复制"按钮右侧）注入"编辑"按钮，原位编辑后自动完成 fork → 重新提问 → 无感切换 → 归档旧会话，感受上就是消息被就地修改了。

设计文档见 [docs/design.md](docs/design.md)。

## 使用

1. hover 任意已发送的用户消息，点下方动作行"复制"右侧的**编辑**（铅笔）按钮。
2. 消息原位变为编辑框（预填原文），右下角「取消 / 发送」，**回车直接发送**，Esc 取消。
3. 提交后：fork 到该消息之前 → 以新文本触发回答 → 界面无感切到新会话 → 旧会话自动归档（日志保留在磁盘，可恢复）。

## 安装（本地开发）

```sh
dsh plugin --profile web add /Users/cxz800/work/dsh_plugin/dsh-message-fix
```

重启 DSH（或启用 HMR 后自动重载）。验证链路：`GET /message-fix/api/health`。

## 实现

- **纯客户端实现**：`client/client.js` 全程走官方 API——`sessions.fork({sessionId, atSeq})`（与内置"分支"按钮同构，仅切点为 `anchorSeq - 1`，即目标消息主事件之前）、`session.prompt`、`uiWorkspace.openSession`、`uiWorkspace.archiveSession`（顺序：先切换后归档，因归档主会话会清空主视图）。
- **宿主半边**（`index.js`）：仅 `GET /message-fix/api/health` 诊断路由。
- **按钮注入**：`MutationObserver` 监听 `div[data-clock="start"]`（用户消息动作行的语义属性），插入原生按钮；点击后沿 React fiber（`__reactFiber$`）向上读 `props.node`（`anchorSeq`、`data.content`）与 `props.sessionId`。
- **编辑态**：原生 DOM（隐藏气泡 + 插入编辑容器），不侵入 React 组件树。

## HTTP API

| 路由 | 说明 |
|---|---|
| `GET /message-fix/api/health` | 存活检查（诊断用） |

## 已知限制

- 编辑按钮依赖消息动作行的 `data-clock="start"` 属性（DSH 内部语义属性，相对稳定）。DSH 升级若失效，按钮安静消失，不影响原功能；届时按新结构适配即可。
- 消息注入（`<system-reminder>` 等）与用户气泡同属 `user/message` 事件流；切点取目标消息主事件之前，注入由新会话重新生成，不影响语义。
- 会话正在回答时提交：fork 会以 `forked` 原因关闭开放轮次（官方机制），行为安全但建议等回答结束再编辑。
- steering（插话）消息同样会出现编辑按钮，fork 语义相同。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `routePrefix` | `/message-fix` | health 路由前缀 |
