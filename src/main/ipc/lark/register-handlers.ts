import { app, ipcMain } from 'electron'
import { getLarkTaskService } from '../../lark/lark-task-service'

let registered = false

export function registerLarkHandlers(): void {
  if (registered) {
    return
  }
  registered = true
  const service = getLarkTaskService()
  ipcMain.handle('lark:snapshot', () => service.snapshot())
  ipcMain.handle('lark:saveConfig', (_event, raw: unknown) => service.saveConfig(raw))
  void service.start()
  app.on('before-quit', () => {
    void service.shutdown()
  })
}
