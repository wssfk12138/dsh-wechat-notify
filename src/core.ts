import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
export const WECHAT_PROVIDER_API_VERSION = '1'
export const WECHAT_ILINK_BASE = 'https://ilinkai.weixin.qq.com'
export const PENDING_QR_FILE = join(homedir(), '.wx-ai-bridge', 'pending_qrcode.json')

export interface ProviderCapabilities { send: boolean; status: boolean; login: boolean; reconnect: boolean; disconnect: boolean }
export interface NotificationStatus { connected: boolean; authenticated?: boolean; detail?: string }
export interface SendResult { ok: boolean; message: string; code?: 'NOT_CONFIGURED' | 'NOT_AUTHENTICATED' | 'TIMEOUT' | 'CLI_ERROR' | 'UNAVAILABLE' }
export type LoginResult = { ok: true; qrcode: string; url: string; imageUrl: string; expiresInMs: number } | { ok: false; message: string; code?: string }

export interface NotificationProvider {
  readonly id: string
  readonly source: 'external' | 'bundled' | 'legacy'
  readonly apiVersion: string
  readonly capabilities: ProviderCapabilities
  send(message: string): Promise<SendResult>
  status(): Promise<NotificationStatus>
  login?(): Promise<LoginResult>
  reconnect?(): Promise<NotificationStatus>
  disconnect?(): Promise<void>
}

export interface ClawBotProviderOptions { cliPath?: string; source?: 'external' | 'bundled'; pendingQrFile?: string; ilinkBase?: string; timeoutMs?: number }

