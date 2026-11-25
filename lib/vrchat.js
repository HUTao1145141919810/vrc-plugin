// VRChat 客户端池 / 登录 / 数据查询
import { VRChat } from 'vrchat'
import { config } from './config.js'
import { loadUsersStore, saveUsersStore } from './store.js'

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
  // status 是 VRChat 的「在线状态偏好」，location 才代表是否真在游戏里：
  // status=active 且 location=offline 的人算离线，不算网页在线。
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

const worldNameCache = new Map() // worldId -> { name, at, ttl }
const worldPending = new Map() // worldId -> Promise，用来合并同一世界的并发查询
const WORLD_CACHE_TTL = 10 * 60 * 1000
const WORLD_NEGATIVE_TTL = 60 * 1000 // 查询失败短缓存，别一直重试
const WORLD_MISSING_TTL = 60 * 60 * 1000 // 世界真的不存在，缓存久一点
const WORLD_CACHE_MAX = 500
const warnedWorlds = new Set()

function rememberWorld(worldId, name, ttl) {
  worldNameCache.set(worldId, { name, at: Date.now(), ttl })
  if (worldNameCache.size <= WORLD_CACHE_MAX) return
  // 先清过期的，再按插入顺序淘汰最旧的
  const now = Date.now()
  for (const [id, item] of worldNameCache) {
    if (now - item.at >= item.ttl) worldNameCache.delete(id)
  }
  while (worldNameCache.size > WORLD_CACHE_MAX) {
    const oldest = worldNameCache.keys().next().value
    worldNameCache.delete(oldest)
  }
}

export async function getWorldName(client, worldId) {
  if (!worldId) return '未知世界'

  const hit = worldNameCache.get(worldId)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.name
  if (hit) worldNameCache.delete(worldId)

  // 好友列表里十个人在同一个世界很常见，同一个 id 只发一次请求
  const inflight = worldPending.get(worldId)
  if (inflight) return inflight

  const task = (async () => {
    try {
      const r = await client.getWorld({ path: { worldId }, credentials: 'include' })
      const name = r.data?.name || '未知世界'
      rememberWorld(worldId, name, WORLD_CACHE_TTL)
      return name
    } catch (err) {
      const status = err?.response?.status
      if (status === 404) {
        rememberWorld(worldId, '世界不存在', WORLD_MISSING_TTL)
        return '世界不存在'
      }
      rememberWorld(worldId, '获取失败', WORLD_NEGATIVE_TTL)
      if (!warnedWorlds.has(worldId)) {
        if (warnedWorlds.size > 1000) warnedWorlds.clear()
        warnedWorlds.add(worldId)
        logger?.info?.(`[vrc-plugin] 世界名查询失败 worldId=${worldId}：${err?.message || err}`)
      }
      return '获取失败'
    }
  })()

  worldPending.set(worldId, task)
  try {
    return await task
  } finally {
    worldPending.delete(worldId)
  }
}

/**
 * 拆 location 字符串：worldId / 实例 id / 区域 / 访问类型
 * 例：wrld_xxx:12345~region(us) → { worldId:'wrld_xxx', instanceId:'12345~region(us)', region:'US', access:'公' }
 */
export function parseLocation(location) {
  const raw = String(location || '')
  if (!raw || raw === 'offline') return null
  if (raw === 'traveling' || raw === 'private') {
    return {
      worldId: '',
      instanceId: '',
      region: null,
      access: '',
      special: raw === 'traveling' ? '加载世界' : '私有世界'
    }
  }
  const [worldId, instanceId = ''] = raw.split(':')
  // 从 region( 开始再找右括号，别被 private(usr_x) 里的括号截断
  const regionAt = raw.indexOf('region(')
  const region =
    regionAt >= 0 ? raw.slice(regionAt + 7, raw.indexOf(')', regionAt)).toUpperCase() : null

  let access = '公'
  if (raw.includes('group')) {
    if (raw.includes('groupAccessType(members)')) access = '组'
    else if (raw.includes('groupAccessType(plus)')) access = '组+'
    else access = '公组'
  } else if (raw.includes('private')) {
    access = raw.includes('canRequestInvite') ? '邀+' : '邀'
  } else if (raw.includes('friends')) {
    access = '友'
  } else if (raw.includes('hidden')) {
    access = '友+'
  }
  return { worldId, instanceId, region, access, special: '' }
}

/** 实例 id 里带 ownerId 之类的东西，取个短标识用来区分同世界的不同房间，不泄露原始 id */
function shortHash(text) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36).slice(-4).padStart(4, '0')
}

