import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { ZodError } from 'zod'
import {
  LARK_TASKS_CHANGED_CHANNEL,
  type LarkSaveResult,
  type LarkSourceSnapshot
} from '../../shared/lark/lark-snapshot'
import { openLarkEventSession, resolveLarkBot } from './lark-bot-cli'
import { LarkBotListener } from './lark-bot-listener'
import { LarkTaskFileStore } from './lark-task-file-store'

function broadcastTasksChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(LARK_TASKS_CHANGED_CHANNEL)
    }
  }
}

export type LarkTaskService = {
  start: () => Promise<void>
  snapshot: () => LarkSourceSnapshot
  saveConfig: (raw: unknown) => Promise<LarkSaveResult>
  shutdown: () => Promise<void>
}

export function createLarkTaskService(filePath: string): LarkTaskService {
  const store = new LarkTaskFileStore(filePath)
  const listener = new LarkBotListener(
    store,
    { resolveIdentity: resolveLarkBot, openEvents: openLarkEventSession },
    broadcastTasksChanged
  )
  const snapshot = (): LarkSourceSnapshot => {
    const status = listener.status()
    return {
      config: store.getConfig(),
      identity: store.getPublicIdentity(),
      state: status.state,
      ...(status.error ? { error: status.error } : {}),
      ...(status.lastReceivedAt ? { lastReceivedAt: status.lastReceivedAt } : {}),
      tasks: store.listTasks()
    }
  }
  return {
    async start() {
      try {
        await store.load()
      } catch {
        broadcastTasksChanged()
        return
      }
      await listener.restore()
      broadcastTasksChanged()
    },
    snapshot: () => {
      const next = snapshot()
      const loadError = store.getLoadError()
      if (!loadError) {
        return next
      }
      return { ...next, state: 'error' as const, error: loadError }
    },
    async saveConfig(raw) {
      try {
        await listener.configure(raw)
        const next = snapshot()
        broadcastTasksChanged()
        return { ok: true, snapshot: next }
      } catch (error) {
        return { ok: false, error: configError(error) }
      }
    },
    shutdown: () => listener.shutdown()
  }
}

function configError(error: unknown): string {
  if (error instanceof ZodError) {
    return 'Check the bot CLI path, group IDs (oc_…), and sender IDs (ou_…).'
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  return 'Could not save the Lark bot connection.'
}

let service: LarkTaskService | null = null

export function getLarkTaskService(): LarkTaskService {
  if (!service) {
    service = createLarkTaskService(join(app.getPath('userData'), 'lark-tasks.json'))
  }
  return service
}

export function resetLarkTaskServiceForTests(): void {
  service = null
}
