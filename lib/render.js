// 渲染：puppeteer 截图（对应上游 nonebot_plugin_htmlrender.template_to_pic）
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { PLUGIN_DIR, TMP_DIR, config } from './config.js'
import { isProxyAlive } from './proxy.js'
import { sleep } from './utils.js'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(PLUGIN_DIR, '..', '..')

/**
 * 查找 puppeteer：云崽把 puppeteer 装在根 node_modules，插件自己不带这个依赖。
 * 依次尝试：
 *   1. 环境变量 VRC_PUPPETEER_DIR（指向 node_modules 目录，或直接指向 puppeteer 包目录）
 *   2. 从插件目录向上最多 6 级找 node_modules/puppeteer（标准部署即 plugins/xxx → 云崽根）
 *   3. 直接 require('puppeteer')，依赖解析链命中的情况
 * 都找不到就返回 null，由 getBrowser() 抛出可读错误，不影响其它文字指令
 */
let _puppeteer = null
let _puppeteerFrom = ''
let _puppeteerErr = ''

function loadPuppeteer() {
  if (_puppeteer || _puppeteerErr) return _puppeteer
  const candidates = []
  const envDir = process.env.VRC_PUPPETEER_DIR
  if (envDir) {
    candidates.push(path.join(envDir, 'puppeteer'), envDir)
  }
  let dir = PLUGIN_DIR
  for (let i = 0; i < 6; i++) {
    dir = path.dirname(dir)
    candidates.push(path.join(dir, 'node_modules', 'puppeteer'))
  }
  for (const c of candidates) {
    try {
      _puppeteer = require(c)
      _puppeteerFrom = c
      return _puppeteer
    } catch { /* 换下一个候选 */ }
  }
  try {
    _puppeteer = require('puppeteer')
    _puppeteerFrom = 'puppeteer'
  } catch (err) {
    _puppeteerErr = err?.message || String(err)
    logger?.warn?.(`[vrc-plugin] 未找到 puppeteer，出图功能不可用：${_puppeteerErr}`)
  }
  return _puppeteer
}

// 浏览器可执行文件候选：环境变量优先，其后覆盖 Windows / Linux / macOS 常见安装位置。
// 全部不存在时返回 undefined，交给 puppeteer 用它自己缓存里的 chromium。
const CHROME_PATHS = [
  process.env.VRC_CHROME_PATH,
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
].filter(Boolean)

function resolveChrome() {
  for (const p of CHROME_PATHS) {
    try {
      if (fs.existsSync(p)) return p
    } catch { /* 忽略无权访问的路径 */ }
  }
  return undefined
}

let _browser = null
let _idleTimer = null
const IDLE_MS = 10 * 60 * 1000

function touchIdle() {
  if (_idleTimer) clearTimeout(_idleTimer)
  _idleTimer = setTimeout(() => {
    closeBrowser()
    logger?.info?.('[vrc-plugin] 渲染浏览器空闲，已回收')
  }, IDLE_MS)
  _idleTimer.unref?.()
}

export function closeBrowser() {
  try { _browser?.close() } catch { /* noop */ }
  _browser = null
}

async function getBrowser() {
  touchIdle()
  if (_browser && _browser.connected) return _browser

  const puppeteer = loadPuppeteer()
  if (!puppeteer) {
    throw new Error(
      '未找到 puppeteer：本插件不自带该依赖，需要云崽根目录已安装（如 pnpm add puppeteer）。' +
        '若装在其他位置，可用环境变量 VRC_PUPPETEER_DIR 指向含 puppeteer 的 node_modules 目录。' +
        (_puppeteerErr ? `（原始错误：${_puppeteerErr}）` : '')
    )
  }

  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--force-device-scale-factor=1']
  // 头像下载失败时会回退成「浏览器直接加载原图」，此时需要浏览器也能走代理；
  // 只有代理真的在监听才挂参数，避免代理没开导致页面整体变慢
  if (config.proxy && config.proxyMode !== 'off' && (await isProxyAlive())) {
    args.push(`--proxy-server=${config.proxy}`)
    logger?.info?.(`[vrc-plugin] 渲染浏览器使用代理 ${config.proxy}`)
  }

  const executablePath = resolveChrome()
  if (!executablePath) {
    logger?.warn?.('[vrc-plugin] 没找到系统 Chrome/Chromium，改为使用 puppeteer 自带的浏览器')
  }
  _browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args
  })
  logger?.info?.(`[vrc-plugin] 渲染浏览器就绪：${executablePath || 'puppeteer 自带'}（puppeteer: ${_puppeteerFrom}）`)
  return _browser
}

function toFileUrl(p) {
  const normalized = String(p).replace(/\\/g, '/').replace(/^\/+/, '')
  return 'file:///' + encodeURI(normalized)
}

/** 清理超过 keepMs 的临时文件 */
export function pruneTmp(keepMs = 30 * 60 * 1000) {
  try {
    const now = Date.now()
    for (const f of fs.readdirSync(TMP_DIR)) {
      const full = path.join(TMP_DIR, f)
      const st = fs.statSync(full)
      if (now - st.mtimeMs > keepMs) fs.unlinkSync(full)
    }
  } catch { /* noop */ }
}

/**
 * 渲染 HTML 字符串为 jpg 文件
 * @param {string} html
 * @param {{width:number,height?:number,quality?:number}} opt
 * @returns {Promise<string>} 生成的图片绝对路径
 */
export async function renderHtml(html, opt = {}) {
  const width = opt.width || 1200
  const height = opt.height || 100
  const quality = opt.quality || config.jpegQuality

  const browser = await getBrowser()
  const page = await browser.newPage()
  const imgFile = path.join(TMP_DIR, `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`)

  // setContent 的文档 origin 是 opaque，加载不了 file:// 本地封面，必须落成文件再 goto
  const htmlFile = path.join(TMP_DIR, `_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.html`)

  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 })
    fs.writeFileSync(htmlFile, html, 'utf8')
    await page.goto(toFileUrl(htmlFile), { waitUntil: 'load', timeout: 30000 })

    // 等图片与字体就绪，避免截到半张图
    await page.evaluate(() => {
      const waits = Array.from(document.images).map(img => new Promise(resolve => {
        if (img.complete) return resolve()
        img.addEventListener('load', resolve, { once: true })
        img.addEventListener('error', resolve, { once: true })
        setTimeout(resolve, 4000)
      }))
      const fontReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve()
      return Promise.all([Promise.all(waits), fontReady])
    })
    await sleep(250)

    await page.screenshot({ path: imgFile, type: 'jpeg', quality, fullPage: true })
    pruneTmp()
    return imgFile
  } finally {
    try { await page.close() } catch { /* noop */ }
    try { fs.unlinkSync(htmlFile) } catch { /* noop */ }
  }
}

process.on('exit', closeBrowser)

