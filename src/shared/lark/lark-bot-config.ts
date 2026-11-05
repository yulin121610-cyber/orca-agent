import { z } from 'zod'

const chatIdSchema = z.string().regex(/^oc_[A-Za-z0-9]+$/)
const senderIdSchema = z.string().regex(/^ou_[A-Za-z0-9]+$/)

export const larkBotConfigSchema = z
  .object({
    enabled: z.boolean(),
    cliPath: z.string().trim().min(1).max(4096),
    chatIds: z.array(chatIdSchema).min(1).max(20),
    allowedSenderIds: z.array(senderIdSchema).min(1).max(100)
  })
  .strict()

export const larkBotEventSchema = z.object({
  message_id: z.string().regex(/^om_[A-Za-z0-9]+$/),
  chat_id: chatIdSchema,
  chat_type: z.enum(['p2p', 'group']),
  sender_id: z.string().min(1),
  sender_type: z.enum(['user', 'bot']),
  content: z.string().max(100_000),
  mentions: z
    .array(
      z.object({
        id: z.string(),
        key: z.string().optional(),
        name: z.string().optional()
      })
    )
    .default([]),
  root_id: z
    .string()
    .regex(/^om_[A-Za-z0-9]+$/)
    .optional()
})

export type LarkBotConfig = z.infer<typeof larkBotConfigSchema>
export type LarkBotEvent = z.infer<typeof larkBotEventSchema>

export type LarkBotIdentity = {
  appId: string
  botId: string
  region: 'lark' | 'feishu'
}

export type LarkBotPublicIdentity = {
  appId: string
  region: 'lark' | 'feishu'
}

export function larkObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Lark returned an invalid response.')
  }
  return value as Record<string, unknown>
}

/** Bot-only CLI probe. User OAuth and non-bot strict mode are rejected before any task is stored. */
export function parseLarkBotIdentity(args: {
  authStatusJson: string
  strictModeText: string
  botInfoJson: string
}): LarkBotIdentity {
  const auth = larkObject(JSON.parse(args.authStatusJson))
  const bot = larkObject(larkObject(auth.identities).bot)
  if (
    bot.status !== 'ready' ||
    typeof auth.appId !== 'string' ||
    !/^cli_[A-Za-z0-9]+$/.test(auth.appId)
  ) {
    throw new Error('Lark bot authorization is not ready.')
  }
  if (!/strict-mode:\s*bot\b/.test(args.strictModeText)) {
    throw new Error(
      'Configure a separate Lark CLI with strict-mode bot. User identity is not accepted.'
    )
  }
  const result = larkObject(JSON.parse(args.botInfoJson))
  const info = larkObject(result.bot)
  if (typeof info.open_id !== 'string' || !/^ou_[A-Za-z0-9]+$/.test(info.open_id)) {
    throw new Error('Lark did not return a valid bot identity.')
  }
  return {
    appId: auth.appId,
    botId: info.open_id,
    region: auth.brand === 'lark' ? 'lark' : 'feishu'
  }
}

export function toLarkBotPublicIdentity(
  identity: LarkBotIdentity | null | undefined
): LarkBotPublicIdentity | null {
  if (!identity) {
    return null
  }
  return { appId: identity.appId, region: identity.region }
}

const ID_SPLIT = /[\s,]+/

export function parseLarkIdList(value: string, pattern: RegExp): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const part of value.split(ID_SPLIT)) {
    const id = part.trim()
    if (!id || seen.has(id)) {
      continue
    }
    if (!pattern.test(id)) {
      return []
    }
    seen.add(id)
    ids.push(id)
  }
  return ids
}