/** 房间标签：公共实例显示房间号，其余用短哈希，保证同世界不同房间能分开看 */
export function roomLabel(meta) {
  if (!meta) return ''
  if (meta.special) return meta.special
  const num = /^(\d+)/.exec(meta.instanceId || '')
  const tag = num ? `#${num[1]}` : `#${shortHash(meta.instanceId || meta.worldId)}`
  return `${meta.access} ${tag}`.trim()
}

/** 对应上游 format_location：好友卡片上的「世界名 · 房间」文案 */
export async function formatLocation(client, location) {
  const meta = parseLocation(location)
  if (!meta) return ''
  if (meta.special) return meta.special

  const worldName = await getWorldName(client, meta.worldId)
  let ret = `${meta.access} |`
  if (meta.region) ret = `${ret} ${meta.region} |`
  return `${ret}\n${worldName}`
}

/**
 * 好友列表分组用：世界名 + 房间标签 + 卡片上那两行位置文案
 * @returns {{worldId:string, worldName:string, roomLabel:string, region:string|null, text:string}|null}
 */
export async function describeLocation(client, location) {
  const meta = parseLocation(location)
  if (!meta) return null
  if (meta.special) {
    return { worldId: '', worldName: meta.special, roomLabel: meta.special, region: null, text: meta.special }
  }
  const worldName = await getWorldName(client, meta.worldId)
  let text = `${meta.access} |`
  if (meta.region) text = `${text} ${meta.region} |`
  text = `${text}\n${worldName}`
  return {
    worldId: meta.worldId,
    worldName,
    roomLabel: roomLabel(meta),
    region: meta.region,
    text
  }
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
  storeCache = loadUsersStore()
  return storeCache
}

function flush() {
  const store = loadStore()
  writeQueue = writeQueue.then(
    () => saveUsersStore(store),
    () => saveUsersStore(store)
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

const TWO_FA_PREFIX = { totp: 'totp', email: 'emailOtp', otp: 'otp' }

/**
 * 解析 #vrc验证 的参数：支持 "#vrc验证 email 123456" 这种指定方式
 * @returns {{code?:string, scope?:string[], error?:'need_code'|'unsupported', prefix?:string}}
 */
export function parseTwoFactorInput(args = [], methods = []) {
  const first = String(args[0] || '').trim()
    .replace(/\s+/g, '')
  const prefix = first.toLowerCase()
  const picked = TWO_FA_PREFIX[prefix]
  if (picked) {
    if (args.length < 2) return { error: 'need_code' }
    if (!methods.includes(picked)) return { error: 'unsupported', prefix }
    const code = String(args[1] || '').trim()
    if (!code) return { error: 'need_code' }
    return { code, scope: [picked] }
  }
  return { code: first, scope: methods }
}

/**
 * 按验证码形态和服务端给出的方式，挑一个接口来提交
 * 数字 6 位 → 身份验证器 / 邮箱码；字母数字串 → 恢复码
 * 一次输入只打服务端给出的一个接口，同一个码不会被当成多次尝试
 */
export function pickTwoFactorMethod(code, methods = []) {
  // 验证器里有时显示成“123 456”，去掉内部空格再判形态
  const text = String(code).trim().replace(/\s+/g, '')
  if (/^\d{6}$/.test(text)) {
    if (methods.includes('totp')) return 'totp'
    if (methods.includes('emailOtp')) return 'emailOtp'
    // 账号只有恢复码可用时，纯数字也可能是恢复码
    if (methods.includes('otp')) return 'otp'
    return null
  }
  if (/^[A-Za-z0-9][A-Za-z0-9-]{5,19}$/.test(text) && methods.includes('otp')) return 'otp'
  return null
}

/**
 * 第二步：提交 2FA 验证码（只打一个接口）
 * @param {'totp'|'emailOtp'|'otp'} method pickTwoFactorMethod 的结果
 * @returns {{ok:boolean, user?:object, error?:string, retryLater?:boolean}}
 */
export async function submitTwoFactor(client, code, method) {
  const body = { code: String(code).trim().replace(/\s+/g, '') }
  const callers = {
    totp: () => client.verify2Fa({ body, credentials: 'include' }),
    emailOtp: () => client.verify2FaEmailCode({ body, credentials: 'include' }),
    otp: () => client.verifyRecoveryCode({ body, credentials: 'include' })
  }
  const call = callers[method]
  if (!call) return { ok: false, error: `不认识的验证方式：${method}` }

  let r
  try {
    r = await call()
  } catch (err) {
    const status = err?.response?.status
    if (status === 429) return { ok: false, error: '被 VRChat 限流了，过几分钟再试', retryLater: true }
    return { ok: false, error: `提交验证码失败：${err?.message || '网络错误'}` }
  }

  if (r?.data?.verified !== true) return { ok: false, error: '验证码错误' }

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
