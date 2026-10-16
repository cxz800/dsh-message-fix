/**
 * dsh-message-fix — web client half.
 *
 * 修改已发送消息：在用户消息动作行（复制按钮右侧）注入"编辑"按钮，点击后原位
 * 进入编辑态（取消/发送 + 回车提交），提交后经官方 API 完成
 * fork（切到目标消息之前）→ prompt（新文本触发重新回答）→ openSession（无感切换）
 * → archiveSession（归档旧会话，日志保留可恢复）。
 *
 * 全部走官方客户端 API（sessions.fork / session.prompt / uiWorkspace.*），
 * 与内置"分支"按钮同构，仅切点不同。DOM 注入依赖消息动作行的 data-clock="start"
 * 语义属性，DSH 升级若失效则按钮安静消失，不影响原功能。
 *
 * eslint-disable
 */
window.__ModuleLoader__.load({ id: "dsh-message-fix", factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;

  const HOST_ID = "dsh-message-fix";
  const BTN_FLAG = "data-message-fix-edit";
  const ROW_SELECTOR = 'div[data-clock="start"]';

  let ctxRef = null;
  let observer = null;
  let editing = null; // { sessionId, anchor, originalText, actionsEl, bubbleEl, hostEl, textarea, submitBtn }
  let toastTimer = null;

  // ---------- 工具 ----------

  function toast(text, isError) {
    let el = document.getElementById(HOST_ID + "-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = HOST_ID + "-toast";
      Object.assign(el.style, {
        position: "fixed", left: "50%", bottom: "84px", transform: "translateX(-50%)",
        zIndex: 9999, padding: "8px 14px", borderRadius: "10px", fontSize: "13px",
        color: "#fff", background: "rgba(40,40,45,0.92)", boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
        pointerEvents: "none", transition: "opacity .2s", opacity: "0",
      });
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.background = isError ? "rgba(150,40,40,0.94)" : "rgba(40,40,45,0.92)";
    el.style.opacity = "1";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = "0"; }, isError ? 4200 : 2600);
  }

  /** 沿 React fiber 向上找消息节点（props.node）与所属会话（props.sessionId）。 */
  function fiberInfo(el) {
    const fk = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    if (!fk) return {};
    let node = null;
    let sessionId = null;
    for (let f = el[fk], i = 0; f && i < 60; i++, f = f.return) {
      const p = f.pendingProps || {};
      // user/steering 节点特征：anchorSeq 为数字，data.content 为 blocks 数组或字符串
      if (!node && p.node && p.node.data && p.node.data.content != null && typeof p.node.anchorSeq === "number") node = p.node;
      if (!sessionId && typeof p.sessionId === "string") sessionId = p.sessionId;
    }
    return { node, sessionId };
  }

  /** 从消息 content（blocks 数组或字符串）提取纯文本，与官方 contentParts 的 text 语义一致。 */
  function contentText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return null;
    const texts = [];
    for (const block of content) {
      if (block && block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
    return texts.join("");
  }

  /** 动作行对应的气泡元素（动作行之前最近的可见兄弟块）。 */
  function bubbleOf(actionsEl) {
    let el = actionsEl.previousElementSibling;
    while (el && (el.hidden || el.tagName === "STYLE")) el = el.previousElementSibling;
    return el;
  }

  /** 当前是否已有另一条消息处于编辑态（同一时刻只允许一个）。 */
  function isEditingRow(row) {
    return editing != null && editing.actionsEl === row;
  }

  // ---------- 注入：编辑按钮 ----------

  function makeIconEdit() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    // 与 primitives IconEditOutlineRegular 同族的简洁铅笔路径
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M13.6 3.2a1.7 1.7 0 0 1 2.4 2.4l-8.3 8.3-3.2.8.8-3.2 8.3-8.3z");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  function injectButton(row) {
    if (row.querySelector("button[" + BTN_FLAG + "]")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute(BTN_FLAG, "");
    btn.title = "修改此消息";
    btn.setAttribute("aria-label", "修改此消息");
    Object.assign(btn.style, {
      background: "transparent", border: "none", cursor: "pointer",
      color: "var(--dsw-alias-label-tertiary, inherit)", padding: "2px",
      borderRadius: "6px", display: "inline-flex", alignItems: "center",
      justifyContent: "center", lineHeight: 0,
    });
    btn.addEventListener("mouseenter", () => { btn.style.color = "var(--dsw-alias-label-primary, inherit)"; });
    btn.addEventListener("mouseleave", () => { btn.style.color = "var(--dsw-alias-label-tertiary, inherit)"; });
    btn.appendChild(makeIconEdit());
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      startEdit(row);
    });
    // 插到复制按钮（动作行内第一个 button）右侧
    const copyBtn = row.querySelector("button");
    if (copyBtn && copyBtn !== btn) copyBtn.after(btn);
    else row.appendChild(btn);
  }

  // ---------- 编辑态 ----------

  function cleanupEdit() {
    if (!editing) return;
    try { editing.hostEl.remove(); } catch (_) {}
    try { editing.bubbleEl.style.display = ""; } catch (_) {}
    editing = null;
  }

  function startEdit(row) {
    if (editing) cleanupEdit();
    const { node, sessionId: fiberSession } = fiberInfo(row);
    if (!node) {
      console.warn("[message-fix] fiber 未找到消息节点，行 HTML：", row.outerHTML?.slice(0, 200));
      toast("未能读取该消息内容，暂无法编辑", true);
      return;
    }
    const originalText = contentText(node.data.content);
    if (originalText == null) {
      console.warn("[message-fix] 消息 content 结构无法提取文本：", node.data.content);
      toast("该消息含不支持的内容（附件/图片等），暂无法编辑", true);
      return;
    }
    const sessionId = fiberSession
      || (ctxRef && ctxRef.uiWorkspace && ctxRef.uiWorkspace.mainReference && ctxRef.uiWorkspace.mainReference.sessionId);
    const anchorSeq = node.anchorSeq;
    if (!sessionId || !Number.isSafeInteger(anchorSeq) || anchorSeq < 1) {
      console.warn("[message-fix] 定位失败：sessionId =", sessionId, "anchorSeq =", anchorSeq);
      toast("未能定位该消息在会话中的位置，暂无法编辑", true);
      return;
    }
    const bubbleEl = bubbleOf(row);
    if (!bubbleEl) {
      toast("未能定位消息气泡，暂无法编辑", true);
      return;
    }

    const hostEl = document.createElement("div");
    hostEl.setAttribute("data-message-fix-editor", "");
    hostEl.style.cssText = "width:100%;padding:2px 0 4px;";
    bubbleEl.before(hostEl);
    bubbleEl.style.display = "none";

    const ta = document.createElement("textarea");
    ta.value = originalText;
    ta.rows = Math.min(10, Math.max(2, originalText.split("\n").length));
    ta.style.cssText = [
      "width:100%", "box-sizing:border-box", "min-height:64px", "resize:vertical",
      "font:inherit", "color:inherit", "padding:9px 12px", "border-radius:12px",
      "border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))",
      "background:var(--dsw-alias-bg-layer-1, transparent)", "outline:none", "line-height:1.55",
    ].join(";");

    const hint = document.createElement("div");
    hint.textContent = "提交后将从此消息重新开始，其后的回答将被丢弃；旧对话会归档保留。";
    hint.style.cssText = "font-size:12px;color:var(--dsw-alias-label-tertiary,inherit);margin-top:6px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    Object.assign(cancelBtn.style, {
      font: "inherit", fontSize: "13px", cursor: "pointer", padding: "5px 14px",
      borderRadius: "999px", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))",
      background: "transparent", color: "inherit",
    });

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.textContent = "发送";
    Object.assign(submitBtn.style, {
      font: "inherit", fontSize: "13px", cursor: "pointer", padding: "5px 16px",
      borderRadius: "999px", border: "none",
      background: "var(--dsw-alias-state-business-primary, #3b82f6)", color: "#fff",
    });

    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:8px;";
    footer.append(cancelBtn, submitBtn);

    hostEl.append(ta, hint, footer);

    editing = { sessionId, anchorSeq, originalText, actionsEl: row, bubbleEl, hostEl, ta, submitBtn };

    const finish = () => cleanupEdit();
    cancelBtn.addEventListener("click", finish);

    const submit = () => { submitEdit(); };
    submitBtn.addEventListener("click", submit);
    ta.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish();
      }
    });
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  // ---------- 提交：fork → prompt → 切换 → 归档 ----------

  async function submitEdit() {
    if (!editing || editing.busy) return;
    const text = editing.ta.value.trim();
    if (!text) { toast("修改后的内容不能为空", true); return; }
    const { sessionId, anchorSeq } = editing;
    const requestId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
    editing.busy = true;
    editing.submitBtn.disabled = true;
    editing.submitBtn.textContent = "提交中…";
    try {
      const sessions = ctxRef.get("sessions");
      if (!sessions || typeof sessions.fork !== "function") throw new Error("sessions 服务不可用");
      // 切到目标消息事件之前（atSeq 为包含切点；anchorSeq 为目标消息主事件序号）
      const childId = await sessions.fork({ sessionId, atSeq: anchorSeq - 1, increaseTitle: false });
      // mode 必填且只能为 "queue" | "steer"（typert wire schema 严格校验），与官方 composer send 一致用 "queue"
      const promptResult = await sessions.using(childId, { source: "message-fix" }, (reference) =>
        reference.binding.session.prompt([{ type: "text", text }], "queue", undefined, requestId));
      if (promptResult && promptResult.ok === false) {
        throw new Error((promptResult.error && promptResult.error.message) || "prompt 被拒绝");
      }
      // 先无感切换到新会话，再归档旧会话（归档主会话会清空主视图，顺序不能反）
      ctxRef.uiWorkspace.openSession(childId);
      cleanupEdit();
      try { await ctxRef.uiWorkspace.archiveSession(sessionId); } catch (archiveError) {
        console.warn("[message-fix] 旧会话归档失败（新会话已可用）:", archiveError);
        toast("消息已修改，但旧对话归档失败，可稍后在列表中手动归档", true);
        return;
      }
      toast("已修改消息，正在重新回答");
    } catch (error) {
      console.warn("[message-fix] 提交失败:", error);
      toast("修改失败：" + ((error && error.message) || error), true);
      if (editing) {
        editing.busy = false;
        editing.submitBtn.disabled = false;
        editing.submitBtn.textContent = "发送";
      }
    }
  }

  // ---------- 生命周期 ----------

  function scan() {
    try {
      document.querySelectorAll(ROW_SELECTOR).forEach(injectButton);
    } catch (error) {
      console.warn("[message-fix] scan failed:", error);
    }
  }

  const name = "message-fix";
  const inject = ["sessions", "uiWorkspace"];

  function apply(ctx) {
    ctxRef = ctx;
    try {
      observer = new MutationObserver(() => scan());
      observer.observe(document.body, { childList: true, subtree: true });
      scan();
    } catch (error) {
      console.warn("[message-fix] init failed:", error);
    }
    ctx.effect(() => () => {
      if (observer) { observer.disconnect(); observer = null; }
      cleanupEdit();
      const toastEl = document.getElementById(HOST_ID + "-toast");
      if (toastEl) toastEl.remove();
      document.querySelectorAll("button[" + BTN_FLAG + "]").forEach((b) => b.remove());
      document.querySelectorAll("[data-message-fix-editor]").forEach((el) => el.remove());
    }, "message-fix: dom injection");
  }

  exports.name = name;
  exports.inject = inject;
  exports.apply = apply;

  return module.exports;
}});
