import { StringDecoder } from 'node:string_decoder'
import { setTimeout as delay } from 'node:timers/promises'
import {
  larkBotConfigSchema,
  larkBotEventSchema,
  type LarkBotConfig,
  type LarkBotIdentity
} from '../../shared/lark/lark-bot-config'
import type { LarkTaskFileStore } from './lark-task-file-store'
import type { LarkEventSession } from './lark-event-session'

export type LarkListenerState = 'stopped' | 'starting' | 'listening' | 'reconnecting' | 'error'

export type LarkListenerStatus = {
  state: LarkListenerState
  error?: string
  lastReceivedAt?: string
}

export type LarkBotListenerDeps = {
  resolveIdentity: (cliPath: string, signal: AbortSignal) => Promise<LarkBotIdentity>
  openEvents: (cliPath: string, signal: AbortSignal) => Promise<LarkEventSession>
}

export class LarkBotListener {
  private controller?: AbortController
  private running: Promise<void> = Promise.resolve()
  private configuration: Promise<unknown> = Promise.resolve()
  private closed = false
  private current: LarkListenerStatus = { state: 'stopped' }

  constructor(
    private readonly store: LarkTaskFileStore,
    private readonly deps: LarkBotListenerDeps,
    private readonly onTasksChanged: () => void
  ) {}

  status(): LarkListenerStatus {
    return { ...this.current }
  }

  restore(): Promise<void> {
    const operation = this.configuration
      .catch(() => {})
      .then(async () => {
        const config = this.store.getConfig()
        if (config?.enabled && !this.closed && !this.controller) {
          this.start(config)
        }
      })
    this.configuration = operation
    return operation
  }

  configure(raw: unknown): Promise<void> {
    const config = larkBotConfigSchema.parse(raw)
    const operation = this.configuration
      .catch(() => {})
      .then(async () => {
        if (this.closed) {
          throw new Error('The Lark bot listener is shutting down.')
        }
        const previous = this.store.getConfig()
        const previousIdentity = this.store.getIdentity()
        await this.stop()
        try {
          const identity = config.enabled
            ? await this.deps.resolveIdentity(config.cliPath, new AbortController().signal)
            : previousIdentity
          if (config.enabled && !identity) {
            throw new Error('Lark bot authorization is not ready.')
          }
          await this.store.configure(config, config.enabled ? identity : previousIdentity)
          if (config.enabled && !this.closed) {
            this.start(config)
          } else {
            this.current = { state: 'stopped' }
          }
        } catch (error) {
          if (previous) {
            await this.store.configure(previous, previousIdentity)
            if (previous.enabled && !this.closed) {
              this.start(previous)
            }
          }
          throw error
        }
      })
    this.configuration = operation
    return operation
  }

  async shutdown(): Promise<void> {
    this.closed = true
    this.controller?.abort()
    await this.configuration.catch(() => {})
    await this.stop()
  }

  async stop(): Promise<void> {
    this.controller?.abort()
    await this.running
    this.controller = undefined
    this.current = { state: 'stopped' }
  }

  private start(config: LarkBotConfig): void {
    const controller = new AbortController()
    this.controller = controller
    this.current = { state: 'starting' }
    this.running = this.watch(config, controller.signal)
  }

  private async watch(config: LarkBotConfig, signal: AbortSignal): Promise<void> {
    let retry = 1000
    while (!signal.aborted) {
      const began = Date.now()
      try {
        const identity = await this.deps.resolveIdentity(config.cliPath, signal)
        if (!signal.aborted) {
          await this.store.configure(config, identity)
          await this.consume(config, identity, signal)
        }
      } catch (error) {
        if (!signal.aborted) {
          this.current = {
            state: 'reconnecting',
            error: safeError(error),
            ...(this.current.lastReceivedAt ? { lastReceivedAt: this.current.lastReceivedAt } : {})
          }
          this.onTasksChanged()
        }
      }
      if (signal.aborted) {
        break
      }
      await delay(retry, undefined, { signal }).catch(() => {})
      retry = Date.now() - began >= 60_000 ? 1000 : Math.min(retry * 2, 60_000)
    }
  }

  private async consume(
    config: LarkBotConfig,
    identity: LarkBotIdentity,
    signal: AbortSignal
  ): Promise<void> {
    const session = await this.deps.openEvents(config.cliPath, signal)
    if (signal.aborted) {
      session.stop()
      return
    }
    let failure: Error | undefined
    const stop = (): void => session.stop()
    const fail = (message: string): void => {
      failure = new Error(message)
      stop()
    }
    session.failOnStreamError(() => fail('The Lark bot event stream failed.'))
    signal.addEventListener('abort', stop, { once: true })
    const readyTimeout = setTimeout(
      () => fail('The Lark bot listener did not become ready within 45 seconds.'),
      45_000
    )
    let diagnostics = ''
    session.stderr.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      diagnostics = (diagnostics + text).slice(-8192)
      if (diagnostics.includes('[event] ready')) {
        clearTimeout(readyTimeout)
        diagnostics = ''
        this.current = {
          state: 'listening',
          ...(this.current.lastReceivedAt ? { lastReceivedAt: this.current.lastReceivedAt } : {})
        }
        this.onTasksChanged()
      }
    })
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    try {
      for await (const chunk of session.stdout) {
        if (signal.aborted) {
          break
        }
        buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line.length > 1_048_576) {
            throw new Error('A Lark bot event exceeded the size limit.')
          }
          if (!line || signal.aborted) {
            continue
          }
          const parsed = larkBotEventSchema.safeParse(JSON.parse(line))
          if (!parsed.success) {
            throw new Error('The bot CLI returned an unsupported message event.')
          }
          const result = await this.store.receive(parsed.data, identity)
          if ('error' in result && result.error) {
            this.current = {
              ...this.current,
              error: result.error,
              ...(this.current.lastReceivedAt
                ? { lastReceivedAt: this.current.lastReceivedAt }
                : {})
            }
            this.onTasksChanged()
            continue
          }
          if (result.accepted) {
            this.current = {
              state: this.current.state === 'stopped' ? 'listening' : this.current.state,
              lastReceivedAt: new Date().toISOString()
            }
            if (this.current.state === 'starting') {
              this.current = { ...this.current, state: 'listening' }
            }
            this.onTasksChanged()
          }
        }
        if (buffer.length > 1_048_576) {
          throw new Error('A Lark bot event exceeded the size limit.')
        }
      }
      await session.closed
      if (!signal.aborted) {
        throw failure ?? new Error('The Lark bot event connection closed. Reconnecting.')
      }
    } finally {
      clearTimeout(readyTimeout)
      signal.removeEventListener('abort', stop)
      session.stop()
    }
  }
}

function safeError(error: unknown): string {
  if (
    error instanceof Error &&
    error.message &&
    !('code' in error) &&
    !(error instanceof SyntaxError)
  ) {
    return error.message
  }
  return 'The bot connection failed. Check the CLI and bot authorization.'
}
