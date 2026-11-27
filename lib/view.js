// HTML 生成：样式和 DOM 沿用上游模板；好友列表额外按世界 / 房间分了组
import path from 'path'
import { RES_DIR, fileUrl } from './config.js'
import { esc, DEFAULT_AVATAR, DEFAULT_WORLD_IMAGE } from './utils.js'
import { statusDescMap, platformDesc, words } from './i18n.js'

export const STATUS_COLORS = {
  online: '#51e57e',
  webonline: '#51e57e',
  joinme: '#42caff',
  busy: '#5b0b0b',
  askme: '#e88134',
  offline: 'gray',
  unknown: 'gray'
}

export const TRUST_COLORS = {
  visitor: '#cccccc',
  new: '#1778ff',
  user: '#2bcf5c',
  known: '#ff7b42',
  trusted: '#8143e6',
  friend: '#ffff00',
  developer: '#b52626',
  moderator: '#b52626'
}

/** 分组展示顺序（上游按 STATUS_DESC_MAP 的键序分组） */
export const STATUS_ORDER = ['online', 'joinme', 'busy', 'askme', 'webonline', 'offline', 'unknown']

const TRUST_KEY_ORDER = Object.keys(TRUST_COLORS)

function css(name) {
  return fileUrl(path.join(RES_DIR, name))
}

function head(title, cssName) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${css(cssName)}">
</head>`
}

function avatarOf(url) {
  return url ? esc(url) : DEFAULT_AVATAR
}

/** 状态的中文文案（供搜索结果图等复用） */
export function statusDescOf(status) {
  return statusDescMap[status] || ''
}

/* ---------------- 好友列表 ---------------- */

/**
 * @param {{kind:'world'|'status', status?:string, worldName?:string, roomLabel?:string, roomUserCount?:number|null, friends:Array}[]} sections
 * @param {string} title
 */
/** 好友列表汇总：可见世界与「位置未公开」分开报，不替 API 猜 */
export function friendSummary(sections) {
  const sum = list => list.reduce((n, s) => n + s.friends.length, 0)
  const onlineCount = sum(
    sections.filter(s => s.kind === 'world' || s.kind === 'hidden' || s.status !== 'offline')
  )
  const offlineCount = sum(
    sections.filter(s => s.kind !== 'world' && s.kind !== 'hidden' && (s.status === 'offline' || s.status === 'unknown'))
  )
  const worldCount = new Set(sections.filter(s => s.kind === 'world').map(s => s.worldId || s.worldName)).size
  const roomCount = sections.filter(s => s.kind === 'world').length
  const hiddenCount = sum(sections.filter(s => s.kind === 'hidden'))

  const parts = [`在线 ${onlineCount} 人`]
  if (worldCount) {
    const rooms = roomCount > worldCount ? `（${roomCount} 个房间）` : ''
    parts.push(`${hiddenCount ? '可见' : '分布在'} ${worldCount} 个世界${rooms}`)
  }
  if (hiddenCount) {
    parts.push(hiddenCount === onlineCount ? '位置均未公开' : `${hiddenCount} 人位置未公开`)
  }
  if (offlineCount) parts.push(`离线 ${offlineCount} 人`)
  return parts.join(' · ')
}

export function renderFriendList(sections, title = words.friend_list) {
  const body = sections
    .map(section => {
      const isWorld = section.kind === 'world'
      const isHidden = section.kind === 'hidden'
      const color = isWorld
        ? STATUS_COLORS.online
        : isHidden
          ? '#FAAD14'
          : STATUS_COLORS[section.status] || '#666'
      const label = isWorld
        ? section.worldName
        : isHidden
          ? section.label
          : statusDescMap[section.status] || section.status
      // 世界分组里世界名和房间都在标题上写了，卡片就不重复一遍
      const cards = section.friends.map(f => friendCard(f, { hideLocation: isWorld || isHidden })).join('\n')
      const roomLine = isWorld
        ? [
            section.roomLabel,
            section.region,
            typeof section.roomUserCount === 'number'
              ? `房间 ${section.roomUserCount} 人`
              : '房间人数未知'
          ].filter(Boolean).join(' · ')
        : ''
      const sub = isWorld
        ? `<div class="world-room">${esc(roomLine)}</div>`
        : isHidden
          ? `<div class="world-room">${esc(section.hint)}</div>`
          : ''
      const classes = `status-indicator${isWorld ? ' is-world' : ''}${isHidden ? ' is-hidden' : ''}`
      return `<div class="friend-section">
  <div class="section-header">
    <div class="${classes}">
      <span class="status-dot" style="background-color: ${color};"></span>
      <span class="status-label">${esc(label)}</span>
      <span class="friend-counter">${section.friends.length}</span>
    </div>
    ${sub}
  </div>
  <div class="friends-grid">
    ${cards}
  </div>