/** Cordis-independent adapter shared by the standalone plugin and bundled consumers. */
export function createClawBotProvider(options: ClawBotProviderOptions = {}): NotificationProvider {
  const cliPath = options.cliPath ?? process.env.WECHAT_NOTIFY_CLAWBOT_INDEX
  const source = options.source ?? 'external'
  const pendingQrFile = options.pendingQrFile ?? PENDING_QR_FILE
  const ilinkBase = options.ilinkBase ?? WECHAT_ILINK_BASE
  const timeoutMs = options.timeoutMs ?? 30_000
  const send = async (message: string): Promise<SendResult> => {
    if (!cliPath) return { ok: false, code: 'NOT_CONFIGURED', message: '微信通知不可用：未配置 WECHAT_NOTIFY_CLAWBOT_INDEX。' }
    const msgFile = join(tmpdir(), 'wechat-notify-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.txt')
    try {
      writeFileSync(msgFile, message, 'utf8')
      await execFileAsync(process.execPath, [cliPath, 'send', '--file', msgFile], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
      return { ok: true, message: '微信通知已发送：' + message }
    } catch (error) {
      const detail = describeFailure(error)
      if (/prepare|context[\s_-]?token|登录|扫码|发过消息|login|expired|激活/i.test(detail)) return { ok: false, code: 'NOT_AUTHENTICATED', message: '微信通知不可用：会话可能已过期或尚未激活。请先给 ClawBot 发一条消息激活。原始错误：' + detail }
      if (/timeout|timed out|超时/i.test(detail)) return { ok: false, code: 'TIMEOUT', message: '微信通知发送超时：' + detail }
      return { ok: false, code: 'CLI_ERROR', message: '微信通知发送失败：' + detail }
    } finally {
      if (existsSync(msgFile)) { try { unlinkSync(msgFile) } catch { /* best effort */ } }
    }
  }
  const status = async (): Promise<NotificationStatus> => {
    if (!cliPath) return { connected: false, authenticated: false, detail: '未配置 ClawBot CLI' }
    try {
      const config = await importClawBotModule(cliPath, 'config.js')
      const credentials = config.loadCredentials?.()
      return credentials ? { connected: true, authenticated: true } : { connected: false, authenticated: false, detail: '未找到微信凭据' }
    } catch (error) { return { connected: false, authenticated: false, detail: describeFailure(error) } }
  }
  const login = async (): Promise<LoginResult> => {
    if (!cliPath) return { ok: false, message: '未配置 WECHAT_NOTIFY_CLAWBOT_INDEX。', code: 'NOT_CONFIGURED' }
    try {
      const auth = await importClawBotModule(cliPath, 'ilink/auth.js')
      const qr = await auth.getQRCode()
      const url = qr.qrcode_img_content || qr.qrcode
      if (!qr.qrcode || !url) return { ok: false, message: 'ClawBot 未返回有效二维码。', code: 'INVALID_QR' }
      mkdirSync(dirname(pendingQrFile), { recursive: true })
      writeFileSync(pendingQrFile, JSON.stringify({ qrcode: qr.qrcode, url, createdAt: Date.now() }), 'utf8')
      return { ok: true, qrcode: qr.qrcode, url, imageUrl: 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(url), expiresInMs: 5 * 60_000 }
    } catch (error) { return { ok: false, message: '获取微信登录二维码失败：' + describeFailure(error), code: 'CLI_ERROR' } }
  }
  return { id: 'wechat', source, apiVersion: WECHAT_PROVIDER_API_VERSION, capabilities: { send: true, status: true, login: true, reconnect: true, disconnect: true }, send, status, login, reconnect: status, disconnect: async () => {} }
}

export async function confirmClawBotLogin(cliPath: string | undefined = process.env.WECHAT_NOTIFY_CLAWBOT_INDEX, pendingQrFile: string = PENDING_QR_FILE, ilinkBase: string = WECHAT_ILINK_BASE): Promise<string> {
  if (!cliPath) return '确认登录失败：未配置 WECHAT_NOTIFY_CLAWBOT_INDEX。'
  let pending: { qrcode?: string } = {}
  try { pending = JSON.parse(readFileSync(pendingQrFile, 'utf8')) } catch { return '没有待确认的二维码。请先调用 wechat_login。' }
  if (!pending.qrcode) return '没有待确认的二维码。请先调用 wechat_login。'
  try {
    const config = await importClawBotModule(cliPath, 'config.js')
    const response = await pollLoginStatus(pending.qrcode, ilinkBase)
    if (!response) return '尚未检测到扫码。请先用微信扫描并确认登录，然后再次调用 wechat_login_confirm。'
    switch (response.status) {
      case 'confirmed': config.saveCredentials({ botToken: response.bot_token, baseUrl: response.baseurl || ilinkBase, ilinkBotId: response.ilink_bot_id, ilinkUserId: response.ilink_user_id }); try { unlinkSync(pendingQrFile) } catch {} ; return '登录成功！微信通道已连接。'
      case 'scaned': return '已扫码，请在手机上确认登录，然后再次调用 wechat_login_confirm。'
      case 'wait': return '尚未检测到扫码。请先用微信扫描并确认登录，然后再次调用 wechat_login_confirm。'
      case 'expired': return '二维码已过期。请重新调用 wechat_login。'
      default: return '确认登录结果未知：' + JSON.stringify(response)
    }
  } catch (error) { return '确认登录失败：' + describeFailure(error) }
}

async function importClawBotModule(cliPath: string, relPath: string): Promise<any> { return await import(pathToFileURL(join(dirname(cliPath), relPath)).href) }
async function pollLoginStatus(qrcode: string, ilinkBase: string): Promise<any | null> {
  try { const res = await fetch(ilinkBase + '/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode), { headers: { 'iLink-App-ClientVersion': '1' }, signal: AbortSignal.timeout(8000) }); if (!res.ok) return null; return await res.json() } catch { return null }
}
export function describeFailure(error: unknown): string {
  if (error !== null && typeof error === 'object') { const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown }; const parts: string[] = []; if (typeof value.stderr === 'string' && value.stderr.trim()) parts.push(value.stderr.trim()); if (typeof value.stdout === 'string' && value.stdout.trim()) parts.push(value.stdout.trim()); if (typeof value.message === 'string' && value.message.trim()) parts.push(value.message.trim()); if (parts.length > 0) return parts.join(' | ') }
  return String(error)
}
export function adaptLegacyWechatProvider(value: any): NotificationProvider | undefined {
  if (!value || typeof value.send !== 'function') return undefined
  return { id: 'wechat', source: 'legacy', apiVersion: 'legacy', capabilities: { send: true, status: typeof value.status === 'function', login: false, reconnect: false, disconnect: false }, send: async (message) => { try { const result = await value.send(message); return typeof result === 'object' && result?.ok !== undefined ? result : { ok: true, message: String(result ?? '微信通知已发送') } } catch (error) { return { ok: false, code: 'UNAVAILABLE', message: '旧版微信插件发送失败：' + describeFailure(error) } } }, status: async () => { try { if (typeof value.status !== 'function') return { connected: true, detail: '旧版接口仅提供发送能力' }; const result = await value.status(); return { connected: Boolean(result?.connected ?? result?.ok ?? result), detail: '旧版微信插件' } } catch (error) { return { connected: false, detail: describeFailure(error) } } } }
}
export function discoverWechatProvider(ctx: any, bundled?: NotificationProvider): NotificationProvider | undefined {
  const candidates = [ctx?.wechatNotify, ctx?.wechatNotification, ctx?.services?.wechatNotify]
  for (const candidate of candidates) { if (candidate?.apiVersion && typeof candidate.send === 'function') return candidate as NotificationProvider; const legacy = adaptLegacyWechatProvider(candidate); if (legacy) return legacy }
  return bundled
}
