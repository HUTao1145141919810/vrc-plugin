// 文案（对应上游 i18n/zh-CN.json）

export const words = {
  friend_list: '好友列表',
  search_list: '搜索列表',
  online: '在线',
  offline: '离线',
  joinme: '邀请我',
  busy: '忙碌',
  askme: '询问我',
  webonline: '网页版在线',
  unknown: '未知',
  standalonewindows: '标准版 Windows',
  android: '安卓',
  oculus: 'Meta Quest',
  unkown_world: '未知世界',
  travel_world: '加载世界',
  private_world: '私有世界',
  invite: '邀',
  friends: '友',
  pub: '公',
  group: '组',
  group_pub: '公组'
}

export const timeUnit = {
  year: '年',
  month: '月',
  day: '日',
  hour: '时',
  minute: '分',
  second: '秒'
}

export const statusDescMap = {
  online: words.online,
  joinme: words.joinme,
  busy: words.busy,
  askme: words.askme,
  webonline: words.webonline,
  offline: words.offline,
  unknown: words.unknown
}

export const platformDesc = {
  standalonewindows: words.standalonewindows,
  android: words.android,
  oculus: words.oculus,
  unknownplatform: words.unknown
}

export const general = {
  unknown_error: '遇到未知错误，请检查后台输出',
  server_error: '服务器返回异常：[{status}] {reason}',
  discard_select: '已取消选择',
  empty_search_keyword: '搜索关键词不能为空，请重新发送',
  empty_message: '消息不能为空，请重新发送',
  invalid_ordinal_format: '序号格式不正确，请重新发送',
  invalid_ordinal_range: '序号不在范围内，请重新发送'
}

export const login = {
  not_logged_in: '尚未登录，或登录信息失效，请发送【#vrc登录】重新登录',
  login_expired: '登录已过期，请重新登录',
  overwrite_login_info: '检测到已缓存的登录信息，本次登录成功后旧的登录信息将被覆盖',
  send_login_info:
    '请发送登录账号和密码，用空格分隔（例如：你的用户名 你的密码），发送 0 取消登录\n提示：机器人会保存你的登录状态，请在信任机器人的情况下登录',
  send_2fa_code: '请在 {second} 秒内发送收到的邮箱验证码或 2FA 验证码',
  use_cached_login_info: '检测到缓存的登录信息，尝试重新登录',
  discard_login: '已取消登录',
  invalid_account:
    '用户名或密码错误，请重新发送；如果你确认账号密码 100% 正确，请检查邮箱里是否有新地址登录验证邮件',
  invalid_info_format: '消息格式不符合规范，请重新发送账号密码，用空格分隔',
  invalid_2fa_format: '验证码格式不正确',
  invalid_2fa_code: '验证码错误，请重新发送',
  logged_in: '登录成功，欢迎，{name}'
}

export const friend = {
  empty_friend_list: '当前没有好友捏',
  empty_friend: '指定好友不存在捏',
  empty_friend_request: '当前没有好友请求捏',
  exist_friend: '你们已经是好友啦，请勿重复添加',
  sucess_request: '申请好友成功啦'
}

export const user = {
  send_user_name: '请发送要查询的玩家名称',
  no_user_found: '没搜到任何玩家捏',
  searched_user_tip: '搜索到以下 {count} 个玩家',
  reply_index: '请发送要查看的玩家序号，输入 0 取消',
  reply_index_add: '发送【添加 1】来添加第一位玩家为好友'
}

export const world = {
  send_world_name: '请发送要查询的地图名称',
  no_world_found: '没搜到任何地图捏',
  searched_world_tip: '搜索到以下 {count} 个世界',
  search_pause_tip:
    '发送[1]查看第一个世界\n发送[喜好 1 world1]添加到喜好【world1】组\n发送[0]取消\n【可以用 #vrc收藏组列表 指令来获取组】',
  invalid_world_index: '无效的世界序号',
  favorite_format_error:
    '格式错误，发送[喜好 1 world1]添加到喜好【world1】组\n发送[0]取消\n【可以用 #vrc收藏组列表 指令来获取组】',
  success_add_world_favorite: '已成功添加世界 {name} 到喜好'
}

export const notif = {
  all_notif_resp: '直接发送【#vrc 接受 1】/【#vrc 忽略 1】/【#vrc 拒绝 1】即可处理好友申请，发送 0 退出',
  accept: '接受',
  accept_resp: '已接受好友申请',
  ignore: '忽略',
  ignore_resp: '已忽略好友申请',
  deny: '拒绝',
  deny_resp: '已拒绝好友申请',
  error_handle: '无效操作好友申请',
  no_request: '没有好友申请',
  processed: '该请求已被处理啦'
}

export const favorite = {
  send_favorite_type: '请发送收藏类型 (avatar/world)',
  invalid_favorite_type: '类型必须是 avatar 或 world',
  empty_favorite_list: '该类型 ({type}) 没有收藏',
  empty_favorite_groups: '没有收藏组',
  favorite_list_info: '收藏列表 ({type})，共 {count} 个',
  favorite_groups_info: '收藏组列表，共 {count} 个',
}

/** 免责声明（用户指定参考米游社 sk/ck 的写法） */
export const DISCLAIMER = [
  '免责声明：登录必须私聊发送，请不要在群里输入账号密码。',
  '您将输入 VRChat 账号与密码以完成登录，登录状态仅保存在机器人本地，不会发送给任何第三方。',
  '如果不小心发到了群里，登录成功后请立刻撤回那条消息。',
  '我方仅提供 VRChat 查询及相关内容服务，若您的账号被封禁、被盗等处罚与我方无关。',
  '害怕风险请勿登录~'
].join('\n')

export const HELP_TEXT = [
  '--------vrc指令--------',
  '1、【#vrc登录】 | 登录 VRChat 账户，必须私聊发送',
  '2、【#vrc退出登录】 | 清除本机保存的登录状态',
  '3、【#vrc全部好友】 | 获取全部好友信息',
  '4、【#vrc搜索用户 关键词】 | 查询玩家',
  '5、【#vrc搜索世界 关键词】 | 查询世界',
  '6、【#vrc显示通知】 | 查看通知与好友申请',
  '7、【#vrc收藏列表 avatar/world】 | 查看收藏',
  '8、【#vrc收藏组列表】 | 查看收藏组',
  '9、【#vrc我的信息】 | 查看自己的资料卡',
  '10、【#vrc帮助】 | 出这张帮助图'
].join('\n')
