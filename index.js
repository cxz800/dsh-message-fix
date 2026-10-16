/**
 * dsh-message-fix — host entry.
 *
 * 修改已发送消息插件。编辑按钮、fork/prompt/切换/归档的执行在客户端半边
 * （client/client.js）经官方 API 完成；宿主半边提供两件事：
 *   1. GET /message-fix/api/health   — 诊断路由
 *   2. GET /message-fix/api/cutpoint — 切点计算：从目标消息往前找最近一个
 *      完整轮次结束（turn/end），避免 fork 前缀残留上一轮的半截轮次
 *      （客户端只有折叠后的节点视图，读不到事件类型，必须由宿主算）。
 */
export const name = 'message-fix'

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * 计算安全切点：返回的 atSeq 使 fork 前缀以"最近的闭合边界"结束。
 * 真实日志结构：step 是高频闭合单元（step/start 与 step/end 严格配对），
 * turn 是大粒度分界（turn/end 稀疏，只在本会话特定时机写入）。
 * - 往前扫描遇到的第一个 turn/end 或 step/end（即离目标最近的闭合边界）→ 切其后：
 *   turn/end 时前缀原生完整；step/end 时最后一个 step 完整、开放的 turn 由
 *   fork closer 关闭（轮次内有完整内容，与官方分支切轮次尾的呈现一致）
 * - 一个闭合边界都没有（目标在第一个轮次内）→ 切到第一个 turn/start 之前，
 *   前缀只剩会话设置区
 * - 兜底：目标消息前一个事件（合法 open cut，fork closer 收尾）
 */
export function computeCutpoint(events, anchorSeq) {
  const idx = events.findIndex((event) => event.seq === anchorSeq)
  if (idx === -1) return { ok: false, error: 'message-not-found' }
  if (events[idx].type !== 'user/message') {
    return { ok: false, error: 'not-a-user-message', actualType: events[idx].type }
  }
  for (let i = idx - 1; i >= 0; i--) {
    if (events[i].type === 'turn/end') return { ok: true, atSeq: events[i].seq, basis: 'turn-end' }
    if (events[i].type === 'step/end') return { ok: true, atSeq: events[i].seq, basis: 'step-end' }
  }
  const firstTurnStart = events.find((event) => event.type === 'turn/start')
  if (firstTurnStart && firstTurnStart.seq < anchorSeq) {
    return { ok: true, atSeq: firstTurnStart.seq - 1, basis: 'first-turn-start' }
  }
  return { ok: true, atSeq: anchorSeq - 1, basis: 'fallback' }
}

export function apply(ctx, config = {}) {
  const routePrefix = typeof config.routePrefix === 'string' && config.routePrefix
    ? config.routePrefix.replace(/\/+$/, '')
    : '/message-fix'

  ctx.inject(['webServer'], (hostCtx) => {
    const dispose = hostCtx.webServer.register({
      kind: 'prefix',
      // webserver 的前缀匹配会自动补 '/'，注册裸前缀即可让子路径命中。
      path: routePrefix,
      handler: (request, response) => {
        try {
          const url = new URL(request.url ?? '/', `http://${request.headers?.host ?? 'localhost'}`)
          if (url.pathname === `${routePrefix}/api/health`) {
            return sendJson(response, 200, { ok: true, name, version: '0.1.0' })
          }
          sendJson(response, 404, { ok: false, error: `unknown path ${url.pathname}` })
        } catch (error) {
          sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
        }
      },
    })

    ctx.effect(() => dispose, 'message-fix: http routes')
  })

  // 切点计算依赖 sessionQuery（可读冷会话事件流）；服务不可用只影响该端点，
  // health 与客户端兜底切点不受影响。
  ctx.inject(['webServer', 'sessionQuery'], (hostCtx) => {
    const cutpointHandler = async (request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers?.host ?? 'localhost'}`)
      const sessionId = url.searchParams.get('sessionId')
      const anchorSeq = Number(url.searchParams.get('anchorSeq'))
      if (!sessionId || !Number.isSafeInteger(anchorSeq) || anchorSeq < 1) {
        return sendJson(response, 400, { ok: false, error: 'sessionId and integer anchorSeq >= 1 are required' })
      }
      let observed = null
      try {
        observed = await hostCtx.sessionQuery.observeSession(sessionId)
        const events = observed?.events
        if (!Array.isArray(events)) {
          return sendJson(response, 500, { ok: false, error: 'session events unavailable' })
        }
        const result = computeCutpoint(events, anchorSeq)
        return sendJson(response, result.ok ? 200 : 422, result)
      } catch (error) {
        hostCtx.logger?.warn?.('[message-fix] cutpoint lookup failed: %s', error?.message ?? error)
        return sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
      } finally {
        // observeSession 的返回若实现为 disposable，用后释放
        try { observed?.[Symbol.dispose]?.() } catch (_) {}
      }
    }

    const dispose = hostCtx.webServer.register({
      kind: 'exact',
      path: `${routePrefix}/api/cutpoint`,
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        cutpointHandler(request, response).catch((error) => {
          sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
        })
      },
    })

    ctx.effect(() => dispose, 'message-fix: cutpoint route')
  })
}
