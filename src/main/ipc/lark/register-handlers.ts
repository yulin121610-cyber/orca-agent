import { app, ipcMain } from 'electron'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentPaneChange } from '../../agent-hooks/agent-transition-detector'
import { getLarkTaskService } from '../../lark/lark-task-service'
import { LarkTaskReplies } from '../../lark/lark-task-replies'

export type LarkAgentTransitions = {
  subscribe: (listener: (change: AgentPaneChange) => void) => () => void
  latestRow: (paneKey: string) => AgentStatusIpcPayload | null
}

let registered = false

export function registerLarkHandlers(transitions?: LarkAgentTransitions): void {
  if (registered) {
    return
  }
  registered = true
  const service = getLarkTaskService()
  ipcMain.handle('lark:snapshot', () => service.snapshot())
  ipcMain.handle('lark:saveConfig', (_event, raw: unknown) => service.saveConfig(raw))
  ipcMain.handle('lark:bindWorkspace', (_event, raw: unknown) => {
    const body = raw as { taskId?: unknown; worktreeId?: unknown }
    return service.bindWorkspace(String(body?.taskId ?? ''), String(body?.worktreeId ?? ''))
  })
  void service.start()
  if (transitions) {
    const replies = new LarkTaskReplies({
      noteTurn: (note) => service.noteTurn(note),
      readRow: (paneKey) => transitions.latestRow(paneKey),
      setTimer: (run, delayMs) => {
        const timer = setTimeout(run, delayMs)
        timer.unref?.()
        return { cancel: () => clearTimeout(timer) }
      }
    })
    transitions.subscribe((change) => replies.observe(change))
    app.on('before-quit', () => replies.dispose())
  }
  app.on('before-quit', () => {
    void service.shutdown()
  })
}