</div>`
    })
    .join('\n')

  const summary = friendSummary(sections)

  return `${head('VR好友列表', 'friend_list.css')}
<body>
<div class="vr-container">
  <div class="vr-header">
    <h1 class="vr-title">VRChat ${esc(title)}</h1>
    <div class="vr-subtitle">${esc(summary)}</div>
  </div>
  ${body}
  <div class="vr-footer">
    <div class="system-status">
      <span class="system-name">From VRChat API &amp; Yunzai</span>
      <span class="system-indicator">@Agnes Digital</span>
    </div>
  </div>
</div>
</body>
</html>`
}

function friendCard(f, opt = {}) {
  const trust = TRUST_COLORS[f.trust] ? f.trust : 'visitor'
  const color = TRUST_COLORS[trust]
  const badge = f.statusDescription || statusDescMap[f.normalizedStatus] || '未知状态'
  const locationLine = opt.hideLocation
    ? ''
    : `<div class="location-line">
        <span class="location-icon">🌐</span>
        <span class="location-text">${esc(f.locationText || '未知位置').replace(/\n/g, '<br>')}</span>
      </div>`
  return `<div class="friend-card" data-trust="${esc(trust)}">
  <div class="card-inner">
    <div class="avatar-section">
      <div class="avatar-frame" style="border-color: ${color};">
        <img class="avatar-img" src="${avatarOf(f.avatar)}" alt="${esc(f.displayName)}的头像"
             onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';">
        <div class="avatar-glow" style="box-shadow: 0 0 20px ${color}40;"></div>
      </div>
    </div>
    <div class="info-section">
      <div class="user-id">
        <span class="index-number">${f.index}.</span>
        <span class="username">${esc(f.displayName || '未知用户')}</span>
      </div>
      <div class="status-line">
        <span class="status-badge">${esc(badge)}</span>
      </div>
      ${locationLine}
    </div>
  </div>
