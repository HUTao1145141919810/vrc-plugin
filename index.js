// VRChat 插件 · 云崽版
// 移植自 nonebot_plugin_vrchat (https://github.com/Agnes4m/nonebot_plugin_vrchat, MIT)
// 指令：帮助图 #vrc帮助，其余子指令 #vrc xxxx
import plugin from '../../lib/plugins/plugin.js'
import { segment } from 'oicq'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { config, PLUGIN_DIR } from './lib/config.js'
import { renderHtml } from './lib/render.js'
import { fetchImage } from './lib/proxy.js'
import * as V from './lib/vrchat.js'
import * as VIEW from './lib/view.js'
import { DISCLAIMER, words, general, login as T_LOGIN, friend as T_FRIEND, user as T_USER, world as T_WORLD, notif as T_NOTIF, favorite as T_FAV } from './lib/i18n.js'
import { DEFAULT_AVATAR } from './lib/utils.js'

/* 2FA 待验证状态（仅内存，按 QQ 隔离） */
const pending2fa = new Map()

/* 验证方式的中文提示，跟 vrchat.js 的 pickTwoFactorMethod 对应 */
const TWO_FA_HINT = {
  totp: '6位数字（身份验证器）',
  emailOtp: '6位数字（邮箱收到的验证码）',
  otp: '恢复码（字母数字串）'
}

/* git 调用（#vrc更新 用）：execFile 传数组，不经过 shell，避免命令注入 */
const execFileP = promisify(execFile)

function firstLine(err) {
  const s = String(err?.stderr || err?.message || err || '').trim()
  return s.split('\n').filter(Boolean).slice(0, 2).join(' / ').slice(0, 200)
}

/* ---------------- 指令表（长词优先） ---------------- */

const CMD_MAP = [
  ['强制更新', 'forceupdate'],
  ['更新', 'update'],
  ['退出登录', 'logout'],
  ['收藏组列表', 'favgroups'],
  ['收藏列表', 'favlist'],
  ['搜索用户', 'searchuser'],
  ['搜索世界', 'searchworld'],
  ['全部好友', 'friends'],
  ['好友列表', 'friends'],
  ['显示通知', 'notify'],
  ['好友状态', 'friendstatus'],
  ['加好友', 'addfriend'],
  ['收藏世界', 'favworld'],
  ['我的信息', 'me'],
  ['帮助图', 'help'],
  ['查询用户', 'searchuser'],
  ['查询世界', 'searchworld'],
  ['验证码', 'verify'],
  ['帮助', 'help'],
  ['结果', 'result'],
  ['登录', 'login'],
  ['验证', 'verify'],
  ['通知', 'notify'],
  ['好友', 'friends'],
  ['用户', 'user'],
  ['世界', 'world'],
  ['退出', 'logout']
].sort((a, b) => b[0].length - a[0].length)

const ACTION_RE = /^(接受|忽略|拒绝)\s*(\d{1,3})$/

/* 指令词后面能接什么：页码、序号、带空格参数，或直接结束 */
const ARG_TAIL = {
  result: /^\s|^\d|^[Pp]|^第/,
  verify: /^\s|^\d|^(?:email|totp|otp)\b/i,
  favlist: /^\s|^(?:avatar|world)\b/i
}

/* 入口只放行已知指令词，普通聊天里的 vrc 不触发 */
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const TRIGGER_HEADS = [...new Set([
  ...CMD_MAP.map(([zh]) => zh),
  '接受', '忽略', '拒绝'
])].map(escRe)
const VRC_TRIGGER = new RegExp(`^#?vrc\\s*(?:${TRIGGER_HEADS.join('|')})`, 'i')

/* ---------------- 序号缓存（按 QQ + 类型隔离，互不覆盖） ---------------- */

const searchStore = new Map() // qq -> { [kind]: { items, at } }
const CACHE_TTL = 10 * 60 * 1000

function cacheSet(qq, kind, items) {
  const key = String(qq)
  const bucket = searchStore.get(key) || {}
  bucket[kind] = { items, at: Date.now() }
  searchStore.set(key, bucket)
}

function cacheGet(qq, kind) {
  const hit = searchStore.get(String(qq))?.[kind]
  if (!hit || Date.now() - hit.at > CACHE_TTL) return null
  return hit.items
}

/** 在多个类型里取最近写入的那一份（「我刚看的列表」优先） */
function cacheGetLatest(qq, kinds) {
  const bucket = searchStore.get(String(qq))
  if (!bucket) return null
  let best = null
  for (const kind of kinds) {
    const hit = bucket[kind]
    if (!hit || Date.now() - hit.at > CACHE_TTL) continue
    if (!best || hit.at > best.at) best = { kind, items: hit.items, at: hit.at }
  }
  return best
}

/* ---------------- 分页 ---------------- */

const PAGE_SIZE = { user: 10, world: 20, fav: 24 }

/** "#vrc结果 P2" / "p2" / "2" / "第2页" → 2；认不出来给 0 */
function parsePageArg(text) {
  const m = /^(?:[pP]|第)?\s*(\d{1,3})\s*页?$/.exec(String(text || '').trim())
  return m ? Number(m[1]) : 0
}

/** 记一份「当前可翻页的列表」，供 #vrc结果 P2 用 */
function pagerSet(qq, meta) {
  cacheSet(qq, 'pager', meta)
}

/* ---------------- 版本号 ---------------- */

function readPluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'))
    return String(pkg.version || '')
  } catch {
    return ''
  }
}

const PLUGIN_VERSION = readPluginVersion()

/** 收藏数据切页：按全局序号切，页内仍保留收藏组分块 */
function sliceFavoritePage(groups, page, per) {
  const total = groups.reduce((sum, g) => sum + g.entries.length, 0)
  const totalPages = Math.max(1, Math.ceil(total / per))
  const start = (page - 1) * per
  const end = start + per
  let cursor = 0
  const pageGroups = []
  for (const g of groups) {
    const gStart = cursor
    const gEnd = cursor + g.entries.length
    cursor = gEnd
    if (gEnd <= start || gStart >= end) continue
    pageGroups.push({
      title: g.title,
      name: g.name,
      total: g.entries.length,
      shown: g.entries.slice(Math.max(0, start - gStart), Math.min(g.entries.length, end - gStart)),
      more: 0
    })
  }
  return { total, totalPages, start, pageGroups }
}

/* ---------------- 小工具 ---------------- */

/**
 * 限并发批量执行。单项失败不拖垮整批，但会把失败项和原因记进日志
 * @param {string} label 日志里用的名字，例如“好友位置装配”
 */
