import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LarkBotIdentity } from '../../shared/lark/lark-bot-config'
import { LarkBotListener } from './lark-bot-listener'
import type { LarkEventSession } from './lark-event-session'
import { LarkTaskFileStore } from './lark-task-file-store'

const identity: LarkBotIdentity = {
  appId: 'cli_abc123',
  botId: 'ou_botbot',
  region: 'lark'
}

const config = {
  enabled: true,
  cliPath: '/usr/local/bin/lark-cli',
  chatIds: ['oc_groupone'],
  allowedSenderIds: ['ou_sender1']
}

function message(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    message_id: 'om_msg1',
    chat_id: 'oc_groupone',
    chat_type: 'group',
    sender_id: 'ou_sender1',
    sender_type: 'user',
    content: '@Bot check the build',
    mentions: [{ id: 'ou_botbot', key: '@Bot', name: 'Bot' }],
    ...overrides
  })
}

describe('Lark bot listener', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('stores an @bot message and appends a thread follow-up after the CLI reports ready', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-lark-'))
    directories.push(dir)
    const store = new LarkTaskFileStore(join(dir, 'lark-tasks.json'))
    await store.load()
    const changes: number[] = []
    const stderr = new EventEmitter()
    const queue: string[] = []
    let wake: (() => void) | null = null
    let closed = false
    let resolveClosed: () => void = () => {}
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    const stop = (): void => {
      closed = true
      wake?.()
      resolveClosed()
    }
    const session: LarkEventSession = {
      stdout: (async function* () {
        while (!closed) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve
            })
            continue
          }
          const line = queue.shift()
          if (line) {
            yield `${line}\n`
          }
        }
      })(),
      stderr,
      closed: closedPromise,
      stop,
      failOnStreamError: () => {}
    }
    const listener = new LarkBotListener(
      store,
      {
        resolveIdentity: async () => identity,
        openEvents: async () => session
      },
      () => changes.push(store.listTasks().length)
    )

    const push = (line: string): void => {
      queue.push(line)
      wake?.()
    }
    await listener.configure(config)
    await vi.waitFor(() => {
      stderr.emit('data', Buffer.from('[event] ready\n'))
      expect(listener.status().state).toBe('listening')
    })
    push(message({}))
    await vi.waitFor(() => expect(store.listTasks()).toHaveLength(1))
    push(
      message({
        message_id: 'om_msg2',
        content: 'the log is attached',
        root_id: 'om_msg1',
        mentions: []
      })
    )
    await vi.waitFor(() =>
      expect(store.listTasks()[0]?.bot.messageIds).toEqual(['om_msg1', 'om_msg2'])
    )
    expect(store.listTasks()[0]?.description).toContain('the log is attached')
    expect(changes.length).toBeGreaterThan(0)
    await listener.shutdown()
  })
})