</div>`
}

/**
 * 好友分桶：在线（有位置的）按「世界 + 房间实例」分组，
 * 同一个世界不同房间单独一组；世界不可见的（私有世界 / 加载中）单独收，
 * 网页在线这类没位置的仍按状态分组；离线放最后
 */
export function groupFriends(friends) {
  const worlds = new Map()
  const hidden = new Map()
  const statusBuckets = new Map()
  const offline = []

  for (const f of friends) {
    let status = f.normalizedStatus
    if (status === 'unknown' && f.originalStatus === 'offline') status = 'offline'
    if (status === 'offline' || status === 'unknown') {
      offline.push(f)
      continue
    }
    if (f.worldId) {
      const key = f.location || f.worldId
      if (!worlds.has(key)) {
        worlds.set(key, {
          kind: 'world',
          key,
          worldId: f.worldId,
          worldName: f.worldName || '未知世界',
          roomLabel: f.roomLabel || '',
          region: f.region || null,
          roomUserCount: typeof f.roomUserCount === 'number' ? f.roomUserCount : null,
          friends: []
        })
      }
      worlds.get(key).friends.push(f)
      continue
    }
    if (status !== 'webonline') {
      const label = hiddenLabelOf(f)
      if (!hidden.has(label)) {
        hidden.set(label, {
          kind: 'hidden',
          key: label,
          label,
          hint: hiddenHintOf(f),
          friends: []
        })
      }
      hidden.get(label).friends.push(f)
      continue
    }
    if (!statusBuckets.has(status)) statusBuckets.set(status, [])
    statusBuckets.get(status).push(f)
  }

  const sortByTrust = list =>
    list.sort((a, b) => TRUST_KEY_ORDER.indexOf(b.trust) - TRUST_KEY_ORDER.indexOf(a.trust))
  const out = []
  for (const bucket of worlds.values()) {
    sortByTrust(bucket.friends)
    out.push(bucket)
  }
  // 人多的世界排前面，人数一样按世界名
  out.sort((a, b) => b.friends.length - a.friends.length || a.worldName.localeCompare(b.worldName))
  // 位置不可见的分组排在可见世界之后，按人数和名称
  const hiddenGroups = [...hidden.values()]
  for (const bucket of hiddenGroups) sortByTrust(bucket.friends)
  hiddenGroups.sort(
    (a, b) =>
      b.friends.length - a.friends.length ||
      HIDDEN_ORDER.indexOf(a.label) - HIDDEN_ORDER.indexOf(b.label)
  )
  out.push(...hiddenGroups)
  for (const status of STATUS_ORDER) {
    const list = statusBuckets.get(status)
    if (!list || !list.length) continue
    sortByTrust(list)
    out.push({ kind: 'status', status, friends: list })
  }
  if (offline.length) {
    sortByTrust(offline)
    out.push({ kind: 'status', status: 'offline', friends: offline })
  }
  return out
}

/** 没有 worldId 的在线好友，按实际能看到的信息给个组名 */
const HIDDEN_ORDER = ['私有世界', '切换世界中', '位置获取失败', '位置未公开']

function hiddenLabelOf(f) {
  if (f.location === 'traveling') return '切换世界中'
  if (f.location === 'private') return '私有世界'
  if (f.locationText === '获取失败') return '位置获取失败'
  return '位置未公开'
}

/** 组名下面那行小字，解释为什么这里没有世界名 */
function hiddenHintOf(f) {
  if (f.location === 'traveling') return '正在加载世界'
  if (f.location === 'private') return '具体世界不可见'
  if (f.locationText === '获取失败') return '世界信息没取到'
  return '具体世界未知'
}

/* ---------------- 个人资料卡 ---------------- */

export function renderPlayer(user, opt = {}) {
  const trust = TRUST_COLORS[user.trust] ? user.trust : 'visitor'
  const color = TRUST_COLORS[trust]
  const statusText = user.statusDesc || user.statusDescription || statusDescMap[user.normalizedStatus] || user.originalStatus || ''
  const bio = user.bio
    ? `<div class="bio-title">签名</div>
        <div class="bio">${esc(user.bio)}</div>`
    : ''

  // 看自己时「是好友吗」没有意义，换成账号 ID
  const friendRow = opt.self
    ? `<li><span>账号 ID</span><span>${esc(user.userId || '')}</span></li>`
    : `<li><span>是好友吗</span><span>${user.isFriend ? '是' : '不是'}</span></li>`

  return `${head(`${esc(user.displayName)} 的个人信息`, 'player.css')}
<body>
  <div class="profile-card">
    <div class="avatar-wrap" style="border: 4px solid ${color};">
      <img class="avatar" src="${avatarOf(user.avatar)}" alt="${esc(user.displayName)}的头像"
           onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';">
    </div>
    <div class="main-info">
      <div class="name">${esc(user.displayName)}</div>
      <div class="status">${esc(statusText).replace(/\n/g, '<br>')}</div>
    </div>
    <ul class="desc-list">
      <li><span>游戏版本</span><span>${esc(platformDesc[user.lastPlatform] || user.lastPlatform || '未知')}</span></li>
      <li><span>信任等级</span><span>${esc(user.trust)}<span class="trust-dot" style="background-color:${color};"></span></span></li>
      <li><span>18+认证</span><span>${user.ageVerified ? '已认证' : '未认证'}</span></li>
      <li><span>加入时间</span><span>${esc(user.dateJoined)}</span></li>
      ${friendRow}
    </ul>
    ${bio}
  </div>
