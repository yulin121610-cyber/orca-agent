import type { LarkBotConfig, LarkBotEvent, LarkBotIdentity } from './lark-bot-config'
import { createNonSecureContextUuid } from '../non-secure-context-uuid'

export const LARK_TASK_LIMIT = 750
export const LARK_TASK_MAX_BYTES = 240 * 1024
export const LARK_TASK_DESCRIPTION_MAX = 180_000
export const LARK_TASK_MESSAGE_ID_LIMIT = 2000

export type LarkTask = {
  id: string
  sourceKey: string
  url: string
  title: string
  description: string
  status: 'pending'
  importedAt: string
  bot: {
    appId: string
    chatId: string
    rootId: string
    messageIds: string[]
  }
}

export type LarkTaskIngestResult =
  | { accepted: false }
  | { accepted: true; tasks: LarkTask[] }
  | { accepted: false; error: string }

function stripMentions(event: LarkBotEvent, identity: LarkBotIdentity): string {
  let content = event.content
  for (const mention of event.mentions) {
    if ([identity.botId, identity.appId].includes(mention.id)) {
      for (const marker of [mention.key, mention.name ? `@${mention.name}` : undefined]) {
        if (marker) {
          content = content.replaceAll(marker, '')
        }
      }
    } else if (mention.key) {
      content = content.replaceAll(mention.key, `@${mention.name ?? mention.id}`)
    }
  }
  return content.trim()
}

function mentionsBot(event: LarkBotEvent, identity: LarkBotIdentity): boolean {
  return event.mentions.some((mention) => [identity.botId, identity.appId].includes(mention.id))
}

function sameSource(task: LarkTask, identity: LarkBotIdentity, chatId: string): boolean {
  return task.bot.appId === identity.appId && task.bot.chatId === chatId
}

function taskBytes(task: LarkTask): number {
  return new TextEncoder().encode(JSON.stringify(task)).byteLength
}

/**
 * Accept a group message from an allowlisted sender.
 * A new task requires an @bot mention. A later message in the same thread appends without one.
 * Message ids are deduped. Nothing here sends mail, commits, or starts an agent.
 */
export function ingestLarkBotEvent(args: {
  tasks: readonly LarkTask[]
  event: LarkBotEvent
  identity: LarkBotIdentity
  config: LarkBotConfig
  now?: Date
  createId?: () => string
}): LarkTaskIngestResult {
  const { event, identity, config } = args
  if (
    !config.enabled ||
    event.chat_type !== 'group' ||
    !config.chatIds.includes(event.chat_id) ||
    event.sender_type !== 'user' ||
    !config.allowedSenderIds.includes(event.sender_id) ||
    [identity.botId, identity.appId].includes(event.sender_id)
  ) {
    return { accepted: false }
  }
  const content = stripMentions(event, identity)
  if (!content) {
    return { accepted: false }
  }
  const tasks = args.tasks.map((task) => structuredClone(task))
  const rootId = event.root_id ?? event.message_id
  if (
    tasks.some(
      (task) =>
        sameSource(task, identity, event.chat_id) && task.bot.messageIds.includes(event.message_id)
    )
  ) {
    return { accepted: false }
  }
  const existing = tasks.find(
    (task) => sameSource(task, identity, event.chat_id) && task.bot.rootId === rootId
  )
  if (!existing && !mentionsBot(event, identity)) {
    return { accepted: false }
  }
  const addition = `${content}\n\nSender: ${event.sender_id}\nMessage ID: ${event.message_id}`
  if (existing) {
    if (existing.bot.messageIds.length >= LARK_TASK_MESSAGE_ID_LIMIT) {
      return { accepted: false, error: 'This Lark thread has reached its message limit.' }
    }
    const description = `${existing.description}\n\n---\n${addition}`
    if (description.length > LARK_TASK_DESCRIPTION_MAX) {
      return { accepted: false, error: 'This Lark task is too large to append another message.' }
    }
    existing.description = description
    existing.bot.messageIds.push(event.message_id)
    if (taskBytes(existing) > LARK_TASK_MAX_BYTES) {
      return {
        accepted: false,
        error: 'This Lark task exceeds the storage limit. Existing content was kept.'
      }
    }
    return { accepted: true, tasks }
  }
  if (tasks.length >= LARK_TASK_LIMIT) {
    return { accepted: false, error: 'Lark task storage is full (750). Existing tasks were kept.' }
  }
  const domain = identity.region === 'feishu' ? 'feishu.cn' : 'larksuite.com'
  const task: LarkTask = {
    id: args.createId?.() ?? createNonSecureContextUuid(),
    sourceKey: JSON.stringify(['chat', event.chat_id, event.message_id]),
    url: `https://applink.${domain}/client/chat/open?openChatId=${encodeURIComponent(event.chat_id)}`,
    title: content.split('\n')[0].slice(0, 200),
    description: `${addition}\nChat ID: ${event.chat_id}`,
    status: 'pending',
    importedAt: (args.now ?? new Date()).toISOString(),
    bot: {
      appId: identity.appId,
      chatId: event.chat_id,
      rootId,
      messageIds: [event.message_id]
    }
  }
  if (taskBytes(task) > LARK_TASK_MAX_BYTES) {
    return { accepted: false, error: 'This Lark message exceeds the storage limit.' }
  }
  tasks.push(task)
  return { accepted: true, tasks }
}