async function mapLimit(list, limit, fn, label = '批量任务') {
  const out = new Array(list.length)
  let cursor = 0
  const failed = []
  const workers = Array.from({ length: Math.min(limit, list.length || 1) }, async () => {
    while (cursor < list.length) {
      const i = cursor++
      try {
        out[i] = await fn(list[i], i)
      } catch (err) {
        out[i] = null
        failed.push(`#${i} ${err?.message || err}`)
      }
    }
  })
  await Promise.all(workers)
  if (failed.length) {
    const head = failed.slice(0, 3).join(' | ')
    logger?.info?.(`[vrc-plugin] ${label}：${failed.length}/${list.length} 项失败，${head}${failed.length > 3 ? ' …' : ''}`)
  }
  return out
}

function imgSegment(file) {
  // 各分支暴露的全局 segment 可能来自 oicq / icqq，运行时优先取全局的实现，取不到再退回 import 的那个
  const seg = globalThis.segment || segment
  return seg.image(`file:///${String(file).replace(/\\/g, '/')}`)
}

function renderView(html, viewport) {
  return renderHtml(html, { width: viewport.width, quality: config.jpegQuality })
}

/** 需要登录的指令统一入口；未登录时给出提示 */
async function requireClient(e) {
  const qq = e.user_id
  const NET_ERR = /timeout|timed out|aborted|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed/i

  let client = await V.getClient(qq)
  let auth = await V.checkAuth(client)

  // 刚启动时第一次检查可能因为连接冷启动、或 cookie 还没恢复进 jar 而判成未登录，
  // 这里重建一次 client 再查，用户不用手动重发指令。
  if (!auth.ok && !auth.need2fa) {
    logger?.warn?.(`[vrc-plugin] 首次登录态检查失败（error=${auth.error || 'unknown'} status=${auth.status ?? '-'}），重建会话重试`)
    V.dropClient(qq)
    client = await V.getClient(qq)
    auth = await V.checkAuth(client)
  }

  if (!auth.ok) {
    logger?.warn?.(`[vrc-plugin] 重建会话后仍失败：error=${auth.error || 'unknown'} status=${auth.status ?? '-'}`)
    if (auth.need2fa) {
      await e.reply('该账号需要二次验证，请重新执行【#vrc登录】')
    } else if (auth.error && NET_ERR.test(auth.error)) {
      await e.reply(`连接 VRChat 失败（${auth.error}），稍后重试；如果一直这样，检查本机网络或代理`)
    } else {
      await e.reply(T_LOGIN.not_logged_in)
    }
    return null
  }
  // 校验通过后顺手刷新一次 cookie，避免长期失效
  try {
    await V.persistSession(qq, client, auth.user)
  } catch { /* noop */ }
  return { client, user: auth.user, qq }
}

/* ---------------- 好友信息装配 ---------------- */

async function buildFriendEntries(client, friends, nowMs = Date.now()) {
  let locationFailed = 0
  // 第一阶段：算位置文案（在线好友要查世界名，已做 10 分钟缓存）
  const located = await mapLimit(friends, 6, async f => {
    let locationText
    let worldId = ''
    let worldName = ''
    let roomLabel = ''
    let region = null
    if (f.normalizedStatus === 'offline' || f.normalizedStatus === 'unknown') {
      const last = f.lastLogin ? new Date(f.lastLogin).getTime() : 0
      locationText = last ? V.tdFormat(nowMs - last) : '离线'
    } else if (f.normalizedStatus === 'webonline') {
      locationText = '网页在线（没进游戏）'
    } else if (f.location && f.location !== 'offline') {
      try {
        const desc = await V.describeLocation(client, f.location)
        if (desc) {
          locationText = desc.text
          worldId = desc.worldId
          worldName = desc.worldName
          roomLabel = desc.roomLabel
          region = desc.region
        } else {
          locationText = '在线，位置未公开'
        }
      } catch (err) {
        // 位置查不出来也别把好友从列表里抹掉，标一下就行
        locationFailed++
        locationText = '获取失败'
      }
    } else {
      locationText = '在线，位置未公开'
    }
    return {
      userId: f.userId,
      displayName: f.displayName,
      avatarUrl: f.avatar,
      trust: f.trust,
      normalizedStatus: f.normalizedStatus,
      originalStatus: f.originalStatus,
      statusDescription: f.statusDesc,
      locationText,
      location: f.location,
      worldId,
      worldName,
      roomLabel,
      region
    }
  }, '好友位置装配')
  if (locationFailed) logger?.info?.(`[vrc-plugin] 好友位置：${locationFailed}/${friends.length} 条获取失败`)

  // 同一个房间只查一次人数，失败的房间按「人数未知」展示
  const uniqueRooms = [...new Set(
    located.filter(item => item.worldId && item.location).map(item => item.location)
  )]
  const roomCounts = uniqueRooms.length
    ? await mapLimit(uniqueRooms, 3, location => V.getInstanceStats(client, location), '房间人数')
    : []
  const roomCountByLocation = new Map(
    uniqueRooms.map((location, i) => [location, roomCounts[i] ?? null])
  )

  const withRoomCount = located.map(item => ({
    ...item,
    roomUserCount: roomCountByLocation.get(item.location) ?? null
  }))

  // 第二阶段：头像转 data URI（并发 8，单个 4s 超时）
  let avatarFailed = 0
  const withAvatar = config.avatarBase64
    ? await mapLimit(withRoomCount, 8, async item => {
        let avatar = DEFAULT_AVATAR
        try {
          avatar = await toDataUri(item.avatarUrl)
        } catch (err) {
          avatarFailed++
        }
        return { ...item, avatar }
      }, '好友头像转换')
    : withRoomCount.map(item => (item ? { ...item, avatar: DEFAULT_AVATAR } : null))

  if (avatarFailed) logger?.info?.(`[vrc-plugin] 好友头像：${avatarFailed}/${withRoomCount.length} 张转换失败，已用默认图`)
  return withAvatar.filter(Boolean)
}

/* ---------------- 头像 ---------------- */

const AVATAR_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://vrchat.com/',
  Accept: 'image/*'
}

const avatarCache = new Map() // url -> { dataUri, at }
const AVATAR_CACHE_TTL = 10 * 60 * 1000
const AVATAR_CACHE_MAX = 300

async function fetchAvatarOnce(url, timeoutMs) {
  // 走 lib/proxy.js：直连优先，失败按 proxyMode 决定是否经代理重试
  const { buffer, contentType } = await fetchImage(url, { headers: AVATAR_HEADERS, timeoutMs })
  if (!contentType.startsWith('image/')) throw new Error(`content-type ${contentType}`)
  if (!buffer.length) throw new Error('empty body')
  return `data:${contentType};base64,${buffer.toString('base64')}`
}