</body>
</html>`
}

/* ---------------- 世界 ---------------- */

function worldField(world) {
  return {
    name: world.name || '未知世界',
    author: world.authorName || world.author_name || '未知',
    thumb: world.thumbnailImageUrl || world.thumbnail_image_url || DEFAULT_WORLD_IMAGE,
    description: world.description || '',
    capacity: world.capacity ?? 0,
    occupants: world.occupants ?? 0,
    favorites: world.favorites ?? 0,
    visits: world.visits ?? 0,
    heat: world.heat ?? 0,
    popularity: world.popularity ?? 0,
    releaseStatus: world.releaseStatus || world.release_status || 'unknown',
    version: world.version ?? 0,
    createdAt: world.created_at || world.createdAt,
    updatedAt: world.updated_at || world.updatedAt,
    tags: Array.isArray(world.tags) ? world.tags : [],
    platforms: Array.isArray(world.unityPackages || world.unity_packages)
      ? [...new Set((world.unityPackages || world.unity_packages).map(p => p.platform).filter(Boolean))]
      : [],
    previewYoutubeId: world.previewYoutubeId || world.preview_youtube_id || null
  }
}

function tagChips(tags) {
  const filtered = tags.filter(t => !t.startsWith('system_') && !t.startsWith('admin_'))
  const seen = new Set()
  const list = []
  for (const t of filtered) {
    const name = String(t).replace('author_tag_', '')
    if (seen.has(name)) continue
    seen.add(name)
    list.push(name)
  }
  if (!list.length) return '<span class="tag">无</span>'
  return list.map(t => `<span class="tag">${esc(t)}</span>`).join('\n')
}

function platformChips(list) {
  if (!list.length) return '<span class="platform">无</span>'
  return list.map(p => `<span class="platform">${esc(p)}</span>`).join('\n')
}

export function renderWorldInfo(world) {
  const w = worldField(world)
  const yt = w.previewYoutubeId
    ? `<div class="world-preview">
        <span class="preview-label">预览视频:</span>
        <a href="https://www.youtube.com/watch?v=${esc(w.previewYoutubeId)}" target="_blank" class="youtube-link">观看 YouTube 预览</a>
      </div>`
    : ''

  return `${head('世界信息', 'world_info.css')}
<body>
  <div class="world-card">
    <div class="world-header">
      <img src="${esc(w.thumb)}" alt="${esc(w.name)}" class="world-thumbnail"
           onerror="this.onerror=null;this.src='${DEFAULT_WORLD_IMAGE}';">
      <div class="world-title-section">
        <h1>${esc(w.name)}</h1>
        <span class="author">by ${esc(w.author)}</span>
      </div>
    </div>
    <div class="world-description">${esc(w.description)}</div>
    <div class="world-stats">
      <div class="stat-item"><span class="stat-label">容量</span><span class="stat-value">${w.capacity}人</span></div>
      <div class="stat-item"><span class="stat-label">当前人数</span><span class="stat-value">${w.occupants}人</span></div>
      <div class="stat-item"><span class="stat-label">收藏数</span><span class="stat-value">${w.favorites}</span></div>
      <div class="stat-item"><span class="stat-label">访问量</span><span class="stat-value">${w.visits}</span></div>
      <div class="stat-item"><span class="stat-label">热度</span><span class="stat-value">${w.heat}</span></div>
      <div class="stat-item"><span class="stat-label">人气</span><span class="stat-value">${w.popularity}</span></div>
    </div>
    <div class="world-meta">
      <div class="meta-row"><span class="meta-label">创建时间:</span><span class="meta-value">${esc(formatDate(w.createdAt))}</span></div>
      <div class="meta-row"><span class="meta-label">更新于:</span><span class="meta-value">${esc(formatDate(w.updatedAt))}</span></div>
      <div class="meta-row"><span class="meta-label">发布状态:</span><span class="meta-value">${esc(w.releaseStatus)}</span></div>
      <div class="meta-row"><span class="meta-label">版本:</span><span class="meta-value">${esc(w.version)}</span></div>
    </div>
    <div class="world-tags">
      <span class="tag-label">标签:</span>
      <div class="tags">${tagChips(w.tags)}</div>
    </div>
    <div class="world-platforms">
      <span class="platform-label">支持平台:</span>
      <div class="platforms">${platformChips(w.platforms)}</div>
    </div>
    ${yt}
  </div>
