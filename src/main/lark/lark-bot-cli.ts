import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { runProcess, spawnProcess } from '@orca/process-host'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import { hostShellEnvironment } from '../runtime/structured-agent-shell-environment'
import { parseLarkBotIdentity, type LarkBotIdentity } from '../../shared/lark/lark-bot-config'
import {
  buildLarkThreadReplyArgs,
  classifyLarkReplyFailure,
  type LarkReplyFailure
} from '../../shared/lark/lark-thread-reply'
import type { LarkEventSession } from './lark-event-session'

const CLI_ENV_FLAGS = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1'
}

async function assertBotCli(program: string): Promise<void> {
  if (!isAbsolute(program)) {
    throw new Error('Use an absolute path to a bot-only Lark CLI.')
  }
  await access(program, constants.X_OK)
}

export async function resolveLarkBot(
  program: string,
  signal: AbortSignal
): Promise<LarkBotIdentity> {
  await assertBotCli(program)
  const env = { ...(await hostShellEnvironment()), ...CLI_ENV_FLAGS }
  async function probe(args: string[]): Promise<string> {
    const result = await runProcess({
      program,
      args,
      env,
      signal,
      timeoutMs: 45_000,
      maxOutputBytes: 1024 * 1024,
      killOnOutputLimit: true,
      terminationBarrier: true
    })
    if (signal.aborted || result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error('The bot CLI check failed. Check its installation and bot authorization.')
    }
    return result.stdout
  }
  return parseLarkBotIdentity({
    authStatusJson: await probe(['auth', 'status', '--json']),
    strictModeText: await probe(['config', 'strict-mode']),
    botInfoJson: await probe([
      'api',
      'GET',
      '/open-apis/bot/v3/info',
      '--as',
      'bot',
      '--format',
      'ndjson'
    ])
  })
}

export async function postLarkThreadReply(args: {
  program: string
  messageId: string
  markdown: string
  idempotencyKey: string
  signal?: AbortSignal
}): Promise<{ status: 'sent' } | { status: LarkReplyFailure }> {
  await assertBotCli(args.program)
  const env = { ...(await hostShellEnvironment()), ...CLI_ENV_FLAGS }
  const result = await runProcess({
    program: args.program,
    args: buildLarkThreadReplyArgs({
      messageId: args.messageId,
      markdown: args.markdown,
      idempotencyKey: args.idempotencyKey
    }),
    env,
    signal: args.signal,
    timeoutMs: 45_000,
    maxOutputBytes: 256 * 1024,
    killOnOutputLimit: true,
    terminationBarrier: true
  })
  if (result.code === 0 && !result.timedOut) {
    return { status: 'sent' }
  }
  return { status: classifyLarkReplyFailure(`${result.stdout}\n${result.stderr}`) }
}

export async function openLarkEventSession(
  program: string,
  signal: AbortSignal
): Promise<LarkEventSession> {
  if (signal.aborted) {
    throw new Error('The Lark bot listener is shutting down.')
  }
  await assertBotCli(program)
  const env = { ...(await hostShellEnvironment()), ...CLI_ENV_FLAGS }
  const child = spawnProcess({
    program,
    args: ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'],
    env,
    detached: process.platform !== 'win32',
    stdio: 'pipe'
  })
  const abortChild = (): void => {
    void forceTerminateProcessTree(child).catch(() => false)
  }
  signal.addEventListener('abort', abortChild, { once: true })
  const stdout = child.stdout
  const stderr = child.stderr
  if (!stdout || !stderr) {
    void forceTerminateProcessTree(child).catch(() => false)
    throw new Error('The Lark bot event process could not start.')
  }
  return {
    stdout,
    stderr,
    closed: new Promise((resolve) => child.once('close', () => resolve())),
    stop: () => {
      void forceTerminateProcessTree(child).catch(() => false)
    },
    failOnStreamError: (fail) => {
      for (const stream of [child.stdin, stdout, stderr]) {
        stream?.on('error', () => fail())
      }
      child.on('error', () => fail())
    }
  }
}
