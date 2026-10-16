/**
 * dsh-message-fix — host entry.
 *
 * 修改已发送消息插件。核心功能（编辑按钮、fork/prompt/切换/归档）全部在
 * 客户端半边（client/client.js）经官方 API 完成；宿主半边仅保留 health
 * 诊断路由，用于验证插件存活与 webServer 链路。
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

export function apply(ctx, config = {}) {
  const routePrefix = typeof config.routePrefix === 'string' && config.routePrefix
    ? config.routePrefix.replace(/\/+$/, '')
    : '/message-fix'

  ctx.inject(['webServer'], (hostCtx) => {
    const healthHandler = (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      sendJson(response, 200, { ok: true, name, version: '0.1.0' })
    }

    const dispose = hostCtx.webServer.register({
      kind: 'prefix',
      // webserver 的前缀匹配会自动补 '/'，注册裸前缀即可让子路径命中。
      path: routePrefix,
      handler: (request, response) => {
        try {
          const url = new URL(request.url ?? '/', `http://${request.headers?.host ?? 'localhost'}`)
          if (url.pathname === `${routePrefix}/api/health`) return healthHandler(request, response)
          sendJson(response, 404, { ok: false, error: `unknown path ${url.pathname}` })
        } catch (error) {
          sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
        }
      },
    })

    ctx.effect(() => dispose, 'message-fix: http routes')
  })

  // 宿主不承载业务逻辑：fork/prompt/归档由客户端经官方 API 完成（见 client/client.js）。
}