/** 头像转 data URI，带缓存；retry=true 时两次重试（6s + 12s），否则单次 6s */
async function toDataUri(url, { retry = false } = {}) {
  if (!url) return DEFAULT_AVATAR
  const hit = avatarCache.get(url)
  if (hit && Date.now() - hit.at < AVATAR_CACHE_TTL) return hit.dataUri

  let lastErr
  for (const timeout of retry ? [8000, 12000] : [8000]) {
    try {
      const dataUri = await fetchAvatarOnce(url, timeout)
      if (avatarCache.size >= AVATAR_CACHE_MAX) avatarCache.clear()
      avatarCache.set(url, { dataUri, at: Date.now() })
      return dataUri
    } catch (err) {
      lastErr = err
    }
  }
  logger?.warn?.(`[vrc-plugin] 头像获取失败 ${url} : ${lastErr?.message || lastErr}`)
  return DEFAULT_AVATAR
}

/**
 * 取某个用户的头像 data URI。
 * 完整 User 和 LimitedUser 的字段名不完全一致，这里把所有可能的来源都试一遍，
 * 任一成功就返回，避免出现「好友列表有头像、单独查用户却是占位图」的情况。
 */
async function avatarForUser(user) {
  if (!config.avatarBase64) return DEFAULT_AVATAR
  const candidates = [
    user.avatar,
    user.currentAvatarThumbnailImageUrl,
    user.current_avatar_thumbnail_image_url,
    user.currentAvatarImageUrl,
    user.current_avatar_image_url,
    user.iconUrl,
    user.profilePicOverride,
    user.thumbnailImageUrl,
    user.imageUrl
  ].filter(u => typeof u === 'string' && u)

  const tried = new Set()
  for (const url of candidates) {
    if (tried.has(url)) continue
    tried.add(url)
    // 缓存里已经是 data URI 的（比如 #vrc用户 复用了好友列表的条目）直接用
    if (url.startsWith('data:')) return url
    const dataUri = await toDataUri(url, { retry: true })
    if (dataUri !== DEFAULT_AVATAR) return dataUri
  }

  // 服务端下载全失败时，把原始 URL 交给浏览器再试一次（Chrome 会走系统代理，Node 的 fetch 不会）
  const raw = candidates[0]
  if (raw) {
    logger?.warn?.(`[vrc-plugin] 头像下载失败，回退让浏览器直接加载：${raw}`)
    return raw
  }
  return DEFAULT_AVATAR
}

/** 启动后预热一次已保存的会话：提前建好连接、把 cookie 恢复进 jar */
async function warmUpSessions() {
  const keys = V.listUserKeys()
  if (!keys.length) return
  for (const qq of keys.slice(0, 5)) {
    try {
      const client = await V.getClient(qq)
      const auth = await V.checkAuth(client)
      if (auth.ok) {
        await V.persistSession(qq, client, auth.user).catch(() => {})
        logger?.info?.('[vrc-plugin] 会话预热完成')
      } else {
        logger?.warn?.(
          `[vrc-plugin] 会话预热未通过（error=${auth.error || 'unknown'} status=${auth.status ?? '-'}），等用户下次指令再重试`
        )
      }
    } catch (err) {
      logger?.warn?.(`[vrc-plugin] 会话预热异常：${err?.message || err}`)
    }
  }
}

/* ---------------- 插件主体 ---------------- */

export class VrcPlugin extends plugin {
  constructor() {
    super({
      name: 'vrc-plugin',
      dsc: 'VRChat 好友 / 玩家 / 世界 / 通知 / 收藏查询',
      event: 'message',
      priority: 1000,
      rule: [{ reg: VRC_TRIGGER, fnc: 'main' }]
    })
    // 等启动稳定后再预热，避免和云崽自身初始化抢网络
    setTimeout(() => {
      warmUpSessions().catch(() => {})
    }, 60_000)
  }

