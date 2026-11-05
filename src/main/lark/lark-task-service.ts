import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { ZodError } from 'zod'
import {
  LARK_TASKS_CHANGED_CHANNEL,
  type LarkSaveResult,
  type LarkSourceSnapshot
} from '../../shared/lark/lark-snapshot'
import { openLarkEventSession, postLarkThreadReply, resolveLarkBot } from './lark-bot-cli'
import {
  buildLarkImReply,
  larkReplyIdempotencyKey,
  larkTaskMayReply,
  type LarkReplyKind,
  type LarkReplyOutcome
} from '../../shared/lark/lark-thread-reply'
import { LarkBotListener } from './lark-bot-listener'
import { LarkTaskFileStore } from './lark-task-file-store'

function broadcastTasksChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(LARK_TASKS_CHANGED_CHANNEL)
    }
  }
}

export type LarkTurnNote = {
  worktreeId: string
  kind: LarkReplyKind
  outcome?: LarkReplyOutcome
  detail?: string
}

export type LarkTaskService = {
  start: () => Promise<void>
  snapshot: () => LarkSourceSnapshot
  saveConfig: (raw: unknown) => Promise<LarkSaveResult>
  bindWorkspace: (
    taskId: string,
    worktreeId: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  noteTurn: (note: LarkTurnNote) => Promise<void>
  shutdown: () => Promise<void>
}

export function createLarkTaskService(filePath: string): LarkTaskService {
  const store = new LarkTaskFileStore(filePath)
  const replyInflight = new Set<string>()
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
    async bindWorkspace(taskId, worktreeId) {
      if (
        typeof taskId !== 'string' ||
        typeof worktreeId !== 'string' ||
        !isWorkspaceId(worktreeId)
      ) {
        return { ok: false, error: 'That Lark task could not be linked to a workspace.' }
      }
      try {
        await store.load()
      } catch {
        return { ok: false, error: 'Lark task storage could not be read.' }
      }
      const bound = await store.bindWorkspace(taskId, worktreeId)
      if (bound === 'bound') {
        return { ok: true }
      }
      return {
        ok: false,
        error:
          bound === 'missing'
            ? 'That Lark task is no longer available.'
            : 'This Lark task is not from an allowed group or sender.'
      }
    },
    async noteTurn(note) {
      const task = store.taskForWorktree(note.worktreeId)
      const delivery = task?.delivery
      if (!task || !delivery || delivery.withdrawn) {
        return
      }
      if (note.kind === 'ack' && delivery.ackSent) {
        return
      }
      if (note.kind === 'result' && delivery.resultSent) {
        return
      }
      const config = store.getConfig()
      if (!larkTaskMayReply(task, config) || !config) {
        return
      }
      const idempotencyKey = larkReplyIdempotencyKey(note.kind, task.id)
      if (replyInflight.has(idempotencyKey)) {
        return
      }
      replyInflight.add(idempotencyKey)
      try {
        const posted = await postLarkThreadReply({
          program: config.cliPath,
          messageId: delivery.replyMessageId,
          markdown: buildLarkImReply({
            kind: note.kind,
            title: task.title,
            outcome: note.outcome,
            detail: note.detail
          }),
          idempotencyKey
        })
        if (posted.status === 'sent') {
          await store.markDelivery(
            task.id,
            note.kind === 'ack' ? { ackSent: true } : { resultSent: true }
          )
        } else if (posted.status === 'withdrawn') {
          await store.markDelivery(task.id, { withdrawn: true })
        }
      } catch {
        // A failed CLI check can be retried on the next real turn. Do not surface argv or output.
      } finally {
        replyInflight.delete(idempotencyKey)
      }
    },
    shutdown: () => listener.shutdown()
  }
}

function isWorkspaceId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value)
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
