import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { AGENT_DONE_QUIET_MS } from '../../shared/agent-status/lifecycle/agent-transitions'
import {
  buildLarkImReply,
  buildLarkThreadReplyArgs,
  classifyLarkReplyFailure,
  larkReplyIdempotencyKey,
  larkTaskMayReply
} from '../../shared/lark/lark-thread-reply'
import type { LarkTask } from '../../shared/lark/lark-task'
import { LarkTaskFileStore } from './lark-task-file-store'
import { LarkTaskReplies } from './lark-task-replies'

const task = {
  id: 'task-1',
  sourceKey: 'k',
  url: 'https://applink.larksuite.com/client/chat/open?openChatId=oc_groupone',
  title: 'investigate login',
  description: 'body',
  status: 'pending',
  importedAt: '2026-01-02T00:00:00.000Z',
  bot: {
    appId: 'cli_abc123',
    chatId: 'oc_groupone',
    rootId: 'om_msg1',
    messageIds: ['om_msg1'],
    senderId: 'ou_sender1'
  }
} satisfies LarkTask

function moved(
  transition: 'prompt-submitted' | 'turn-finished' | 'errored' | 'needs-input' | null,
  to: 'working' | 'done' | 'needs-you'
): AgentPaneChange {
  return {
    kind: 'moved',
    paneKey: 'pane-1',
    workspace: { worktreeId: 'wt-1', sshHostId: null },
    from: 'working',
    to,
    at: 1,
    transition
  }
}

describe('Lark thread reply', () => {
  it('builds the bot CLI reply in the original thread with a stable idempotency key', () => {
    expect(
      buildLarkThreadReplyArgs({
        messageId: 'om_msg1',
        markdown: '收到，开始处理。',
        idempotencyKey: larkReplyIdempotencyKey('ack', 'task-1')
      })
    ).toEqual([
      'im',
      '+messages-reply',
      '--message-id',
      'om_msg1',
      '--markdown',
      '收到，开始处理。',
      '--reply-in-thread',
      '--idempotency-key',
      'orca-lark:task-1:ack'
    ])
    expect(larkReplyIdempotencyKey('result', 'task-1')).toBe('orca-lark:task-1:result')
    expect(larkReplyIdempotencyKey('ack', 'task-1')).toBe(larkReplyIdempotencyKey('ack', 'task-1'))
  })

  it('keeps the IM summary short and names the outcome', () => {
    const ack = buildLarkImReply({ kind: 'ack', title: 'investigate login' })
    expect(ack).toContain('收到，开始处理。')
    expect(ack).toContain('On it.')
    expect(ack).toContain('investigate login')
    expect(
      buildLarkImReply({ kind: 'result', title: 't', outcome: 'failed', detail: 'boom' })
    ).toContain('处理失败。')
    expect(
      buildLarkImReply({ kind: 'result', title: 't', outcome: 'needs-user', detail: 'which repo?' })
    ).toContain('需要你补充信息。')
    const long = buildLarkImReply({ kind: 'result', title: 't', detail: '字'.repeat(800) })
    expect(Array.from(long).length).toBeLessThanOrEqual(400)
  })

  it('treats a withdrawn or missing message as terminal, and other CLI failures as retryable', () => {
    expect(classifyLarkReplyFailure('the message has been withdrawn')).toBe('withdrawn')
    expect(classifyLarkReplyFailure('code 230011 message recalled')).toBe('withdrawn')
    expect(classifyLarkReplyFailure('message not found')).toBe('withdrawn')
    expect(classifyLarkReplyFailure('connection reset')).toBe('retryable')
  })

  it('refuses replies once the chat or sender leaves the allowlist', () => {
    const config = {
      enabled: true,
      cliPath: '/usr/local/bin/lark-cli',
      chatIds: ['oc_groupone'],
      allowedSenderIds: ['ou_sender1']
    }
    expect(larkTaskMayReply(task, config)).toBe(true)
    expect(larkTaskMayReply(task, { ...config, chatIds: ['oc_other'] })).toBe(false)
    expect(larkTaskMayReply(task, { ...config, allowedSenderIds: ['ou_other'] })).toBe(false)
  })
})