  async main(e) {
    const raw = String(e.msg || '')
    let rest = raw.replace(/^#?vrc/i, '').trim()
    if (!rest) return false

    // 接受 / 忽略 / 拒绝 N
    const action = rest.match(ACTION_RE)
    if (action) {
      return await this.doNotificationAction(e, action[1], Number(action[2]))
    }

    let cmd = null
    let args = []
    const explicit = raw.startsWith('#') || /^vrc\s+/i.test(raw)
    for (const [zh, code] of CMD_MAP) {
      if (!rest.startsWith(zh)) continue
      const tail = rest.slice(zh.length)
      // 指令词后面必须是空白、页码/序号，或直接结束
      const tailOk = ARG_TAIL[code] || /^\s|^\d/
      if (tail && !tailOk.test(tail)) continue
      cmd = code
      args = tail.trim().split(/\s+/).filter(Boolean)
      break
    }

    if (!cmd) {
      if (!explicit) return false
      await e.reply(`未知指令「${rest.split(/\s+/)[0]}」\n发送 #vrc帮助 查看全部指令`)
      return true
    }

    try {
      switch (cmd) {
        case 'help':
          return await this.showHelp(e)
        case 'result':
          return await this.doResult(e, args)
        case 'login':
          return await this.doLogin(e, args)
        case 'verify':
          return await this.doVerify(e, args)
        case 'logout':
          return await this.doLogout(e)
        case 'update':
          return await this.doUpdate(e, false)
        case 'forceupdate':
          return await this.doUpdate(e, true)
        case 'me':
          return await this.doMe(e)
        case 'friends':
          return await this.doFriends(e)
        case 'searchuser':
          return await this.doSearchUser(e, args)
        case 'user':
          return await this.doShowUser(e, args)
        case 'searchworld':
          return await this.doSearchWorld(e, args)
        case 'world':
          return await this.doShowWorld(e, args)
        case 'notify':
          return await this.doNotify(e)
        case 'favlist':
          return await this.doFavoriteList(e, args)
        case 'favgroups':
          return await this.doFavoriteGroups(e)
        case 'addfriend':
          return await this.doAddFriend(e, args)
        case 'friendstatus':
          return await this.doFriendStatus(e, args)
        case 'favworld':
          return await this.doFavoriteWorld(e, args)
        default:
          await e.reply(`未知指令\n发送 #vrc帮助 查看全部指令`)
          return true
      }
    } catch (err) {
      logger?.error?.(`[vrc-plugin] 指令 ${cmd} 执行失败:`, err)
      await e.reply(`执行失败：${err?.message || err}\n稍后再试，或把这条发给管理员看日志`)
      return true
    }
  }

  /* ---------------- 帮助 ---------------- */

  async showHelp(e) {
    // 按使用顺序分两列：左边「自己」相关，右边「别人」相关
    const columns = [
      [
        {
          title: '账号与登录',
          items: [
            { cmd: '#vrc登录 账号 密码', desc: '必须私聊发送，别在群里发' },
            { cmd: '#vrc验证 验证码', desc: '开了 2FA 的账号补第二步验证' },
            { cmd: '#vrc退出登录', desc: '清除本机保存的登录状态' },
            { cmd: '#vrc我的信息', desc: '查看自己的资料卡' }
          ]
        },
        {
          title: '世界',
          items: [
            { cmd: '#vrc搜索世界 关键词', desc: '搜索世界，出列表图' },
            { cmd: '#vrc世界 序号', desc: '查看第 N 个世界的详情' },
            { cmd: '#vrc收藏世界 序号 [组名]', desc: '把第 N 个世界加进收藏组' }
          ]
        },
        {
          title: '收藏',
          items: [
            { cmd: '#vrc收藏列表 avatar|world', desc: '按收藏组出图，每页 24 项，加页码翻页' },
            { cmd: '#vrc收藏组列表', desc: '查看收藏组与容量' }
          ]
        }
      ],
      [
        {
          title: '好友与玩家',
          items: [
            { cmd: '#vrc全部好友', desc: '在线按世界+房间分组，标题显示房间人数' },
            { cmd: '#vrc搜索用户 关键词', desc: '搜索玩家，出结果列表图' },
            { cmd: '#vrc结果 P2', desc: '翻页，玩家 / 世界 / 收藏都能翻' },
            { cmd: '#vrc用户 序号', desc: '看第 N 个玩家的资料卡，序号按当前页算' },
            { cmd: '#vrc加好友 序号', desc: '给第 N 个玩家发好友请求' },
            { cmd: '#vrc好友状态 序号', desc: '查与第 N 个玩家的好友关系' }
          ]
        },
        {
          title: '通知与请求',
          items: [
            { cmd: '#vrc显示通知', desc: '查看通知与好友申请' },
            { cmd: '#vrc接受 序号', desc: '接受第 N 条好友申请' },
            { cmd: '#vrc忽略 / 拒绝 序号', desc: '忽略或拒绝第 N 条好友申请' }
          ]
        },
        {
          title: '插件维护',
          items: [
            { cmd: '#vrc更新', desc: '拉取仓库最新代码，仅主人可用' },
            { cmd: '#vrc强制更新', desc: '丢弃本地改动强制更新，仅主人可用' }
          ]
        }
      ]
    ]
    const file = await renderHtml(VIEW.renderHelp(columns, PLUGIN_VERSION), {
      width: config.viewport.worldList,
      quality: config.jpegQuality
    })
    await e.reply(imgSegment(file))
    return true
  }

  /* ---------------- 登录相关 ---------------- */

  async doLogin(e, args) {
    if (!args.length || args.length < 2) {
      await e.reply(`${DISCLAIMER}\n\n用法：#vrc登录 你的用户名 你的密码\n登录成功后本机会保存会话，可用 #vrc退出登录 清除。`)
      return true
    }
    if (!e.isPrivate) {
      await e.reply(
        '⚠ 这条消息里有账号密码，请立刻长按撤回。\n' +
          '群聊里发的登录请求我一律不处理，请私聊发送：#vrc登录 你的用户名 你的密码'
      )
      return true
    }

    const username = args[0]
    const password = args.slice(1).join(' ')

    await e.reply('正在登录 VRChat，请稍候…')
    const client = await V.getClient(e.user_id)
    const r = await V.loginWithPassword(client, username, password)

    // 登录完提醒撤回那条带账号密码的消息
    const RECALL_TIP = '\n\n提示：刚才那条带账号密码的消息，建议现在就撤回。'

    if (r.ok) {
      await V.persistSession(e.user_id, client, r.user)
      await e.reply(T_LOGIN.logged_in.replace('{name}', r.user.displayName || r.user.userId) + RECALL_TIP)
      return true
    }
    if (r.need2fa) {
      pending2fa.set(String(e.user_id), { at: Date.now(), methods: r.methods })
      const hints = (r.methods || []).map(m => TWO_FA_HINT[m]).filter(Boolean).join(' / ')
      const ambiguous = r.methods.includes('totp') && r.methods.includes('emailOtp')
      await e.reply(
        `该账号需要二次验证，可用方式：${hints || r.methods.join(' / ')}\n` +
        `请在 ${config.sessionTimeout} 秒内发送：#vrc验证 你的验证码` +
        (ambiguous ? '\n两种数字码走的是不同接口，请标明：#vrc验证 email 123456 或 #vrc验证 totp 123456' : '') +
        RECALL_TIP
      )
      return true
    }
    await e.reply(`${T_LOGIN.invalid_account}\n（服务端返回：${r.error}）${RECALL_TIP}`)
    return true
  }

  async doVerify(e, args) {
    let code = (args[0] || '').trim()
    if (!code) {
      await e.reply('用法：#vrc验证 你的验证码')
      return true
    }
    if (!e.isPrivate) {
      await e.reply('验证码不要在群里发送，请私聊我发送：#vrc验证 你的验证码')
      return true
    }
    const pending = pending2fa.get(String(e.user_id))
    if (!pending || Date.now() - pending.at > config.sessionTimeout * 1000) {
      await e.reply('本次登录已超时，请重新执行 #vrc登录 账号 密码')
      return true
    }

    // 可选前缀：账号同时支持身份验证器和邮箱码时，用它指定走哪个
    // #vrc验证 email 123456 / #vrc验证 totp 123456 / #vrc验证 otp 恢复码
    const parsed = V.parseTwoFactorInput(args, pending.methods)
    if (parsed.error === 'unsupported') {
      await e.reply(`这个账号不支持这种方式：${parsed.prefix}`)
      return true
    }
    if (parsed.error === 'need_code') {
      await e.reply('用法：#vrc验证 你的验证码\n同时支持多种方式时可写成 #vrc验证 email 123456 / #vrc验证 totp 123456 / #vrc验证 otp 恢复码')
      return true
    }
    code = parsed.code

    // 按服务端给出的可用方式判断验证码形态，不按固定位数卡
    const method = V.pickTwoFactorMethod(code, parsed.scope)
    if (!method) {
      const hints = parsed.scope.map(m => TWO_FA_HINT[m]).filter(Boolean)
      await e.reply(
        `${T_LOGIN.invalid_2fa_format}${hints.length ? `\n这个账号可用：${hints.join(' / ')}` : ''}`
      )
      return true
    }

    const client = await V.getClient(e.user_id)
    const r = await V.submitTwoFactor(client, code, method)
    if (r.ok) {
      pending2fa.delete(String(e.user_id))
      await V.persistSession(e.user_id, client, r.user)
      await e.reply(T_LOGIN.logged_in.replace('{name}', r.user.displayName || r.user.userId))
      return true
    }

    // 只统计“验证码错误”，限流误伤的不算次数
    if (r.error === '验证码错误') {
      pending.tries = (pending.tries || 0) + 1
      if (pending.tries >= 5) {
        pending2fa.delete(String(e.user_id))
        await e.reply(`${T_LOGIN.invalid_2fa_code}\n连续 5 次没通过，请重新执行 #vrc登录 账号 密码`)
        return true
      }
    }
    await e.reply(`${T_LOGIN.invalid_2fa_code}\n（${r.error}）`)
    return true
  }

  async doLogout(e) {
    await V.logout(e.user_id)
    pending2fa.delete(String(e.user_id))
    searchStore.delete(String(e.user_id))
    await e.reply('已清除本机保存的登录状态')
    return true
  }

  /* ---------------- 个人信息 ---------------- */

  async doMe(e) {
    const ctx = await requireClient(e)
    if (!ctx) return true
    const { client, user } = ctx

    let statusText = user.statusDesc || ''
    if (user.normalizedStatus === 'offline' || user.normalizedStatus === 'unknown') {
      const last = user.lastLogin ? new Date(user.lastLogin).getTime() : 0
      if (last) statusText = `${statusText}\n${V.tdFormat(Date.now() - last)}`.trim()
    } else if (user.normalizedStatus !== 'webonline' && user.location) {
      const loc = await V.formatLocation(client, user.location)
      statusText = `${statusText}\n${loc}`.trim()
    }

    const html = VIEW.renderPlayer(
      {
        ...user,
        statusDesc: statusText,
        avatar: await avatarForUser(user)
      },
      { self: true }
    )
    const file = await renderHtml(html, { width: config.viewport.player, quality: config.jpegQuality })
    await e.reply(imgSegment(file))
    return true
  }

  /* ---------------- 好友 ---------------- */

  async doFriends(e) {
    const ctx = await requireClient(e)
    if (!ctx) return true
    const { client } = ctx

    await e.reply('正在拉取好友列表，好友多时需要一会儿…')
    const friends = await V.fetchFriends(client, { max: config.maxFriends })
    if (!friends.length) {
      await e.reply(T_FRIEND.empty_friend_list)
      return true
    }

    const entries = await buildFriendEntries(client, friends)
    const sections = VIEW.groupFriends(entries)

    // 按「图里实际展示的顺序」统一编号，保证画面上的序号和 #vrc用户 N 一致
    const ordered = []
    for (const section of sections) {
      for (const f of section.friends) {
        f.index = ordered.length + 1
        ordered.push(f)
      }
    }
    cacheSet(e.user_id, 'friends', ordered)

    const html = VIEW.renderFriendList(sections, words.friend_list)
    const file = await renderHtml(html, { width: config.viewport.friend, quality: config.jpegQuality })
    await e.reply([
      imgSegment(file),
      `\n共 ${ordered.length} 位好友，${VIEW.friendSummary(sections)}\n发送 #vrc用户 序号 可以查看某个好友的资料卡`
    ])
    return true
  }

  /* ---------------- 搜索用户 ---------------- */

  async doSearchUser(e, args) {
    const keyword = args.join(' ').trim()
    if (!keyword) {
      await e.reply(`用法：#vrc搜索用户 关键词\n（${T_USER.send_user_name}）`)
      return true
    }
    return await this.renderUserSearch(e, keyword, 1)
  }

  /**
   * 搜索玩家并出第 page 页的图
   * 每页 10 个，多取一条用来判断后面还有没有下一页（接口本身不返回总数）
   */
  async renderUserSearch(e, keyword, page = 1) {
    const ctx = await requireClient(e)
    if (!ctx) return true
    const per = PAGE_SIZE.user

    await e.reply(page === 1 ? '正在搜索并生成结果图，请稍候…' : `正在翻到第 ${page} 页…`)

    let raw
    try {
      raw = await V.searchUsers(ctx.client, keyword, { n: per + 1, offset: (page - 1) * per })
    } catch (err) {
      await e.reply(`搜索失败：${err?.message || err}`)
      return true
    }
    const hasMore = raw.length > per
    const users = raw.slice(0, per)
    if (!users.length) {
      await e.reply(
        page > 1 ? `第 ${page} 页没有结果了，用 #vrc结果 P${page - 1} 回上一页` : T_USER.no_user_found
      )
      return true
    }

    cacheSet(e.user_id, 'user', users)
    pagerSet(e.user_id, { kind: 'user', keyword, page, hasMore })

    const nowMs = Date.now()
    const entries = await mapLimit(users, 4, async (u, i) => {
      let locationText = ''
      if (u.normalizedStatus === 'offline' || u.normalizedStatus === 'unknown') {
        const last = u.lastLogin ? new Date(u.lastLogin).getTime() : 0
        locationText = last ? V.tdFormat(nowMs - last) : ''
      } else if (u.normalizedStatus === 'webonline') {
        locationText = '网页在线'
      } else if (u.location && u.location !== 'offline') {
        try {
          locationText = await V.formatLocation(ctx.client, u.location)
        } catch (err) {
          locationText = '获取失败'
        }
      } else {
        // 搜索接口返回的是 LimitedUser，出于隐私不带 location，这一行索性不显示
        locationText = ''
      }
      let avatar = DEFAULT_AVATAR
      try {
        avatar = await avatarForUser(u)
      } catch (err) {
        logger?.info?.(`[vrc-plugin] 搜索结果头像获取失败：${err?.message || err}`)
      }
      return {
        index: i + 1,
        displayName: u.displayName,
        avatar,
        trust: u.trust,
        statusText: u.statusDesc || VIEW.statusDescOf(u.normalizedStatus) || '',
        locationText
      }
    }, '搜索结果装配')

    const list = entries.filter(Boolean)
    const html = VIEW.renderUserList(list, `搜索结果 · ${keyword}`, { page, hasMore })
    const file = await renderHtml(html, { width: 820, quality: config.jpegQuality })
    const tip = hasMore
      ? `发送 #vrc用户 序号 查看资料卡；翻页发 #vrc结果 P${page + 1}（p${page + 1} 也行）`
      : page > 1
        ? `发送 #vrc用户 序号 查看资料卡；已经是最后一页，回上一页发 #vrc结果 P${page - 1}`
        : '发送 #vrc用户 序号 查看资料卡（结果只有这一页）'
    await e.reply([imgSegment(file), `\n第 ${page} 页：${tip}`])
    return true
  }

  /* ---------------- 翻页 ---------------- */

  async doResult(e, args) {
    const page = parsePageArg(args[0])
    if (!page) {
      await e.reply('用法：#vrc结果 P2（翻到第 2 页，p2、2 都行）')
      return true
    }
    if (page > 50) {
      await e.reply('页码太大了，最多翻到第 50 页')
      return true
    }
    const meta = cacheGet(e.user_id, 'pager')
    if (!meta) {
      await e.reply('没有能翻页的列表，先发 #vrc搜索用户 关键词 / #vrc搜索世界 关键词 / #vrc收藏列表 world')
      return true
    }
    if (meta.kind === 'user') return await this.renderUserSearch(e, meta.keyword, page)
    if (meta.kind === 'world') return await this.renderWorldSearch(e, meta.keyword, page)
    if (meta.kind === 'fav') return await this.doFavoriteList(e, [meta.type, String(page)])
    await e.reply('这份列表不支持翻页')
    return true
  }

  async doShowUser(e, args) {
    const idx = Number(args[0])
    // 序号可以来自「搜索结果」也可以来自「好友列表」，取最近一次展示的那份
    const hit = cacheGetLatest(e.user_id, ['user', 'friends'])
    if (!hit) {
      await e.reply('没有可用的序号列表，请先执行 #vrc搜索用户 关键词 或 #vrc全部好友')
      return true
    }
    const list = hit.items
    if (!Number.isInteger(idx) || idx < 1 || idx > list.length) {
      await e.reply(general.invalid_ordinal_range)
      return true
    }

    const ctx = await requireClient(e)
    if (!ctx) return true

    // 用完整用户信息（搜索结果里字段不全）
    const target = list[idx - 1]
    if (!target?.userId) {
      await e.reply('这条记录缺少用户 ID，请重新执行 #vrc全部好友')
      return true
    }
    let full = target
    try {
      full = await V.getUser(ctx.client, target.userId)
    } catch { /* 用搜索结果的精简信息兜底 */ }

    let statusText = full.statusDesc || ''
    if (full.normalizedStatus === 'offline' || full.normalizedStatus === 'unknown') {
      const last = full.lastLogin ? new Date(full.lastLogin).getTime() : 0
      if (last) statusText = `${statusText}\n${V.tdFormat(Date.now() - last)}`.trim()
    } else if (full.normalizedStatus !== 'webonline' && full.location) {
      statusText = `${statusText}\n${await V.formatLocation(ctx.client, full.location)}`.trim()
    }

    const html = VIEW.renderPlayer({
      ...full,
      statusDesc: statusText,
      avatar: await avatarForUser(full)
    })
    const file = await renderHtml(html, { width: config.viewport.player, quality: config.jpegQuality })
    await e.reply(imgSegment(file))
    return true
  }

  /* ---------------- 搜索世界 ---------------- */

  async doSearchWorld(e, args) {
    const keyword = args.join(' ').trim()
    if (!keyword) {
      await e.reply(`用法：#vrc搜索世界 关键词\n（${T_WORLD.send_world_name}）`)
      return true
    }
    return await this.renderWorldSearch(e, keyword, 1)
  }

  /** 搜索世界并出第 page 页的图，每页 20 个，多取一条判断下一页 */
  async renderWorldSearch(e, keyword, page = 1) {
    const ctx = await requireClient(e)
    if (!ctx) return true
    const per = PAGE_SIZE.world

    await e.reply(page === 1 ? '正在搜索世界，请稍候…' : `正在翻到第 ${page} 页…`)
    let raw
    try {
      raw = await V.searchWorlds(ctx.client, keyword, { n: per + 1, offset: (page - 1) * per })
    } catch (err) {
      await e.reply(`搜索失败：${err?.message || err}`)
      return true
    }
    const hasMore = raw.length > per
    const worlds = raw.slice(0, per)
    if (!worlds.length) {
      await e.reply(
        page > 1 ? `第 ${page} 页没有结果了，用 #vrc结果 P${page - 1} 回上一页` : T_WORLD.no_world_found
      )
      return true
    }

    cacheSet(e.user_id, 'world', worlds)
    pagerSet(e.user_id, { kind: 'world', keyword, page, hasMore })

    const html = VIEW.renderWorldList(worlds, { page, hasMore })
    const file = await renderHtml(html, { width: config.viewport.worldList, quality: config.jpegQuality })
    const tip = hasMore
      ? `发送 #vrc世界 序号 查看详情；翻页发 #vrc结果 P${page + 1}（p${page + 1} 也行）`
      : page > 1
        ? `发送 #vrc世界 序号 查看详情；已经是最后一页，回上一页发 #vrc结果 P${page - 1}`
        : '发送 #vrc世界 序号 查看详情（结果只有这一页）'
    await e.reply([imgSegment(file), `\n第 ${page} 页：${tip}`])
    return true
  }

  async doShowWorld(e, args) {
    const idx = Number(args[0])
    const list = cacheGet(e.user_id, 'world')
    if (!list) {
      await e.reply('没有可用的搜索结果，请先执行 #vrc搜索世界 关键词')
      return true
    }
    if (!Number.isInteger(idx) || idx < 1 || idx > list.length) {
      await e.reply(general.invalid_ordinal_range)
      return true
    }
    const ctx = await requireClient(e)
    if (!ctx) return true

    const worldId = list[idx - 1].id
    const world = await V.getWorld(ctx.client, worldId)
    const html = VIEW.renderWorldInfo(world)
    const file = await renderHtml(html, { width: config.viewport.worldInfo, quality: config.jpegQuality })
    await e.reply(imgSegment(file))
    return true
  }

  /* ---------------- 通知 ---------------- */

  async doNotify(e) {
    const ctx = await requireClient(e)
    if (!ctx) return true

    const raw = await V.getNotifications(ctx.client, { n: 30 })
    // 只保留有卡片样式的类型
    const supported = raw.filter(n => ['friendRequest', 'invite', 'votetokick', 'message', 'inviteResponse', 'requestInvite'].includes(n.type))
    if (!supported.length) {
      await e.reply(raw.length ? '没有可展示的通知类型' : '当前没有通知')
      return true
    }

    const items = supported.map((n, i) => ({
      type: n.type,
      avatar: DEFAULT_AVATAR,
      td: V.tdFormat(Date.now() - new Date(n.created_at || n.createdAt || Date.now()).getTime()).slice(0, -2),
      message: n.message || '',
      name: n.senderUsername || n.senderUserId || '',
      index: i + 1
    }))

    cacheSet(e.user_id, 'notify', supported)

    const html = VIEW.renderNotify(items)
    const file = await renderHtml(html, { width: config.viewport.notify, quality: config.jpegQuality })
    await e.reply([imgSegment(file), `\n${T_NOTIF.all_notif_resp}`])
    return true
  }

  async doNotificationAction(e, verb, idx) {
    const ctx = await requireClient(e)
    if (!ctx) return true

    const list = cacheGet(e.user_id, 'notify')
    if (!list) {
      await e.reply('请先发送 #vrc显示通知 拉取通知列表')
      return true
    }
    if (!Number.isInteger(idx) || idx < 1 || idx > list.length) {
      await e.reply(general.invalid_ordinal_range)
      return true
    }

    const n = list[idx - 1]
    if (n.type !== 'friendRequest') {
      await e.reply('目前只支持处理好友申请')
      return true
    }

    try {
      if (verb === '接受') {
        await V.acceptFriendRequest(ctx.client, n.id)
        await e.reply(T_NOTIF.accept_resp)
      } else if (verb === '忽略') {
        await V.ignoreFriendRequest(ctx.client, n.id)
        await e.reply(T_NOTIF.ignore_resp)
      } else {
        await V.denyFriendRequest(ctx.client, n.id)
        await e.reply(T_NOTIF.deny_resp)
      }
    } catch (err) {
      await e.reply(`${T_NOTIF.error_handle}：${err?.message || err}`)
    }
    return true
  }

  /* ---------------- 收藏 ---------------- */

  async doFavoriteList(e, args) {
    const type = (args[0] || '').toLowerCase()
    if (!['avatar', 'world'].includes(type)) {
      await e.reply(`用法：#vrc收藏列表 avatar 或 world\n（${T_FAV.send_favorite_type}）`)
      return true
    }
    // 第二个参数是页码，也接受 #vrc结果 P2 那种写法
    const page = Math.max(1, parsePageArg(args[1]) || 1)

    const ctx = await requireClient(e)
    if (!ctx) return true

    // 收藏内容一次能全拿到，先缓存整份数据，翻页就不用反复请求
    let data = cacheGet(e.user_id, 'favData')
    if (!data || data.type !== type) {
      let groups
      try {
        groups = await V.getFavoriteGroups(ctx.client, { n: 100 })
      } catch (err) {
        await e.reply(`读取收藏组失败：${err?.message || err}`)
        return true
      }
      const typed = groups.filter(g => g.type === type)
      if (!typed.length) {
        await e.reply(T_FAV.empty_favorite_list.replace('{type}', type))
        return true
      }

      // 收藏本体只有引用 ID，名字和图要按收藏组反查，所以按组拉一次再合并
      const fetched = await Promise.all(
        typed.map(async g => {
          const base = { title: g.displayName || g.name, name: g.name }
          try {
            const entries = await V.getFavoriteGroupContents(ctx.client, type, g.name)
            return { ...base, entries }
          } catch (err) {
            return { ...base, entries: [], error: String(err?.message || err) }
          }
        })
      )
      const filled = fetched.filter(s => s.entries.length)
      if (!filled.length) {
        const firstErr = fetched.find(s => s.error)
        await e.reply(
          firstErr
            ? `读取收藏内容失败：${firstErr.error}`
            : `${T_FAV.empty_favorite_list.replace('{type}', type)}\n（你有 ${typed.length} 个${type} 收藏组，但里面都是空的）`
        )
        return true
      }
      data = { type, groups: filled }
      cacheSet(e.user_id, 'favData', data)
    }

    const per = PAGE_SIZE.fav
    const { total, totalPages, start, pageGroups } = sliceFavoritePage(data.groups, page, per)
    if (page > totalPages) {
      await e.reply(`总共就 ${totalPages} 页，用 #vrc收藏列表 ${type} ${totalPages} 看最后一页`)
      return true
    }

    // 缩略图在服务端取好（浏览器端取图会被 VRChat 的鉴权/代理卡住），失败就留空走默认图
    const sectionsWithThumb = await mapLimit(pageGroups, 2, async s => ({
      ...s,
      shown: await mapLimit(s.shown, 10, async it => {
        if (!it.thumb) return it
        try {
          const dataUri = await toDataUri(it.thumb)
          return { ...it, thumb: dataUri === DEFAULT_AVATAR ? '' : dataUri }
        } catch (err) {
          return { ...it, thumb: '' }
        }
      }, '收藏缩略图')
    }), '收藏组装配')

    pagerSet(e.user_id, { kind: 'fav', type, page })

    const file = await renderHtml(
      VIEW.renderFavoriteList(sectionsWithThumb, type, { page, totalPages, startIndex: start, total }),
      { width: config.viewport.worldList, quality: config.jpegQuality }
    )
    const pageTip =
      page < totalPages
        ? `翻页：#vrc收藏列表 ${type} ${page + 1}（#vrc结果 P${page + 1} 也行）`
        : `已经是最后一页${page > 1 ? `，回上一页：#vrc收藏列表 ${type} ${page - 1}` : ''}`
    await e.reply([
      imgSegment(file),
      `\n收藏列表（${type}）：${data.groups.length} 个组 / 共 ${total} 项 · 第 ${page} / ${totalPages} 页\n${pageTip}\n加新的世界：先 #vrc搜索世界，再 #vrc收藏世界 序号 [组名]`
    ])
    return true
  }

  async doFavoriteGroups(e) {
    const ctx = await requireClient(e)
    if (!ctx) return true

    const groups = await V.getFavoriteGroups(ctx.client, { n: 100 })
    if (!groups.length) {
      await e.reply(T_FAV.empty_favorite_groups)
      return true
    }
    const lines = groups.map(
      (g, i) => `${i + 1}. [${g.type}] ${g.name}（${g.displayName || '-'}）  ${g.visibility || ''}`
    )
    await e.reply(`${T_FAV.favorite_groups_info.replace('{count}', groups.length)}\n\n${lines.join('\n')}`)
    return true
  }

  /* ---------------- 社交动作：加好友 / 好友状态 / 收藏世界 ---------------- */

  /** 从「最近一次搜索结果 / 好友列表」里取第 N 位，取不到时已回复并返回 null */
  async resolveTargetUser(e, args, usage) {
    const idx = Number(args[0])
    if (!Number.isInteger(idx) || idx < 1) {
      await e.reply(usage)
      return null
    }
    const hit = cacheGetLatest(e.user_id, ['user', 'friends'])
    if (!hit) {
      await e.reply('没有可用的序号列表，请先执行 #vrc搜索用户 关键词 或 #vrc全部好友')
      return null
    }
    const target = hit.items[idx - 1]
    if (!target || !target.userId) {
      await e.reply(general.invalid_ordinal_range)
      return null
    }
    return target
  }

  async doAddFriend(e, args) {
    const target = await this.resolveTargetUser(
      e,
      args,
      '用法：#vrc加好友 序号\n序号来自 #vrc搜索用户 或 #vrc全部好友 的结果'
    )
    if (!target) return true

    const ctx = await requireClient(e)
    if (!ctx) return true

    const name = target.displayName || target.userId
    let st
    try {
      st = await V.getFriendStatus(ctx.client, target.userId)
    } catch (err) {
      await e.reply(`查询好友状态失败：${err?.message || err}`)
      return true
    }
    if (st.isFriend) {
      await e.reply(`${name} 已经是你的好友了`)
      return true
    }
    if (st.incomingRequest && !st.outgoingRequest) {
      await e.reply(`${name} 已经给你发了好友请求，发送 #vrc显示通知 再接受即可`)
      return true
    }
    if (st.outgoingRequest) {
      await e.reply(`已经给 ${name} 发过好友请求了，等对方通过就行`)
      return true
    }

    try {
      await V.sendFriendRequest(ctx.client, target.userId)
      await e.reply(`已向 ${name} 发送好友请求`)
    } catch (err) {
      const msg = String(err?.message || err)
      await e.reply(
        /400/.test(msg)
          ? `发送好友请求失败：对方可能已关闭好友请求，或你们已经是好友\n（${msg}）`
          : `发送好友请求失败：${msg}`
      )
    }
    return true
  }

  async doFriendStatus(e, args) {
    const target = await this.resolveTargetUser(
      e,
      args,
      '用法：#vrc好友状态 序号\n序号来自 #vrc搜索用户 或 #vrc全部好友 的结果'
    )
    if (!target) return true

    const ctx = await requireClient(e)
    if (!ctx) return true

    let st
    try {
      st = await V.getFriendStatus(ctx.client, target.userId)
    } catch (err) {
      await e.reply(`查询好友状态失败：${err?.message || err}`)
      return true
    }
    const rows = [
      `玩家：${target.displayName || target.userId}`,
      `是否好友：${st.isFriend ? '是' : '否'}`,
      `他给过你请求（待你同意）：${st.incomingRequest ? '有' : '无'}`,
      `你给过他请求（等他通过）：${st.outgoingRequest ? '有' : '无'}`
    ]
    await e.reply(rows.join('\n'))
    return true
  }

  async doFavoriteWorld(e, args) {
    const idx = Number(args[0])
    const wanted = (args[1] || '').trim()
    if (!Number.isInteger(idx) || idx < 1) {
      await e.reply(
        '用法：#vrc收藏世界 序号 [收藏组名]\n序号来自 #vrc搜索世界 的结果，组名可以用 #vrc收藏组列表 查'
      )
      return true
    }
    const list = cacheGet(e.user_id, 'world')
    if (!list) {
      await e.reply('没有可用的世界列表，请先执行 #vrc搜索世界 关键词')
      return true
    }
    const world = list[idx - 1]
    if (!world) {
      await e.reply(general.invalid_ordinal_range)
      return true
    }
    const worldId = world.id || world.worldId
    const worldName = world.name || worldId

    const ctx = await requireClient(e)
    if (!ctx) return true

    let groups
    try {
      groups = await V.getFavoriteGroups(ctx.client, { n: 100 })
    } catch (err) {
      await e.reply(`读取收藏组失败：${err?.message || err}`)
      return true
    }
    const worldGroups = groups.filter(g => g.type === 'world')
    if (!worldGroups.length) {
      await e.reply('你还没有世界收藏组，请先在 VRChat 里建一个再收藏')
      return true
    }

    let tag
    if (wanted) {
      const hit = worldGroups.find(g => g.name === wanted || g.displayName === wanted)
      if (!hit) {
        await e.reply(
          `没找到叫「${wanted}」的世界收藏组\n可用组名：${worldGroups.map(g => g.name).join(' / ')}`
        )
        return true
      }
      tag = hit.name
    } else {
      tag = worldGroups[0].name
    }

    try {
      await V.addFavorite(ctx.client, { type: 'world', favoriteId: worldId, tags: [tag] })
      await e.reply(`已把「${worldName}」加入收藏组 ${tag}`)
    } catch (err) {
      const msg = String(err?.message || err)
      await e.reply(
        /400/.test(msg)
          ? `收藏失败：组「${tag}」可能已满，或这个组不接收世界收藏\n（${msg}）`
          : `收藏失败：${msg}`
      )
    }
    return true
  }

  /* ---------------- 插件更新 ------------- */

  async doUpdate(e, force = false) {
    if (!e.isMaster) {
      await e.reply('只有主人可以更新插件')
      return true
    }

    const dir = PLUGIN_DIR
    if (!fs.existsSync(path.join(dir, '.git'))) {
      await e.reply(
        '当前不是 git 安装（目录里没有 .git），指令更新用不了。\n' +
          '办法：删掉目录后重新 git clone，或手动下载仓库最新文件覆盖（别覆盖 data/ 目录）。'
      )
      return true
    }

    const run = async (args, timeout = 90_000) =>
      await execFileP('git', args, {
        cwd: dir,
        timeout,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      })
    const short = async () => (await run(['rev-parse', '--short', 'HEAD'])).stdout.trim()

    let before = ''
    try {
      before = await short()
    } catch (err) {
      await e.reply(
        `读取 git 信息失败：${firstLine(err)}\n可能是 git 没装进 PATH，或这个目录不是完整克隆。`
      )
      return true
    }

    await e.reply(force ? '正在强制更新（本地未提交的改动会被丢弃）…' : '正在拉取更新…')

    try {
      const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
      await run(['fetch', '--all', '--prune'])

      // 不依赖 upstream 跟踪关系：先取 origin/<当前分支>，没有再用 origin/HEAD
      let remoteRef = `origin/${branch}`
      const hasRef = await run(['rev-parse', '--verify', '--quiet', remoteRef])
        .then(() => true)
        .catch(() => false)
      if (!hasRef) {
        const headRef = await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
          .then(r => r.stdout.trim())
          .catch(() => '')
        if (headRef) remoteRef = headRef
      }

      if (force) {
        await run(['reset', '--hard', remoteRef])
      } else {
        await run(['merge', '--ff-only', remoteRef])
      }
    } catch (err) {
      const msg = firstLine(err)
      const detail = String((err?.stderr || '') + (err?.stdout || '') + msg)
      const conflict = /fast-forward|diverged|would be overwritten|local changes|uncommitted/i.test(detail)
      const network = /could not resolve|connection refused|timed out|failed to connect|unable to access|rpc failed|early eof|ssl/i.test(detail)
      await e.reply(
        `更新失败：${msg}\n` +
          (conflict
            ? '本地有改动或提交比远端新。确认不需要这些改动后，再发 #vrc强制更新。'
            : network
              ? '看起来是网络问题，检查到 GitHub 的连通性（或给 git 配代理）后重试。'
              : '可以稍后重试；反复失败就把这段发给管理员看。')
      )
      return true
    }

    const after = await short().catch(() => '')
    if (!after || after === before) {
      await e.reply(`已是最新版本（${after || before}），没有可拉取的提交`)
      return true
    }

    let log = ''
    try {
      log = (await run(['log', '--oneline', '-5'])).stdout.trim()
    } catch { /* 拿不到日志不影响更新结果 */ }

    await e.reply(
      `插件已更新：${before} → ${after}\n${log ? log + '\n' : ''}\n指令和渲染相关的改动要重启云崽后才生效。`
    )
    return true
  }
}
export function clearPending(qq) {
  pending2fa.delete(String(qq))
}
