let armedTaskId: string | null = null

export function armLarkTaskStart(taskId: string): void {
  armedTaskId = taskId
}

export function takeLarkTaskStart(): string | null {
  const taskId = armedTaskId
  armedTaskId = null
  return taskId
}

export function clearLarkTaskStart(): void {
  armedTaskId = null
}

export async function bindLarkTaskWorkspace(
  taskId: string | undefined,
  worktreeId: string
): Promise<void> {
  if (!taskId || !window.api?.lark) {
    return
  }
  await window.api.lark.bindWorkspace({ taskId, worktreeId }).catch(() => {})
}