</body>
</html>`
}

export function renderWorldList(worlds, opt = {}) {
  const cards = worlds
    .map((world, i) => {
      const w = worldField(world)
      const divider = (i + 1) % 2 === 0 ? '<div class="world-divider"></div>' : ''
      return `<div class="world-card">
  <div class="world-header">
    <img src="${esc(w.thumb)}" alt="${esc(w.name)}" class="world-thumbnail"
         onerror="this.onerror=null;this.src='${DEFAULT_WORLD_IMAGE}';">
    <h2>${i + 1}. ${esc(w.name)}</h2>
  </div>
  <div class="world-details">
    <div class="detail-row"><span class="detail-label">作者:</span><span class="detail-value">${esc(w.author)}</span></div>
    <div class="detail-row"><span class="detail-label">创建时间:</span><span class="detail-value">${esc(formatDate(w.createdAt))}</span></div>
    <div class="detail-row"><span class="detail-label">更新于:</span><span class="detail-value">${esc(formatDate(w.updatedAt))}</span></div>
    <div class="detail-row"><span class="detail-label">容量:</span><span class="detail-value">${w.capacity}人</span></div>
    <div class="detail-row"><span class="detail-label">当前人数:</span><span class="detail-value">${w.occupants}人</span></div>
    <div class="detail-row"><span class="detail-label">收藏数:</span><span class="detail-value">${w.favorites}</span></div>
    <div class="detail-row"><span class="detail-label">标签:</span><span class="detail-value tags">${tagChips(w.tags)}</span></div>
    <div class="detail-row"><span class="detail-label">支持平台:</span><span class="detail-value platforms">${platformChips(w.platforms)}</span></div>
  </div>
</div>
${divider}`
    })
    .join('\n')

  return `${head('世界列表', 'world_list.css')}
<body>
  <h1>VRChat世界列表</h1>
  <div class="world-list-container">
    ${cards}
  </div>
  <div class="total-results" style="position: static;">本页 ${worlds.length} 个世界${opt.page ? ` · ${esc(pageLabel(opt.page, opt.hasMore))}` : ''}</div>
</body>
</html>`
}

/* ---------------- 通知 ---------------- */

const NOTIFY_META = {
  friendRequest: { cls: 'friend-request', icon: '👥', title: '好友请求' },
  invite: { cls: 'invite', icon: '🎫', title: '世界邀请' },
  votetokick: { cls: 'votetokick', icon: '🚫', title: '投票踢人' },
  message: { cls: 'message', icon: '💬', title: '新消息' },
  inviteResponse: { cls: 'inviteResponse', icon: '↩', title: '邀请已接受' },
  requestInvite: { cls: 'requestInvite', icon: '☝', title: '邀请请求' }
}

export function renderNotify(notifications) {
  const cards = notifications
    .map(n => {
      const meta = NOTIFY_META[n.type] || { cls: 'message', icon: '🔔', title: n.type || '通知' }
      const actions =
        n.type === 'friendRequest'
          ? `<div class="actions">
        <button class="btn btn-accept">✅ 接受${n.index}</button>
        <button class="btn btn-ignore">🙈 忽略${n.index}</button>
        <button class="btn btn-reject">🗑 删除${n.index}</button>
      </div>`
          : ''
      const msg = n.message
        ? `<div class="notification-message">${
            n.type === 'friendRequest'
              ? `<p>请求添加您为好友</p><p class="notification-details"><span class="detail-title">附言：</span>${esc(n.message)}</p>`
              : esc(n.message)
          }</div>`
        : n.type === 'friendRequest'
          ? '<div class="notification-message"><p>请求添加您为好友</p></div>'
          : ''

      return `<div class="notification-card ${meta.cls}">
  <div class="notification-header">
    <div class="notification-title">${meta.icon} ${esc(meta.title)}</div>
    <div class="notification-time">${esc(n.td)}</div>
  </div>
  <div class="notification-content">
    <div class="sender-info">
      <div class="avatar-frame">
        <img class="avatar-img" src="${avatarOf(n.avatar)}" alt="用户头像"
             onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';">
      </div>
      <div class="sender-details"><span class="sender-name">${esc(n.name || '')}</span></div>
    </div>
    ${msg}
    ${actions}
  </div>
