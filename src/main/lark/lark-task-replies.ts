import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { agentMainAgentVerdict } from '../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import { AGENT_DONE_QUIET_MS } from '../../shared/agent-status/lifecycle/agent-transitions'
import type { LarkReplyOutcome } from '../../shared/lark/lark-thread-reply'
import type { LarkTaskService } from './lark-task-service'

export type LarkTaskReplyDeps = {
  noteTurn: LarkTaskService['noteTurn']
  readRow: (paneKey: string) => AgentStatusIpcPayload | null
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
}

/** One ack when work starts, one thread reply when that turn finishes. Later turns stay quiet. */
export class LarkTaskReplies {
  private readonly pending = new Map<string, { cancel: () => void }>()

  constructor(private readonly deps: LarkTaskReplyDeps) {}

  observe(change: AgentPaneChange): void {
    if (change.kind !== 'moved') {
      return
    }
    const worktreeId = change.workspace.worktreeId
    if (change.transition === 'prompt-submitted') {
      this.cancel(worktreeId)
      void this.deps.noteTurn({ worktreeId, kind: 'ack' })
      return
    }
    if (change.to === 'working') {
      this.cancel(worktreeId)
      return
    }
    if (change.transition === 'needs-input') {
      const row = this.deps.readRow(change.paneKey)
      if (row?.state !== 'waiting') {
        return
      }
      this.cancel(worktreeId)
      void this.finish(worktreeId, change.paneKey, 'needs-user')
      return
    }
    if (change.transition !== 'turn-finished' && change.transition !== 'errored') {
      return
    }
    this.cancel(worktreeId)
    const outcome: LarkReplyOutcome = change.transition === 'errored' ? 'failed' : 'success'
    const timer = this.deps.setTimer(() => {
      this.pending.delete(worktreeId)
      void this.finish(worktreeId, change.paneKey, outcome)
    }, AGENT_DONE_QUIET_MS)
    this.pending.set(worktreeId, timer)
  }

  dispose(): void {
    for (const worktreeId of this.pending.keys()) {
      this.cancel(worktreeId)
    }
  }

  private finish(worktreeId: string, paneKey: string, outcome: LarkReplyOutcome): void {
    const row = this.deps.readRow(paneKey)
    const verdict = row ? agentMainAgentVerdict(row) : null
    const settled =
      outcome === 'success' &&
      (verdict === 'failure' || verdict === 'interruption' || verdict === 'cancellation')
        ? 'failed'
        : outcome
    void this.deps.noteTurn({
      worktreeId,
      kind: 'result',
      outcome: settled,
      ...(row?.lastAssistantMessage ? { detail: row.lastAssistantMessage } : {})
    })
  }

  private cancel(worktreeId: string): void {
    this.pending.get(worktreeId)?.cancel()
    this.pending.delete(worktreeId)
  }
}
