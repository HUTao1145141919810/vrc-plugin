// 配置与路径
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const PLUGIN_DIR = path.resolve(__dirname, '..')
export const RES_DIR = path.join(PLUGIN_DIR, 'resources')
export const DATA_DIR = path.join(PLUGIN_DIR, 'data')
export const TMP_DIR = path.join(DATA_DIR, 'tmp')
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
export const USERS_FILE = path.join(DATA_DIR, 'users.json')

for (const d of [DATA_DIR, TMP_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

const DEFAULT_CONFIG = {
  // VRChat 要求 User-Agent 里带可联系的邮箱，域名必须真实存在；
  // example.com / test.com 这类假域名会被 Cloudflare 直接 403，部署时改成自己的邮箱更合适
  appName: 'vrc-plugin',
  appVersion: '1.0.0',
  contact: 'vrc-plugin@qq.com',
  // 头像转 base64 后内嵌渲染（对应上游 vrchat_avatar，关掉能明显提速但头像会裂）
  avatarBase64: true,
  // 登录 / 2FA 的等待秒数
  sessionTimeout: 120,
  // 好友列表最多拉取多少个
  maxFriends: 300,
  // 各页面出图宽度（与上游模板的设计宽度对应）
  viewport: {
    friend: 1300,
    player: 760,
    worldInfo: 880,
    worldList: 940,
    notify: 1120
  },
  jpegQuality: 82,
  // 图片 / 头像下载用的 HTTP 代理。
  // 默认留空 = 全部直连。国内直连 api.vrchat.cloud 首包常要 6~10 秒，图片也偶尔拉不下来；
  // 遇到这种情况再改成本地代理地址，并把 proxyMode 从 'off' 改成 'fallback'：
  //   "proxy": "http://127.0.0.1:7890", "proxyMode": "fallback"
  // proxyMode: 'off' 只直连 | 'fallback' 直连失败再走代理 | 'always' 先走代理、失败再直连
  proxy: '',
  proxyMode: 'off'
}

function merge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  if (!extra || typeof extra !== 'object') return out
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object') {
      out[k] = merge(base[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8')
      return { ...DEFAULT_CONFIG }
    }
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    const merged = merge(DEFAULT_CONFIG, raw)
    // 版本升级后新增的字段补写回文件，方便用户直接改
    if (Object.keys(DEFAULT_CONFIG).some(k => !(k in raw))) {
      try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8')
      } catch { /* 写不进去也不影响运行 */ }
    }
    return merged
  } catch (err) {
    logger?.error?.(`[vrc-plugin] 读取 config.json 失败：${err.message}`)
    return { ...DEFAULT_CONFIG }
  }
}

export const config = loadConfig()

/** 供 index 修改后写回 */
export function saveConfig(next) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    logger?.error?.(`[vrc-plugin] 写入 config.json 失败：${err.message}`)
  }
}

/** 本地资源的 file:// 地址，用于 HTML 里引用 css */
export function fileUrl(absPath) {
  const normalized = String(absPath).replace(/\\/g, '/').replace(/^\/+/, '')
  return 'file:///' + encodeURI(normalized)
}
