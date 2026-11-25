// 零散工具

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** HTML 转义 */
export function esc(value) {
  if (value === undefined || value === null) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 把长文本按 n 行切块 */
export function chunkLines(lines, n) {
  const out = []
  for (let i = 0; i < lines.length; i += n) out.push(lines.slice(i, i + n))
  return out
}

export function randomId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** 默认头像（内联 SVG，避免本地没有 default.png 时裂图） */
export const DEFAULT_AVATAR =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140">
      <rect width="140" height="140" fill="#16213e"/>
      <circle cx="70" cy="52" r="24" fill="#2f4a7a"/>
      <path d="M22 132c0-27 21-44 48-44s48 17 48 44z" fill="#2f4a7a"/>
    </svg>`
  )

/** 默认世界封面 */
export const DEFAULT_WORLD_IMAGE =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
      <rect width="320" height="180" fill="#16213e"/>
      <circle cx="160" cy="90" r="46" fill="none" stroke="#00ffff" stroke-width="3" opacity="0.7"/>
      <circle cx="160" cy="90" r="30" fill="none" stroke="#0080ff" stroke-width="2" opacity="0.9"/>
    </svg>`
  )
