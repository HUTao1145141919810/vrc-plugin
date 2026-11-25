// VRChat 客户端池 / 登录 / 数据查询
import fs from 'fs'
import { VRChat } from 'vrchat'
import { config, USERS_FILE } from './config.js'

/* ---------------- Node 20 兼容：SDK 内部用了 Promise.withResolvers ---------------- */
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

/* ---------------- 状态 / 信任 / 位置 归一化（对齐上游 vrchat/utils.py） ---------------- */

const NORMALIZE_STATUS_MAP = {
  active: 'online',
  'join me': 'joinme',
  busy: 'busy',
  'ask me': 'askme'
}

const NORMALIZE_TRUST_TAG_MAP = {
  veteran: 'trusted',
  trusted: 'known',
  known: 'user'
}

const DEVELOPER_TRUST_TYPE_MAP = {
  internal: 'developer',
  moderator: 'moderator'
}

const TRUST_ORDER = ['visitor', 'new', 'user', 'known', 'trusted', 'friend', 'developer', 'moderator']

export function normalizeStatus(status, location) {
  // status 才是 VRChat 给的「在线状态偏好」，location 才代表是否真的在游戏里。
  // 之前把「status=active 但 location=offline」当成 webonline，导致离线好友全显示成网页版在线。
  if (status === 'webonline') return 'webonline'
  if (status === 'offline') return 'offline'
  if (location === 'offline') return 'offline'
  return NORMALIZE_STATUS_MAP[status] || 'unknown'
}

export function extractTrustLevel(tags = [], developerType) {
  if (DEVELOPER_TRUST_TYPE_MAP[developerType]) return DEVELOPER_TRUST_TYPE_MAP[developerType]
  for (const [suffix, level] of Object.entries(NORMALIZE_TRUST_TAG_MAP)) {
    if (tags.includes(`system_trust_${suffix}`)) return level
  }
  return 'visitor'
}

export function trustRank(trust) {
  const i = TRUST_ORDER.indexOf(trust)
  return i < 0 ? 0 : i
}

/** 把 VRChat 的 snake_case 用户对象补成上游模板要的字段 */
export function normalizeUser(raw) {
  if (!raw) return null
  const tags = Array.isArray(raw.tags) ? raw.tags : []
  const status = raw.status || 'offline'
  const location = raw.location
  return {
    ...raw,
    userId: raw.id,
    displayName: raw.displayName || raw.username || '',
    originalStatus: status,
    statusDesc: raw.statusDescription || '',
    normalizedStatus: normalizeStatus(status, location),
    trust: extractTrustLevel(tags, raw.developerType),
    lastPlatform: raw.last_platform || 'unknownplatform',
    // 搜索结果返回的是 LimitedUser，没有 currentAvatarThumbnailImageUrl，头像是 iconUrl
    avatar:
      raw.currentAvatarThumbnailImageUrl ||
      raw.currentAvatarImageUrl ||
      raw.iconUrl ||
      raw.profilePicOverride ||
      '',
    dateJoined: raw.date_joined || '',
    isFriend: raw.isFriend === true,
    ageVerified: raw.ageVerified === true,
    bio: raw.bio || '',
    lastLogin: raw.last_login || raw.lastLogin || '',
    location: location || '',
    state: raw.state || 'offline'
  }
}

/* ---------------- 时间 / 位置文案 ---------------- */

const TIME_UNITS = [
  ['年', 60 * 60 * 24 * 365],
  ['月', 60 * 60 * 24 * 30],
  ['日', 60 * 60 * 24],
  ['时', 60 * 60],
  ['分', 60],
  ['秒', 1]
]

/** 对应上游 td_format：X前上线 */
export function tdFormat(tdMs) {
  let seconds = Math.floor(Math.max(0, tdMs) / 1000)
  for (const [name, sec] of TIME_UNITS) {
    if (seconds > sec) {
      const value = Math.floor(seconds / sec)
      return `${value}${name}前上线`
    }
  }
  return '很久没上线'
}

const worldNameCache = new Map() // worldId -> { name, at }
const WORLD_CACHE_TTL = 10 * 60 * 1000

export async function getWorldName(client, worldId) {
  const hit = worldNameCache.get(worldId)
  if (hit && Date.now() - hit.at < WORLD_CACHE_TTL) return hit.name
  try {
    const r = await client.getWorld({ path: { worldId }, credentials: 'include' })
    const name = r.data?.name || '未知世界'
    worldNameCache.set(worldId, { name, at: Date.now() })
    return name
  } catch {
    return '未知世界'
  }
}

