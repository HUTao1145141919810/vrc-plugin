// 图片下载（支持可选的 HTTP 代理）
// 设计成「直连优先、失败再走代理」，避免本来直连正常的请求被代理绕坏。
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { config } from './config.js'

let agentResolved = false
let agentPromise = null
let proxyAliveAt = 0
let proxyAlive = false

// 直连连续失败后，一段时间内直接优先走代理，避免每张图都先耗尽一次超时
let directFailStreak = 0
let proxyFailStreak = 0
let preferProxyUntil = 0
const DIRECT_FAIL_WINDOW = 5 * 60 * 1000

function proxyUrl() {
  return typeof config.proxy === 'string' && config.proxy.trim() ? config.proxy.trim() : ''
}

function proxyEnabled() {
  return proxyUrl() && config.proxyMode !== 'off'
}

/** 懒加载 https-proxy-agent（云崽根目录已装，插件不额外引入依赖） */
async function getAgent() {
  if (agentResolved) return agentPromise
  agentResolved = true
  if (!proxyEnabled()) {
    agentPromise = null
    return null
  }
  try {
    const mod = await import('https-proxy-agent')
    const Agent = mod.HttpsProxyAgent || mod.default?.HttpsProxyAgent || mod.default
    agentPromise = new Agent(proxyUrl())
    logger?.info?.(`[vrc-plugin] 代理已就绪：${proxyUrl()}（模式 ${config.proxyMode}）`)
  } catch (err) {
    agentPromise = null
    logger?.warn?.(`[vrc-plugin] 无法加载 https-proxy-agent，只用直连：${err.message}`)
  }
  return agentPromise
}

/** 探测代理端口是否在监听（结果缓存 60s），用于决定要不要给浏览器挂代理 */
export function isProxyAlive(timeoutMs = 1500) {
  if (!proxyEnabled()) return Promise.resolve(false)
  if (Date.now() - proxyAliveAt < 60_000) return Promise.resolve(proxyAlive)
  let host = '127.0.0.1'
  let port = 7890
  try {
    const u = new URL(proxyUrl())
    host = u.hostname
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  } catch { /* 用默认值 */ }

  return new Promise(resolve => {
    const socket = net.connect({ host, port })
    const finish = alive => {
      proxyAlive = alive
      proxyAliveAt = Date.now()
      socket.destroy()
      resolve(alive)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** 单次 https 请求（跟随最多 3 次跳转） */
function requestOnce(url, { headers, timeoutMs, agent }, redirectLeft = 3) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const mod = target.protocol === 'http:' ? http : https
    const req = mod.get(
      target,
      { headers, agent: target.protocol === 'http:' ? undefined : agent, timeout: timeoutMs },
      res => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400 && res.headers.location && redirectLeft > 0) {
          res.resume()
          const next = new URL(res.headers.location, target).href
          return requestOnce(next, { headers, timeoutMs, agent }, redirectLeft - 1).then(resolve, reject)
        }
        if (status !== 200) {
          res.resume()
          return reject(Object.assign(new Error(`HTTP ${status}`), { status }))
        }
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () =>
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: String(res.headers['content-type'] || 'image/png')
          })
        )
        res.on('error', reject)
      }
    )
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
    })
    req.on('error', reject)
  })
}

/** 直连下载：用 Node 自带的 fetch，能自动跟随 VRChat 图片接口的 302 跳转 */
async function fetchDirect(url, { headers, timeoutMs }) {
  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  const buffer = Buffer.from(await res.arrayBuffer())
  return {
    buffer,
    contentType: String(res.headers.get('content-type') || 'image/png')
  }
}

/**
 * 下载图片字节。
 * proxyMode: off → 只直连；fallback → 直连失败再走代理；always → 先代理，失败再直连
 * 直连走 fetch（跟跳转靠谱），代理走 https.get + agent（fetch 不吃 https-proxy-agent）。
 */
export async function fetchImage(url, { headers = {}, timeoutMs = 8000 } = {}) {
  if (!/^https?:/.test(url)) throw new Error(`不支持的协议：${url.slice(0, 12)}`)

  const agent = await getAgent()
  const proxyFirst = agent && Date.now() < preferProxyUntil
  const order = []
  if (config.proxyMode === 'always' && agent) {
    order.push({ name: '代理', agent })
    order.push({ name: '直连', agent: undefined })
  } else if (config.proxyMode === 'off' || !agent) {
    order.push({ name: '直连', agent: undefined })
  } else if (proxyFirst) {
    order.push({ name: '代理', agent })
    order.push({ name: '直连', agent: undefined })
  } else {
    order.push({ name: '直连', agent: undefined })
    order.push({ name: '代理', agent })
  }

  let lastErr
  for (const attempt of order) {
    try {
      const res =
        attempt.name === '直连'
          ? await fetchDirect(url, { headers, timeoutMs })
          : await requestOnce(url, { headers, timeoutMs, agent: attempt.agent })

      if (attempt.name === '直连') {
        directFailStreak = 0
      } else if (proxyFirst) {
        // 优先代理期间直连没被测到，保持现状
      } else {
        logger?.info?.(`[vrc-plugin] 直连失败，已通过代理取到图片：${url}`)
      }
      if (attempt.name === '代理') proxyFailStreak = 0
      return res
    } catch (err) {
      lastErr = Object.assign(err, { via: attempt.name })
      if (attempt.name === '直连') {
        directFailStreak += 1
        if (agent && directFailStreak >= 2) {
          if (directFailStreak === 2) {
            logger?.warn?.('[vrc-plugin] 直连连续失败，接下来 5 分钟优先走代理')
          }
          preferProxyUntil = Date.now() + DIRECT_FAIL_WINDOW
        }
      } else {
        logger?.warn?.(`[vrc-plugin] 经代理下载失败：${err.message} ${url}`)
        proxyFailStreak += 1
        // 代理也不行了，回到直连优先，别两头都卡
        if (proxyFailStreak >= 2) {
          preferProxyUntil = 0
          directFailStreak = 0
        }
      }
    }
  }
  throw lastErr || new Error('下载失败')
}
