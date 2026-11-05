import type { LarkBotConfig } from '../../shared/lark/lark-bot-config'
import type { LarkSaveResult, LarkSourceSnapshot } from '../../shared/lark/lark-snapshot'

export type LarkApi = {
  snapshot: () => Promise<LarkSourceSnapshot>
  saveConfig: (config: LarkBotConfig) => Promise<LarkSaveResult>
  bindWorkspace: (args: {
    taskId: string
    worktreeId: string
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  onTasksChanged: (listener: () => void) => () => void
}
