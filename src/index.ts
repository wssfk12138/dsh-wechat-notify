import { execFileSync } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * 本机微信发送器（ClawBot 通道）CLI 入口的绝对路径，由环境变量注入。
 * 该命令需要支持：`node <入口> send --file <消息文件>`。
 * 未设置时，调用 wechat_notify 会返回可读的配置提示，而不是发送失败。
 */
const CLAWBOT_INDEX = process.env.WECHAT_NOTIFY_CLAWBOT_INDEX

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
