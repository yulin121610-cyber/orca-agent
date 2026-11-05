import type { LarkBotConfig } from './lark-bot-config'
import type { LarkTask } from './lark-task'

export type LarkReplyKind = 'ack' | 'result'
export type LarkReplyOutcome = 'success' | 'failed' | 'needs-user'
export type LarkReplyFailure = 'withdrawn' | 'retryable'

const MESSAGE_ID = /^om_[A-Za-z0-9]+$/
const IM_CHAR_CAP = 400

export function larkReplyIdempotencyKey(kind: LarkReplyKind, taskId: string): string {
  return `orca-lark:${taskId}:${kind}`
}

export function buildLarkThreadReplyArgs(args: {
  messageId: string
  markdown: string
  idempotencyKey: string
}): string[] {
  return [
    'im',
    '+messages-reply',
    '--message-id',
    args.messageId,
    '--markdown',
    args.markdown,
    '--reply-in-thread',
    '--idempotency-key',
    args.idempotencyKey
  ]
}

export function capLarkImText(text: string): string {
  const flat = text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
  const chars = Array.from(flat)
  if (chars.length <= IM_CHAR_CAP) {
    return flat
  }
  return `${chars.slice(0, IM_CHAR_CAP).join('').trimEnd()}…`
}

function withHeading(heading: string, body: string): string {
  const room = Math.max(0, IM_CHAR_CAP - Array.from(heading).length - 2)
  const clipped = capLarkImText(body).slice(0, room).trim()
  const text = clipped ? `${heading}\n\n${clipped}` : heading
  return capLarkImText(text)
}

export function buildLarkImReply(args: {
  kind: LarkReplyKind
  title: string
  outcome?: LarkReplyOutcome
  detail?: string
}): string {
  if (args.kind === 'ack') {
    return withHeading('收到，开始处理。\nOn it.', args.title)
  }
  const heading =
    args.outcome === 'failed'
      ? '处理失败。\nFailed.'
      : args.outcome === 'needs-user'
        ? '需要你补充信息。\nNeed your input.'
        : '处理完成。\nDone.'
  return withHeading(heading, args.detail?.trim() || args.title)
}

export function classifyLarkReplyFailure(output: string): LarkReplyFailure {
  if (
    /withdrawn|recalled|message not found|msg not found|message deleted|message has been recalled|230011|230002/i.test(
      output
    )
  ) {
    return 'withdrawn'
  }
  return 'retryable'
}

/** Reply only for a task that still belongs to an allowlisted group and sender. */
export function larkTaskMayReply(task: LarkTask, config: LarkBotConfig | null): boolean {
  if (!config?.cliPath) {
    return false
  }
  if (!config.chatIds.includes(task.bot.chatId)) {
    return false
  }
  if (task.bot.senderId && !config.allowedSenderIds.includes(task.bot.senderId)) {
    return false
  }
  const messageId = task.delivery?.replyMessageId ?? task.bot.rootId
  return MESSAGE_ID.test(messageId)
}
