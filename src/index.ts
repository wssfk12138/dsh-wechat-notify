import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * 本机微信发送器（ClawBot 通道）CLI 入口的绝对路径，由环境变量注入。
 * 该命令需要支持：`node <入口> send --file <消息文件>`。
 * 未设置时，调用 wechat_notify / wechat_login 会返回可读的配置提示，而不是发送失败。
 */
const CLAWBOT_INDEX = process.env.WECHAT_NOTIFY_CLAWBOT_INDEX

/** 微信 ilink 接口根地址（与 ClawBot 一致）。 */
const WECHAT_ILINK_BASE = 'https://ilinkai.weixin.qq.com'

/** 待确认登录的二维码状态文件（复用 ClawBot 的数据目录 ~/.wx-ai-bridge）。 */
const PENDING_QR_FILE = join(homedir(), '.wx-ai-bridge', 'pending_qrcode.json')

export const name = 'wechat-notify'
export const inject = ['tools']

export function apply(ctx: Context) {
  console.log('[wechat-notify] plugin loaded')

  ctx.tools.register(defineTool({
    name: 'wechat_notify',
    description: '通过微信给用户发一条通知，复用本机 ClawBot 微信通道。',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: '通知正文（支持中文）',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const message = args.message
      if (!CLAWBOT_INDEX) {
        return '微信通知发送失败：未配置微信发送器。请设置环境变量 WECHAT_NOTIFY_CLAWBOT_INDEX 指向 ClawBot 的 dist/index.js 后重试。'
      }
      const msgFile = join(tmpdir(), `wechat-notify-${process.pid}-${Date.now()}.txt`)
      try {
        // 正文写 UTF-8 临时文件后经 `--file` 传入，避免 shell 编码把中文变成问号。
        writeFileSync(msgFile, message, 'utf8')
        try {
          execFileSync(process.execPath, [CLAWBOT_INDEX, 'send', '--file', msgFile], {
            encoding: 'utf8',
            timeout: 30_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          return `微信通知已发送：${message}`
        } catch (error) {
          const detail = describeFailure(error)
          if (/prepare|context[\s_-]?token|登录|扫码|发过消息|login|expired|激活/i.test(detail)) {
            return `微信通知发送失败：会话可能已过期或尚未激活。请先给 ClawBot 发一条消息激活，然后重试。原始错误：${detail}`
          }
          return `微信通知发送失败：${detail}`
        }
      } finally {
        if (existsSync(msgFile)) {
          try {
            unlinkSync(msgFile)
          } catch {
            // best-effort cleanup
          }
        }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wechat_login',
    description: '获取微信登录二维码，返回一个扫码链接；用户用微信打开/扫描后即可登录 ClawBot 微信通道。首次连接微信时使用。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      if (!CLAWBOT_INDEX) {
        return '获取微信登录二维码失败：未配置微信发送器。请设置环境变量 WECHAT_NOTIFY_CLAWBOT_INDEX 指向 ClawBot 的 dist/index.js 后重试。'
      }
      try {
        const auth = await importClawbotModule('ilink/auth.js')
        const qr = await auth.getQRCode()
        const url = qr.qrcode_img_content || qr.qrcode
        const qrcode = qr.qrcode
        mkdirSync(join(homedir(), '.wx-ai-bridge'), { recursive: true })
        writeFileSync(PENDING_QR_FILE, JSON.stringify({ qrcode, url, createdAt: Date.now() }), 'utf8')
        const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`
        return `微信登录二维码已生成（约 5 分钟内有效），请用微信扫描下方二维码登录：\n\n![微信扫码登录](${qrImgUrl})\n\n若二维码无法显示，可把下面的链接发到微信任意聊天（如“文件传输助手”）里点开登录：\n${url}\n\n确认登录后，请让 agent 调用 wechat_login_confirm 完成登录凭据保存。`
      } catch (error) {
        return `获取微信登录二维码失败：${describeFailure(error)}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wechat_login_confirm',
    description: '确认微信扫码登录是否完成；用户扫码确认后调用本工具保存登录凭据。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      if (!CLAWBOT_INDEX) {
        return '确认登录失败：未配置微信发送器。请设置环境变量 WECHAT_NOTIFY_CLAWBOT_INDEX 指向 ClawBot 的 dist/index.js 后重试。'
      }
      let pending: { qrcode?: string } = {}
      try {
        pending = JSON.parse(readFileSync(PENDING_QR_FILE, 'utf8'))
      } catch {
        return '没有待确认的二维码。请先调用 wechat_login 获取登录二维码。'
      }
      if (!pending.qrcode) {
        return '没有待确认的二维码。请先调用 wechat_login 获取登录二维码。'
      }
      try {
        const config = await importClawbotModule('config.js')
        const status = await pollLoginStatus(pending.qrcode)
        if (!status) {
          return '尚未检测到扫码。请先用微信打开二维码链接并扫码，然后再次调用 wechat_login_confirm。'
        }
        switch (status.status) {
          case 'confirmed':
            config.saveCredentials({
              botToken: status.bot_token,
              baseUrl: status.baseurl || WECHAT_ILINK_BASE,
              ilinkBotId: status.ilink_bot_id,
              ilinkUserId: status.ilink_user_id,
            })
            try { unlinkSync(PENDING_QR_FILE) } catch { /* best-effort cleanup */ }
            return '登录成功！微信通道已连接，现在可以用 wechat_notify 发送通知了。'
          case 'scaned':
            return '已扫码，请在手机上确认登录，然后再次调用 wechat_login_confirm。'
          case 'wait':
            return '尚未检测到扫码。请先用微信打开二维码链接并扫码，然后再次调用 wechat_login_confirm。'
          case 'expired':
            return '二维码已过期。请重新调用 wechat_login 获取新二维码。'
          default:
            return `确认登录结果未知：${JSON.stringify(status)}`
        }
      } catch (error) {
        return `确认登录失败：${describeFailure(error)}`
      }
    },
  }))
}

/** 动态加载 ClawBot dist 下的 ESM 模块（getQRCode / saveCredentials）。 */
async function importClawbotModule(relPath: string): Promise<any> {
  const url = pathToFileURL(join(dirname(CLAWBOT_INDEX ?? ''), relPath)).href
  return await import(url)
}

/** 查询扫码状态（短超时，未扫码时接口会挂起，返回 null 视为「尚未扫码」）。 */
async function pollLoginStatus(qrcode: string): Promise<any | null> {
  const url = `${WECHAT_ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
  try {
    const res = await fetch(url, {
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** 从 execFileSync 抛出的错误里提取可读的 stdout/stderr/message 文本。 */
function describeFailure(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown }
    const parts: string[] = []
    if (typeof value.stderr === 'string' && value.stderr.trim()) parts.push(value.stderr.trim())
    if (typeof value.stdout === 'string' && value.stdout.trim()) parts.push(value.stdout.trim())
    if (typeof value.message === 'string' && value.message.trim()) parts.push(value.message.trim())
    const text = parts.join(' | ').trim()
    if (text) return text
  }
  return String(error)
}