</div>`
    })
    .join('\n')

  return `${head('VRChat通知信息', 'ntf.css')}
<body>
<div class="vr-container">
  <div class="vr-header">
    <h1 class="vr-title">VRChat</h1>
    <div class="vr-subtitle">个人通知</div>
  </div>
  <div class="notification-section">
    <div class="section-header">
      <div class="status-indicator">
        <span class="status-dot friend"></span>
        <span class="status-label">通知列表</span>
      </div>
      <div class="notification-counter">${notifications.length} 条通知</div>
    </div>
    <div class="notifications-grid">
      ${cards || '<div class="empty-grid-item"><div class="empty-message"><div class="empty-icon">🔔</div><div class="empty-text">暂无通知</div></div></div>'}
    </div>
  </div>
  <div class="vr-footer">
    <div class="system-status">
      <span class="system-name">From VRChat API &amp; Yunzai</span>
      <span class="system-indicator">@Agnes Digital</span>
    </div>
  </div>
</div>
</body>
</html>`
}

/* ---------------- 搜索结果 / 通用用户列表图（对应上游 friend_list_default） ---------------- */

export function renderUserList(entries, title = '搜索结果', opt = {}) {
  const rows = entries
    .map(
      f => `<div class="friend-item">
      <div class="avatar-border" style="border-color: ${TRUST_COLORS[f.trust] || '#ccc'};">
        <img class="avatar" src="${avatarOf(f.avatar)}" alt="${esc(f.displayName)}的头像"
             onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';">
      </div>
      <div class="info">
        <div class="index-name">${f.index}. ${esc(f.displayName || '未知用户')}</div>
        <div class="status">${esc(f.statusText || '').replace(/\n/g, ' ')}</div>
        ${f.locationText ? `<div class="location">${esc(f.locationText).replace(/\n/g, ' ')}</div>` : ''}
      </div>
    </div>`
    )
    .join('\n')

  return `${head(title, 'friend_list_default.css')}
<body>
  <div class="friend-list-card">
    <h2>${esc(title)}</h2>
    <div class="friend-group">
      <div class="group-title" style="font-size:14px;color:#b0b8c7;margin-bottom:14px;letter-spacing:1px;">本页 ${entries.length} 位${opt.page ? ` · ${esc(pageLabel(opt.page, opt.hasMore))}` : ''}</div>
      <div class="friend-list two-cols">
        ${rows}
      </div>
    </div>
  </div>
