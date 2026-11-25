// 登录态加密存储：内存里明文、磁盘上密文，密钥与数据分开放
//
// 设计约束：
// 1. 加密只发生在磁盘边界，调用方拿到的永远是 cookies 数组，不需要改任何业务代码
// 2. 旧版明文 users.json 首次加载时自动迁移，cookie 值不变，所以不需要重新登录
// 3. 解析失败先回退 .bak，两边都坏就抛错停机，绝不返回空对象顶替（否则一次损坏会清空整库）
// 4. 写盘用 tmp -> fsync -> rename，崩在写入瞬间也不会留下截断文件
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { PLUGIN_DIR, USERS_FILE, config } from './config.js'

const ALG = 'aes-256-gcm'
const ENC_FIELD = 'cookiesEnc'
const BAK_FILE = `${USERS_FILE}.bak`
const KEY_ENV = 'VRC_STORE_KEY'
const KEY_BYTES = 32

let keyCache = null

function warn(msg) {
  try { globalThis.logger?.warn?.(msg) } catch { /* noop */ }
}
function error(msg) {
  try { globalThis.logger?.error?.(msg) } catch { /* noop */ }
}

/** 密钥文件位置：config.storage.keyPath > 平台默认（Windows 用户目录、Linux/macOS XDG 目录） */
export function resolveKeyPath() {
  const custom = config?.storage?.keyPath
  if (custom) return path.isAbsolute(custom) ? custom : path.resolve(PLUGIN_DIR, custom)
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(base, 'vrc-plugin', 'store.key')
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'vrc-plugin', 'store.key')
}

function parseKey(raw) {
  const text = String(raw || '').trim()
  if (!text) throw new Error('密钥为空')
  const buf = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64')
  if (buf.length !== KEY_BYTES) {
    throw new Error(`密钥长度不对：需要 ${KEY_BYTES} 字节（base64 或 64 位 hex），当前 ${buf.length} 字节`)
  }
  return buf
}

/** 取密钥：环境变量优先，其次密钥文件，都没有就生成一个 */
function getKey() {
  if (keyCache) return keyCache
  const fromEnv = process.env[KEY_ENV]
  if (fromEnv) {
    keyCache = parseKey(fromEnv)
    return keyCache
  }
  const file = resolveKeyPath()
  if (fs.existsSync(file)) {
    keyCache = parseKey(fs.readFileSync(file, 'utf8'))
    return keyCache
  }
  const buf = crypto.randomBytes(KEY_BYTES)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${buf.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* Windows 上 chmod 无效，靠用户目录自身的 ACL */ }
  warn(`[vrc-plugin] 已生成存储密钥：${file}\n换机器或重建容器时要把这个文件一起带走，否则已保存的登录态解不开，只能重新登录`)
  keyCache = buf
  return keyCache
}

function encryptValue(qq, value) {
  const key = getKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALG, key, iv)
  cipher.setAAD(Buffer.from(`vrc-plugin:${qq}`))
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return {
    v: 1,
    alg: ALG,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64')
  }
}

function decryptValue(qq, enc) {
  if (!enc || enc.v !== 1 || enc.alg !== ALG) throw new Error('密文格式不认识')
  const key = getKey()
  const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(String(enc.iv), 'base64'))
  decipher.setAAD(Buffer.from(`vrc-plugin:${qq}`))
  decipher.setAuthTag(Buffer.from(String(enc.tag), 'base64'))
  let plain
  try {
    plain = Buffer.concat([
      decipher.update(Buffer.from(String(enc.data), 'base64')),
      decipher.final()
    ])
  } catch (err) {
    throw new Error(`密文校验失败，密钥不匹配或数据被改动：${err.message}`)
  }
  try {
    return JSON.parse(plain.toString('utf8'))
  } catch (err) {
    throw new Error(`解密后的内容不是合法 JSON：${err.message}`)
  }
}

function encryptionOn() {
  return config?.storage?.encrypt !== false
}

function readRaw(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层不是对象')
  return parsed
}

