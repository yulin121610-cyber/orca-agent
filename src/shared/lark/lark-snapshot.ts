import type { LarkBotConfig, LarkBotPublicIdentity } from './lark-bot-config'
import type { LarkTask } from './lark-task'

export const LARK_TASKS_CHANGED_CHANNEL = 'lark:tasks-changed'

export type LarkListenerState = 'stopped' | 'starting' | 'listening' | 'reconnecting' | 'error'

export type LarkSourceSnapshot = {
  config: LarkBotConfig | null
  identity: LarkBotPublicIdentity | null
  state: LarkListenerState
  error?: string
  lastReceivedAt?: string
  tasks: LarkTask[]
}

export type LarkSaveResult =
  | { ok: true; snapshot: LarkSourceSnapshot }
  | { ok: false; error: string }
