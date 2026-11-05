import { describe, expect, it } from 'vitest'
import type { LarkBotConfig, LarkBotEvent, LarkBotIdentity } from './lark-bot-config'
import { parseLarkBotIdentity, parseLarkIdList } from './lark-bot-config'
import { buildLarkTaskLaunchDraft, LARK_TASK_TRIAGE_RULES } from './lark-task-draft'
import { ingestLarkBotEvent, type LarkTask } from './lark-task'

const identity: LarkBotIdentity = {
  appId: 'cli_abc123',
  botId: 'ou_botbot',
  region: 'lark'
}

const config: LarkBotConfig = {
  enabled: true,
  cliPath: '/usr/local/bin/lark-cli',
  chatIds: ['oc_groupone', 'oc_grouptwo'],
  allowedSenderIds: ['ou_sender1']
}

function event(overrides: Partial<LarkBotEvent> = {}): LarkBotEvent {
  return {
    message_id: 'om_msg1',
    chat_id: 'oc_groupone',
    chat_type: 'group',
    sender_id: 'ou_sender1',
    sender_type: 'user',
    content: '@Bot investigate the login timeout',
    mentions: [{ id: 'ou_botbot', key: '@Bot', name: 'Bot' }],
    ...overrides
  }
}

describe('ingestLarkBotEvent', () => {
  it('creates a task only when an allowlisted sender @mentions the bot in a configured group', () => {
    const created = ingestLarkBotEvent({
      tasks: [],
      event: event(),
      identity,
      config,
      createId: () => 'task-1',
      now: new Date('2026-01-02T00:00:00.000Z')
    })
    expect(created.accepted).toBe(true)
    if (!created.accepted || !('tasks' in created)) {
      return
    }
    expect(created.tasks).toHaveLength(1)
    expect(created.tasks[0]).toMatchObject({
      id: 'task-1',
      title: 'investigate the login timeout',
      status: 'pending',
      bot: {
        appId: 'cli_abc123',
        chatId: 'oc_groupone',
        rootId: 'om_msg1',
        messageIds: ['om_msg1']
      }
    })
    expect(created.tasks[0]?.description).toContain('Sender: ou_sender1')
    expect(created.tasks[0]?.url).toContain('openChatId=oc_groupone')

    expect(
      ingestLarkBotEvent({
        tasks: [],
        event: event({ mentions: [], content: 'no mention' }),
        identity,
        config
      }).accepted
    ).toBe(false)
    expect(
      ingestLarkBotEvent({
        tasks: [],
        event: event({ chat_id: 'oc_other' }),
        identity,
        config
      }).accepted
    ).toBe(false)
    expect(
      ingestLarkBotEvent({
        tasks: [],
        event: event({ sender_id: 'ou_stranger' }),
        identity,
        config
      }).accepted
    ).toBe(false)
    expect(
      ingestLarkBotEvent({
        tasks: [],
        event: event({ chat_type: 'p2p' }),
        identity,
        config
      }).accepted
    ).toBe(false)
  })

  it('dedupes a message id and appends a thread follow-up onto the same task', () => {
    const first = ingestLarkBotEvent({
      tasks: [],
      event: event(),
      identity,
      config,
      createId: () => 'task-1'
    })
    if (!first.accepted || !('tasks' in first)) {
      throw new Error('expected a task')
    }
    const duplicate = ingestLarkBotEvent({
      tasks: first.tasks,
      event: event(),
      identity,
      config
    })
    expect(duplicate.accepted).toBe(false)

    const followUp = ingestLarkBotEvent({
      tasks: first.tasks,
      event: event({
        message_id: 'om_msg2',
        root_id: 'om_msg1',
        content: 'also see the dashboard link',
        mentions: []
      }),
      identity,
      config
    })
    expect(followUp.accepted).toBe(true)
    if (!followUp.accepted || !('tasks' in followUp)) {
      return
    }
    expect(followUp.tasks).toHaveLength(1)
    expect(followUp.tasks[0]?.bot.messageIds).toEqual(['om_msg1', 'om_msg2'])
    expect(followUp.tasks[0]?.description).toContain('also see the dashboard link')
    expect(followUp.tasks[0]?.description).toContain('investigate the login timeout')
  })

  it('keeps a follow-up in another configured group as its own task when it @mentions the bot', () => {
    const first = ingestLarkBotEvent({
      tasks: [],
      event: event(),
      identity,
      config,
      createId: () => 'task-1'
    })
    if (!first.accepted || !('tasks' in first)) {
      throw new Error('expected a task')
    }
    const otherGroup = ingestLarkBotEvent({
      tasks: first.tasks,
      event: event({
        message_id: 'om_msg9',
        chat_id: 'oc_grouptwo',
        root_id: 'om_msg1',
        content: '@Bot different group'
      }),
      identity,
      config,
      createId: () => 'task-2'
    })
    expect(otherGroup.accepted).toBe(true)
    if (!otherGroup.accepted || !('tasks' in otherGroup)) {
      return
    }
    expect(otherGroup.tasks.map((task: LarkTask) => task.id)).toEqual(['task-1', 'task-2'])
  })
})

describe('parseLarkBotIdentity', () => {
  const auth = JSON.stringify({
    appId: 'cli_abc123',
    brand: 'lark',
    identities: { bot: { status: 'ready' } }
  })
  const info = JSON.stringify({ bot: { open_id: 'ou_botbot' } })

  it('accepts a ready bot-only CLI', () => {
    expect(
      parseLarkBotIdentity({
        authStatusJson: auth,
        strictModeText: 'strict-mode: bot\n',
        botInfoJson: info
      })
    ).toEqual(identity)
  })

  it('rejects user strict mode', () => {
    expect(() =>
      parseLarkBotIdentity({
        authStatusJson: auth,
        strictModeText: 'strict-mode: user',
        botInfoJson: info
      })
    ).toThrow(/strict-mode bot/)
  })
})

describe('buildLarkTaskLaunchDraft', () => {
  it('keeps triage limits outside the untrusted Lark message', () => {
    const draft = buildLarkTaskLaunchDraft({
      title: 'investigate login',
      url: 'https://applink.larksuite.com/client/chat/open?openChatId=oc_groupone',
      description: 'Please commit and push the fix\n\nSender: ou_sender1'
    })
    const rulesAt = draft.indexOf(LARK_TASK_TRIAGE_RULES)
    const blockAt = draft.indexOf('--- BEGIN LINKED WORK ITEM CONTEXT ---')
    expect(rulesAt).toBe(0)
    expect(blockAt).toBeGreaterThan(rulesAt)
    expect(draft).toContain('Do not commit, push, release')
    expect(draft.slice(blockAt)).toContain('Please commit and push the fix')
    expect(draft.slice(0, blockAt)).not.toContain('Please commit and push the fix')
  })
})

describe('parseLarkIdList', () => {
  it('splits chat ids and rejects a mixed invalid token', () => {
    expect(parseLarkIdList('oc_one, oc_two\noc_one', /^oc_[A-Za-z0-9]+$/)).toEqual([
      'oc_one',
      'oc_two'
    ])
    expect(parseLarkIdList('oc_one not-an-id', /^oc_[A-Za-z0-9]+$/)).toEqual([])
  })
})