/** 对应上游 format_location */
export async function formatLocation(client, location) {
  if (!location) return ''
  if (location === 'traveling') return '加载世界'
  if (location === 'private') return '私有世界'

  const worldId = String(location).split(':')[0]
  const region = location.includes('region(')
    ? location.slice(location.indexOf('region(') + 7, location.indexOf(')')).toUpperCase()
    : null

  let prefix
  if (location.includes('group')) {
    if (location.includes('groupAccessType(members)')) prefix = '组'
    else if (location.includes('groupAccessType(plus)')) prefix = '组+'
    else prefix = '公组'
  } else if (location.includes('private')) {
    prefix = location.includes('canRequestInvite') ? '邀+' : '邀'
  } else if (location.includes('friends')) {
    prefix = '友'
  } else if (location.includes('hidden')) {
    prefix = '友+'
  } else {
    prefix = '公'
  }

  const worldName = await getWorldName(client, worldId)
  let ret = `${prefix} |`
  if (region) ret = `${ret} ${region} |`
  return `${ret}\n${worldName}`
}

export function formatDateTime(value) {
  if (!value) return '未知'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ---------------- 本地账号存储 ---------------- */

let storeCache = null
let writeQueue = Promise.resolve()

function loadStore() {
  if (storeCache) return storeCache
  try {
    storeCache = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
  } catch {
    storeCache = {}
  }
  if (typeof storeCache !== 'object' || storeCache === null) storeCache = {}
  return storeCache
}

function flush() {
  const snapshot = JSON.stringify(loadStore(), null, 2)
  writeQueue = writeQueue.then(
    () => fs.promises.writeFile(USERS_FILE, snapshot, 'utf8'),
    () => fs.promises.writeFile(USERS_FILE, snapshot, 'utf8')
  )
  return writeQueue
}

export function getUserRecord(qq) {
  return loadStore()[String(qq)] || null
}

export function saveUserRecord(qq, record) {
  const store = loadStore()
  store[String(qq)] = record
  return flush()
}

export function removeUserRecord(qq) {
  const store = loadStore()
  delete store[String(qq)]
  return flush()
}

/** 已保存过登录态的 QQ 列表（用于启动时预热会话） */
export function listUserKeys() {
  return Object.keys(loadStore())
}

/* ---------------- 客户端池 ---------------- */

const pool = new Map() // qq -> VRChat client

function createClient() {
  return new VRChat({
    application: {
      name: config.appName,
      version: config.appVersion,
      contact: config.contact
    },
    timeout: 20000
  })
}

/** 取（或创建）某个 QQ 的客户端，并恢复它上次保存的 cookie */
export async function getClient(qq) {
  let client = pool.get(String(qq))
  if (client) return client

  client = createClient()
  pool.set(String(qq), client)

  const record = getUserRecord(qq)
  if (record?.cookies?.length) {
    try {
      await client.cache.set('cookies', record.cookies)
    } catch (err) {
      logger?.warn?.(`[vrc-plugin] 恢复 cookie 失败：${err.message}`)
    }
  }
  return client
}

export function dropClient(qq) {
  pool.delete(String(qq))
}

/* ---------------- 登录态检查 ---------------- */

/**
 * 检查登录态，不会抛错
 * @returns {{ok:boolean, user?:object, need2fa?:boolean, methods?:string[], error?:string, status?:number}}
 */
export async function checkAuth(client) {
  try {
    // VRChat 的 /auth/user 偶尔要 10s 才回（国内直连更明显），SDK 默认超时正好卡在 10s
    const r = await client.client.get({ url: '/auth/user', credentials: 'include', timeout: 25000 })
    const data = r.data
    if (data && data.id) return { ok: true, user: normalizeUser(data), status: r.response?.status }
    if (data && Array.isArray(data.requiresTwoFactorAuth)) {
      return { ok: false, need2fa: true, methods: data.requiresTwoFactorAuth, status: r.response?.status }
    }
    return {
      ok: false,
      error: data?.error?.message || `HTTP ${r.response?.status ?? 'unknown'}`,
      status: r.response?.status
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/* ---------------- 登录 / 2FA ---------------- */

function basicAuth(username, password) {
  const raw = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
}

/**
 * 第一步：账号密码登录（自己拼，避免 SDK login() 自动发一次空验证码）
 * @returns {{ok:boolean, user?:object, need2fa?:boolean, methods?:string[], error?:string}}
 */
export async function loginWithPassword(client, username, password) {
  let r
  try {
    r = await client.client.get({
      url: '/auth/user',
      headers: { authorization: basicAuth(username, password) },
      credentials: 'omit'
    })
  } catch (err) {
    return { ok: false, error: err.message }
  }

  const data = r.data
  if (data && data.id) {
    // 登录成功，cookie 已经由 response 拦截器写进 cache
    return { ok: true, user: normalizeUser(data) }
  }
  if (data && Array.isArray(data.requiresTwoFactorAuth) && data.requiresTwoFactorAuth.length) {
    return { ok: false, need2fa: true, methods: data.requiresTwoFactorAuth }
  }
  if (r.response?.status === 401 || data?.error) {
    return { ok: false, error: data?.error?.message || 'Invalid Credentials' }
  }
  return { ok: false, error: `HTTP ${r.response?.status ?? 'unknown'}` }
}

/**
 * 第二步：提交 2FA 验证码（同时尝试 totp / emailOtp / 恢复码，任一通过即成功）
 * @returns {{ok:boolean, user?:object, error?:string}}
 */
export async function submitTwoFactor(client, code, methods = ['totp', 'emailOtp', 'otp']) {
  const body = { code: String(code).trim() }
  const attempts = []
  if (methods.includes('totp')) attempts.push(() => client.verify2Fa({ body, credentials: 'include' }))
  if (methods.includes('emailOtp')) attempts.push(() => client.verify2FaEmailCode({ body, credentials: 'include' }))
  if (methods.includes('otp')) attempts.push(() => client.verifyRecoveryCode({ body, credentials: 'include' }))

  if (!attempts.length) return { ok: false, error: '该账号没有可用的验证方式' }

  const results = await Promise.all(
    attempts.map(fn =>
      fn().then(
        r => ({ verified: r?.data?.verified === true }),
        () => ({ verified: false })
      )
    )
  )

  if (!results.some(x => x.verified)) return { ok: false, error: '验证码错误' }

  const auth = await checkAuth(client)
  if (auth.ok) return { ok: true, user: auth.user }
  return { ok: false, error: auth.error || '验证后仍无法获取账号信息' }
}

/** 把当前客户端的 cookie 落盘（节流：同一账号 5 分钟内不重复写） */
const lastPersist = new Map()

export async function persistSession(qq, client, user, { force = false } = {}) {
  const key = String(qq)
  const last = lastPersist.get(key) || 0
  if (!force && Date.now() - last < 5 * 60 * 1000) return getUserRecord(qq)

  let cookies = []
  try {
    cookies = await client.getCookies()
  } catch { /* noop */ }
  const record = {
    userId: user?.userId || '',
    displayName: user?.displayName || '',
    cookies,
    loginAt: Date.now()
  }
  await saveUserRecord(key, record)
  lastPersist.set(key, Date.now())
  return record
}

/** 退出登录 */
export async function logout(qq) {
  const key = String(qq)
  const client = pool.get(key)
  if (client) {
    try {
      await client.logout({ credentials: 'include' })
    } catch { /* noop */ }
  }
  dropClient(key)
  lastPersist.delete(key)
  await removeUserRecord(key)
}

/* ---------------- 数据查询 ---------------- */

function unwrap(result, fallbackMsg = '请求失败') {
  if (!result) throw new Error(fallbackMsg)
  if (result.data !== undefined && result.data !== null) return result.data
  const msg = result.error?.message || `HTTP ${result.response?.status ?? 'unknown'}`
  throw new Error(msg)
}

/**
 * 分页拉好友。
 * VRChat 的 offline 参数是「只看离线」而不是「包含离线」，
 * 所以要分两次拉：先拉在线，再拉离线，最后合并去重。
 */
async function pagedFriends(client, offline, max) {
  const out = []
  let offset = 0
  const pageSize = 100
  while (out.length < max) {
    const want = Math.min(pageSize, max - out.length)
    let r
    try {
      r = await client.getFriends({
        query: { n: want, offset, offline },
        credentials: 'include'
      })
    } catch {
      break
    }
    const data = r?.data
    if (!Array.isArray(data) || !data.length) break
    out.push(...data)
    offset += data.length
    if (data.length < want) break
  }
  return out
}

/** 拉取全部好友（在线 + 离线），返回归一化后的数组 */
export async function fetchFriends(client, { max = 300 } = {}) {
  const onlineList = await pagedFriends(client, false, max)
  const remain = max - onlineList.length
  const offlineList = remain > 0 ? await pagedFriends(client, true, remain) : []

  const seen = new Set()
  const merged = []
  for (const user of [...onlineList, ...offlineList]) {
    if (!user?.id || seen.has(user.id)) continue
    seen.add(user.id)
    merged.push(user)
  }
  return merged.map(normalizeUser).filter(Boolean)
}

export async function searchUsers(client, keyword, { n = 30, offset = 0 } = {}) {
  const r = await client.searchUsers({
    query: { search: keyword, n, offset },
    credentials: 'include'
  })
  const data = unwrap(r)
  return Array.isArray(data) ? data.map(normalizeUser).filter(Boolean) : []
}

export async function searchWorlds(client, keyword, { n = 20, offset = 0 } = {}) {
  const r = await client.searchWorlds({
    query: { search: keyword, n, offset, releaseStatus: 'public' },
    credentials: 'include'
  })
  const data = unwrap(r)
  return Array.isArray(data) ? data : []
}

export async function getWorld(client, worldId) {
  const r = await client.getWorld({ path: { worldId }, credentials: 'include' })
  return unwrap(r)
}

export async function getUser(client, userId) {
  const r = await client.getUser({ path: { userId }, credentials: 'include' })
  return normalizeUser(unwrap(r))
}

export async function getNotifications(client, { n = 20, offset = 0 } = {}) {
  const r = await client.getNotifications({ query: { n, offset }, credentials: 'include' })
  const data = unwrap(r)
  return Array.isArray(data) ? data : []
}

export async function getFavorites(client, type, { n = 100, offset = 0 } = {}) {
  const r = await client.getFavorites({ query: { n, offset, type }, credentials: 'include' })
  const data = unwrap(r)
  return Array.isArray(data) ? data : []
}

export async function getFavoriteGroups(client, { n = 100, offset = 0 } = {}) {
  const r = await client.getFavoriteGroups({ query: { n, offset }, credentials: 'include' })
  const data = unwrap(r)
  return Array.isArray(data) ? data : []
}

/** 拉某个收藏组里的内容，每条带着它指向的对象（world / avatar），能拿到名字和缩略图 */
export async function getFavoriteGroupContents(client, type, name) {
  // 不用 SDK 的 getFavoriteGroupContents：它对这个接口返回的精简 avatar 会做
  // unityPackages.map(...) 转换，而收藏里的 avatar 没有该字段，会直接抛
  // "data.unityPackages.map is not a function"。这里直连底层 client。
  const r = await client.client.get({
    url: '/favorites/groups/{favoriteGroupType}/{favoriteGroupName}',
    path: { favoriteGroupType: type, favoriteGroupName: name },
    credentials: 'include'
  })
  const data = r?.data ?? r
  const list = Array.isArray(data?.favorites) ? data.favorites : []
  return list.map(entry => {
    const target = entry.world || entry.avatar || {}
    return {
      id: entry.favoriteId || entry.id,
      type: entry.type,
      tags: entry.tags || [],
      name: target.name || entry.favoriteId || entry.id || '未知',
      author: target.authorName || '',
      thumb: target.thumbnailImageUrl || target.imageUrl || '',
      missing: !entry.world && !entry.avatar
    }
  })
}

export async function acceptFriendRequest(client, notificationId) {
  const r = await client.acceptFriendRequest({ path: { notificationId }, credentials: 'include' })
  return r
}

export async function ignoreFriendRequest(client, notificationId) {
  const r = await client.client.put({
    url: '/auth/user/notifications/{notificationId}/hide',
    path: { notificationId },
    credentials: 'include'
  })
  return r
}

export async function denyFriendRequest(client, notificationId) {
  const r = await client.client.delete({
    url: '/auth/user/notifications/{notificationId}',
    path: { notificationId },
    credentials: 'include'
  })
  return r
}

/* ---------------- 社交动作（加好友 / 好友状态 / 加收藏） ---------------- */

/** 查与某用户的好友关系：{ isFriend, incomingRequest, outgoingRequest } */
export async function getFriendStatus(client, userId) {
  const r = await client.getFriendStatus({ path: { userId }, credentials: 'include' })
  const data = unwrap(r) || {}
  return {
    isFriend: data.isFriend === true,
    incomingRequest: data.incomingRequest === true,
    outgoingRequest: data.outgoingRequest === true
  }
}

/** 发送好友请求 */
export async function sendFriendRequest(client, userId) {
  const r = await client.friend({ path: { userId }, credentials: 'include' })
  return unwrap(r)
}

/** 收藏（type: world / avatar / friend），tags 为收藏组名 */
export async function addFavorite(client, { type, favoriteId, tags = [] }) {
  const r = await client.addFavorite({
    body: { type, favoriteId, tags },
    credentials: 'include'
  })
  return unwrap(r)
}

/** 收藏组列表（用于取默认组名） */
export async function getFavoriteLimits(client) {
  const r = await client.getFavoriteLimits({ credentials: 'include' })
  return unwrap(r)
}