</body>
</html>`
}

/* ---------------- 收藏列表 ---------------- */

export function renderFavoriteList(sections, type = 'world', opt = {}) {
  let counter = Number(opt.startIndex) || 0
  const total = opt.total ?? sections.reduce((sum, s) => sum + (s.total ?? s.entries.length), 0)
  const typeLabel = type === 'avatar' ? '模型' : type === 'friend' ? '好友' : '世界'

  const groups = sections
    .map(s => {
      const visible = s.shown || s.entries
      const items = visible
        .map(it => {
          counter += 1
          const fallback = type === 'avatar' ? DEFAULT_AVATAR : DEFAULT_WORLD_IMAGE
          const tags = (it.tags || [])
            .map(t => `<span class="fav-tag">${esc(t)}</span>`)
            .join('')
          return `<div class="fav-item${it.missing ? ' dim' : ''}">
      <img class="fav-thumb" src="${esc(it.thumb || fallback)}" alt="${esc(it.name)}"
           onerror="this.onerror=null;this.src='${fallback}';">
      <div class="fav-meta">
        <div class="fav-name">${counter}. ${esc(it.name)}${it.missing ? '（不可用）' : ''}</div>
        <div class="fav-author">${esc(it.author || '未知作者')}</div>
        ${tags}
      </div>
    </div>`
        })
        .join('\n')

      const idPart =
        s.name && s.title && s.name !== s.title ? `<span class="fav-group-id">${esc(s.name)}</span>` : ''
      const morePart = s.more ? `<div class="fav-more">还有 ${s.more} 项未展示</div>` : ''
      return `<div class="fav-group">
    <div class="fav-group-head">
      <div class="fav-group-name">${esc(s.title || s.name)}${idPart}</div>
      <div class="fav-group-count">${s.total ?? s.entries.length} 项</div>
    </div>
    <div class="fav-items">
      ${items}
    </div>
    ${morePart}
  </div>`
    })
    .join('\n')

  return `${head(`收藏列表 · ${typeLabel}`, 'favorite_list.css')}
<body>
  <div class="fav-card">
    <h2>收藏列表 · ${typeLabel}</h2>
    <div class="fav-sum">本页 ${sections.length} 个组 / 共 ${total} 项${opt.page ? ` · 第 ${opt.page} / ${opt.totalPages} 页` : ''}</div>
    ${groups}
  </div>
</body>
</html>`
}

/* ---------------- 帮助图 ---------------- */

export function renderHelp(columns, version = '') {
  const colHtml = columns
    .map(
      groups => `<div class="help-col">
    ${groups
      .map(
        g => `<div class="help-group">
      <div class="help-group-title">${esc(g.title)}<span class="help-group-count">${g.items.length}</span></div>
      ${g.items
        .map(
          it => `<div class="help-row">
        <div class="help-cmd">${esc(it.cmd)}</div>
        <div class="help-desc">${esc(it.desc)}</div>
      </div>`
        )
        .join('\n')}
    </div>`
      )
      .join('\n')}
  </div>`
    )
    .join('\n')

  return `${head('VRChat 插件帮助菜单', 'help.css')}
<body>
<div class="vr-container">
  <div class="vr-header">
    <h1 class="vr-title">VRChat 插件帮助菜单</h1>
    ${version ? `<div class="vr-subtitle"><span class="help-version">v${esc(version)}</span></div>` : ''}
  </div>
  <div class="help-cols">
    ${colHtml}
  </div>
  <div class="help-tip">#vrc登录 必须私聊发送；群里只发 #vrc帮助</div>
  <div class="help-disclaimer">
    <div class="dis-title">免责声明</div>
    <div class="dis-body">
      登录必须私聊：群聊里发的登录请求不会被处理。<br>
      如果不小心发到了群里，登录成功后请立刻撤回那条消息。<br>
      登录状态仅保存在机器人本地，不会发送给任何第三方。<br>
      本插件仅提供 VRChat 查询及相关内容服务，账号被封禁、被盗等处罚与我方无关。
    </div>
  </div>
  <div class="vr-footer">
    <div class="system-status">
      <span class="system-name">移植自 nonebot_plugin_vrchat (by Agnes4m)</span>
      <span class="system-indicator">@Agnes Digital</span>
    </div>
  </div>
</div>
</body>
</html>`
}

/* ---------------- 小工具 ---------------- */

/** 页码文案：VRChat 搜索接口不返回总数，翻到最后一页才知道一共几页 */
function pageLabel(page = 1, hasMore = false) {
  if (!hasMore) return page > 1 ? `第 ${page} / ${page} 页` : '共 1 页'
  return `第 ${page} 页`
}

function formatDate(value) {
  if (!value) return '未知'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
