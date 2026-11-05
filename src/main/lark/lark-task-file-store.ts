import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  larkBotConfigSchema,
  toLarkBotPublicIdentity,
  type LarkBotConfig,
  type LarkBotEvent,
  type LarkBotIdentity,
  type LarkBotPublicIdentity
} from '../../shared/lark/lark-bot-config'
import {
  ingestLarkBotEvent,
  type LarkTask,
  type LarkTaskIngestResult
} from '../../shared/lark/lark-task'
import { larkTaskMayReply } from '../../shared/lark/lark-thread-reply'

type PersistedLarkTasks = {
  config: LarkBotConfig | null
  identity: LarkBotIdentity | null
  tasks: LarkTask[]
}

function emptyState(): PersistedLarkTasks {
  return { config: null, identity: null, tasks: [] }
}

export class LarkTaskFileStore {
  private pending: Promise<unknown> = Promise.resolve()
  private state: PersistedLarkTasks = emptyState()
  private loaded = false
  private loadError: string | null = null

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await this.serialize(async () => {
      if (this.loaded) {
        return
      }
      let raw: string
      try {
        raw = await readFile(this.filePath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.state = emptyState()
          this.loaded = true
          return
        }
        this.loadError = 'Lark task storage could not be read. Existing data was left in place.'
        throw error
      }
      try {
        const parsed = JSON.parse(raw) as Partial<PersistedLarkTasks>
        const config = parsed.config == null ? null : larkBotConfigSchema.parse(parsed.config)
        const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : []
        this.state = {
          config,
          identity: isIdentity(parsed.identity) ? parsed.identity : null,
          tasks
        }
        this.loaded = true
      } catch (error) {
        this.loadError = 'Lark task storage could not be read. Existing data was left in place.'
        throw error
      }
    })
  }

  getConfig(): LarkBotConfig | null {
    return this.state.config ? structuredClone(this.state.config) : null
  }

  getIdentity(): LarkBotIdentity | null {
    return this.state.identity ? { ...this.state.identity } : null
  }

  getPublicIdentity(): LarkBotPublicIdentity | null {
    return toLarkBotPublicIdentity(this.state.identity)
  }

  getLoadError(): string | null {
    return this.loadError
  }

  listTasks(): LarkTask[] {
    return this.state.tasks.map((task) => structuredClone(task))
  }

  configure(config: LarkBotConfig, identity: LarkBotIdentity | null): Promise<void> {
    return this.serialize(async () => {
      this.state = {
        ...this.state,
        config: larkBotConfigSchema.parse(config),
        identity
      }
      await this.persist()
    })
  }

  taskForWorktree(worktreeId: string): LarkTask | null {
    const task = this.state.tasks.find((entry) => entry.delivery?.worktreeId === worktreeId)
    return task ? structuredClone(task) : null
  }

  bindWorkspace(taskId: string, worktreeId: string): Promise<'bound' | 'missing' | 'rejected'> {
    return this.serialize(async () => {
      const task = this.state.tasks.find((entry) => entry.id === taskId)
      if (!task) {
        return 'missing'
      }
      if (!larkTaskMayReply(task, this.state.config)) {
        return 'rejected'
      }
      task.delivery = {
        worktreeId,
        replyMessageId: task.bot.rootId,
        ...(task.delivery?.worktreeId === worktreeId
          ? {
              ...(task.delivery.ackSent ? { ackSent: true } : {}),
              ...(task.delivery.resultSent ? { resultSent: true } : {}),
              ...(task.delivery.withdrawn ? { withdrawn: true } : {})
            }
          : {})
      }
      await this.persist()
      return 'bound'
    })
  }

  markDelivery(
    taskId: string,
    patch: { ackSent?: boolean; resultSent?: boolean; withdrawn?: boolean }
  ): Promise<void> {
    return this.serialize(async () => {
      const task = this.state.tasks.find((entry) => entry.id === taskId)
      if (!task?.delivery) {
        return
      }
      task.delivery = { ...task.delivery, ...patch }
      await this.persist()
    })
  }

  receive(event: LarkBotEvent, identity: LarkBotIdentity): Promise<LarkTaskIngestResult> {
    return this.serialize(async () => {
      const config = this.state.config
      if (!config) {
        return { accepted: false }
      }
      const result = ingestLarkBotEvent({
        tasks: this.state.tasks,
        event,
        identity,
        config
      })
      if (result.accepted) {
        this.state = { ...this.state, tasks: result.tasks }
        await this.persist()
      }
      return result
    })
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.pending.catch(() => {}).then(action)
    this.pending = operation
    return operation
  }

  private async persist(): Promise<void> {
    if (this.loadError) {
      throw new Error(this.loadError)
    }
    await mkdir(dirname(this.filePath), { recursive: true })
    const next = `${this.filePath}.${process.pid}.tmp`
    await writeFile(next, JSON.stringify(this.state), { mode: 0o600 })
    await chmod(next, 0o600)
    await rename(next, this.filePath)
    await chmod(this.filePath, 0o600).catch(() => {})
  }
}

function isIdentity(value: unknown): value is LarkBotIdentity {
  if (!value || typeof value !== 'object') {
    return false
  }
  const raw = value as Record<string, unknown>
  return (
    typeof raw.appId === 'string' &&
    typeof raw.botId === 'string' &&
    (raw.region === 'lark' || raw.region === 'feishu')
  )
}