/** 读盘；解析失败先回退 .bak，两边都坏就抛错 */
function readStoreFile() {
  if (!fs.existsSync(USERS_FILE)) return { data: {}, recovered: false }
  let primaryErr = null
  try {
    return { data: readRaw(USERS_FILE), recovered: false }
  } catch (err) {
    primaryErr = err
  }
  if (fs.existsSync(BAK_FILE)) {
    try {
      const data = readRaw(BAK_FILE)
      error(`[vrc-plugin] users.json 读取失败（${primaryErr.message}），已回退到 users.json.bak`)
      return { data, recovered: true }
    } catch (bakErr) {
      throw new Error(
        `登录态文件无法解析，备份也不可用：${primaryErr.message} / ${bakErr.message}。` +
        `为避免覆盖原始数据，插件已停止读写，请手动检查 ${USERS_FILE}`
      )
    }
  }
  throw new Error(
    `登录态文件无法解析：${primaryErr.message}。为避免覆盖原始数据，插件已停止读写，请手动检查 ${USERS_FILE}`
  )
}

function encodeRecord(qq, rec) {
  const out = { ...rec }
  const cookies = out.cookies
  delete out.cookies
  delete out[ENC_FIELD]
  if (encryptionOn() && Array.isArray(cookies) && cookies.length) out[ENC_FIELD] = encryptValue(qq, cookies)
  else if (Array.isArray(cookies) && cookies.length) out.cookies = cookies
  return out
}

function serialize(store) {
  const out = {}
  for (const [qq, rec] of Object.entries(store)) {
    out[qq] = rec && typeof rec === 'object' && !Array.isArray(rec) ? encodeRecord(qq, rec) : rec
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/** 把当前文件留成 .bak，但只有能正常解析的才配当备份 */
function backupCurrent() {
  try {
    if (!fs.existsSync(USERS_FILE)) return
    readRaw(USERS_FILE)
    fs.copyFileSync(USERS_FILE, BAK_FILE)
  } catch { /* 坏文件不当备份 */ }
}

function writeAtomicSync(content, { backup = true } = {}) {
  if (backup) backupCurrent()
  const tmp = `${USERS_FILE}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, content, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, USERS_FILE)
}

async function writeAtomic(content, { backup = true } = {}) {
  if (backup) backupCurrent()
  const tmp = `${USERS_FILE}.${process.pid}.tmp`
  const fh = await fs.promises.open(tmp, 'w')
  try {
    await fh.writeFile(content, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fs.promises.rename(tmp, USERS_FILE)
}

/**
 * 读取全部账号记录（cookies 已解密成数组）
 * 旧版明文会在这一步顺手迁移成密文，cookie 值本身不变
 */
export function loadUsersStore() {
  const { data, recovered } = readStoreFile()
  const store = {}
  let legacy = false

  for (const [qq, rec] of Object.entries(data)) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      store[qq] = rec
      continue
    }
    const out = { ...rec }
    if (out[ENC_FIELD]) {
      try {
        out.cookies = decryptValue(qq, out[ENC_FIELD])
      } catch (err) {
        throw new Error(`QQ ${qq} 的登录态解密失败（${err.message}）。密钥文件可能被换掉或不属于这台机器；确认后删除该条记录即可重新登录`)
      }
    } else if (Array.isArray(out.cookies) && out.cookies.length) {
      legacy = true
    }
    store[qq] = out
  }

  if ((legacy || recovered) && encryptionOn()) {
    try {
      const content = serialize(store)
      // 迁移时直接把密文写成 .bak，避免 data 目录里残留一份明文备份
      fs.writeFileSync(BAK_FILE, content, 'utf8')
      writeAtomicSync(content, { backup: false })
      if (legacy) warn(`[vrc-plugin] users.json 已迁移为加密存储（同内容备份：${BAK_FILE}）`)
      else warn(`[vrc-plugin] users.json 已从 .bak 恢复`)
    } catch (err) {
      error(`[vrc-plugin] 登录态迁移失败：${err.message}（本次仍按明文在内存里继续用，重启前不会写回明文）`)
    }
  }

  return store
}

/** 全量写盘（同步版，只在迁移等一次性场景用） */
export function saveUsersStoreSync(store) {
  writeAtomicSync(serialize(store))
}

/** 全量写盘（异步版，业务写入都走它） */
export async function saveUsersStore(store) {
  await writeAtomic(serialize(store))
}
