import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { confirmClawBotLogin, createClawBotProvider, PENDING_QR_FILE } from './core.ts'

export { adaptLegacyWechatProvider, createClawBotProvider, discoverWechatProvider, WECHAT_PROVIDER_API_VERSION } from './core.ts'
export type { LoginResult, NotificationProvider, NotificationStatus, ProviderCapabilities, SendResult } from './core.ts'

export const name = 'wechat-notify'
export const inject = ['tools']

export function apply(ctx: Context) {
  const provider = createClawBotProvider({ source: 'external' })
  // Stable runtime capability surface for sibling plugins. This is a service
  // reference, not a second tool/bridge registration and never migrates creds.
  ;(ctx as any).wechatNotify = provider
  ;(ctx as any).wechatConnection = provider
  console.log('[wechat-notify] plugin loaded (shared core api v' + provider.apiVersion + ')')

  ctx.tools.register(defineTool({
    name: 'wechat_notify',
    description: '通过微信给用户发一条通知，复用本机 ClawBot 微信通道。',
    parameters: { message: { type: 'string', required: true, description: '通知正文（支持中文）' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { return (await provider.send(args.message)).message },
  }))

  ctx.tools.register(defineTool({
    name: 'wechat_login',
    description: '获取微信登录二维码，直接显示在 dsh 页面；扫码后调用 wechat_login_confirm。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      const result = await provider.login?.()
      if (!result || !result.ok) return result?.message ?? '获取微信登录二维码失败。'
      return '微信登录二维码已生成（约 5 分钟内有效），请用微信扫描下方二维码登录：\n\n![微信扫码登录](' + result.imageUrl + ')\n\n若二维码无法显示，可把下面的链接发到微信任意聊天里点开登录：\n' + result.url + '\n\n确认登录后，请调用 wechat_login_confirm。'
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wechat_login_confirm',
    description: '确认微信扫码登录是否完成并保存凭据。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return await confirmClawBotLogin(undefined, PENDING_QR_FILE) },
  }))
}
