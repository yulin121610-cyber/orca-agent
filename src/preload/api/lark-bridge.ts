import { ipcRenderer } from 'electron'
import type { LarkBotConfig } from '../../shared/lark/lark-bot-config'
import { LARK_TASKS_CHANGED_CHANNEL } from '../../shared/lark/lark-snapshot'
import type { LarkApi } from './lark-api'

export const larkApi: LarkApi = {
  snapshot: () => ipcRenderer.invoke('lark:snapshot'),
  saveConfig: (config: LarkBotConfig) => ipcRenderer.invoke('lark:saveConfig', config),
  onTasksChanged: (listener) => {
    const wrapped = (): void => listener()
    ipcRenderer.on(LARK_TASKS_CHANGED_CHANNEL, wrapped)
    return () => ipcRenderer.removeListener(LARK_TASKS_CHANGED_CHANNEL, wrapped)
  }
}