describe('Lark task delivery', () => {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('keeps the originating message id after restart so a result can still reply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-lark-reply-'))
    directories.push(dir)
    const file = join(dir, 'lark-tasks.json')
    const store = new LarkTaskFileStore(file)
    await store.load()
    await store.configure(
      {
        enabled: true,
        cliPath: '/usr/local/bin/lark-cli',
        chatIds: ['oc_groupone'],
        allowedSenderIds: ['ou_sender1']
      },
      { appId: 'cli_abc123', botId: 'ou_botbot', region: 'lark' }
    )
    await store.receive(
      {
        message_id: 'om_msg1',
        chat_id: 'oc_groupone',
        chat_type: 'group',
        sender_id: 'ou_sender1',
        sender_type: 'user',
        content: '@Bot check the build',
        mentions: [{ id: 'ou_botbot', key: '@Bot', name: 'Bot' }]
      },
      { appId: 'cli_abc123', botId: 'ou_botbot', region: 'lark' }
    )
    const created = store.listTasks()[0]
    expect(created?.bot.rootId).toBe('om_msg1')
    expect(await store.bindWorkspace(created!.id, 'wt-1')).toBe('bound')
    const reloaded = new LarkTaskFileStore(file)
    await reloaded.load()
    expect(reloaded.taskForWorktree('wt-1')?.delivery).toMatchObject({
      worktreeId: 'wt-1',
      replyMessageId: 'om_msg1'
    })
    await reloaded.markDelivery(created!.id, { resultSent: true })
    expect(reloaded.taskForWorktree('wt-1')?.delivery?.resultSent).toBe(true)
  })
})

describe('LarkTaskReplies', () => {
  it('acks when work starts and posts one result after the quiet window', () => {
    vi.useFakeTimers()
    const noteTurn = vi.fn()
    const replies = new LarkTaskReplies({
      noteTurn,
      readRow: () =>
        ({
          state: 'done',
          prompt: '',
          updatedAt: 2,
          stateStartedAt: 2,
          lastAssistantMessage: 'The login timeout is in the session cache.'
        }) as AgentStatusIpcPayload,
      setTimer: (run, delayMs) => {
        const timer = setTimeout(run, delayMs)
        return { cancel: () => clearTimeout(timer) }
      }
    })
    replies.observe(moved('prompt-submitted', 'working'))
    replies.observe(moved('prompt-submitted', 'working'))
    replies.observe(moved('turn-finished', 'done'))
    expect(noteTurn).toHaveBeenCalledTimes(2)
    expect(noteTurn).toHaveBeenNthCalledWith(1, { worktreeId: 'wt-1', kind: 'ack' })
    expect(noteTurn).toHaveBeenNthCalledWith(2, { worktreeId: 'wt-1', kind: 'ack' })
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(noteTurn).toHaveBeenCalledTimes(3)
    expect(noteTurn).toHaveBeenLastCalledWith({
      worktreeId: 'wt-1',
      kind: 'result',
      outcome: 'success',
      detail: 'The login timeout is in the session cache.'
    })
    replies.dispose()
    vi.useRealTimers()
  })

  it('drops a finish that resumes before the quiet window, and posts needs-user only while waiting', () => {
    vi.useFakeTimers()
    const noteTurn = vi.fn()
    const state = { waiting: false }
    const replies = new LarkTaskReplies({
      noteTurn,
      readRow: () =>
        ({
          state: state.waiting ? 'waiting' : 'blocked',
          prompt: '',
          updatedAt: 2,
          stateStartedAt: 2
        }) as AgentStatusIpcPayload,
      setTimer: (run, delayMs) => {
        const timer = setTimeout(run, delayMs)
        return { cancel: () => clearTimeout(timer) }
      }
    })
    replies.observe(moved('turn-finished', 'done'))
    replies.observe(moved('prompt-submitted', 'working'))
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(noteTurn.mock.calls.map((call) => call[0].kind)).toEqual(['ack'])
    replies.observe(moved('needs-input', 'needs-you'))
    expect(noteTurn).toHaveBeenCalledTimes(1)
    state.waiting = true
    replies.observe(moved('needs-input', 'needs-you'))
    expect(noteTurn).toHaveBeenLastCalledWith({
      worktreeId: 'wt-1',
      kind: 'result',
      outcome: 'needs-user'
    })
    replies.dispose()
    vi.useRealTimers()
  })
})
