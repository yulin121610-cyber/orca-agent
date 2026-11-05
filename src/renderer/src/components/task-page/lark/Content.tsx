import { useEffect, useState } from 'react'
import { Bot, ExternalLink, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { openAppHttpLink } from '@/lib/app-http-link-open'
import {
  buildLarkTaskLaunchDraft,
  larkTaskWorkspaceSeed
} from '../../../../../shared/lark/lark-task-draft'
import type { LarkTask } from '../../../../../shared/lark/lark-task'
import type { LarkSourceSnapshot } from '../../../../../shared/lark/lark-snapshot'
import { armLarkTaskStart } from '@/lib/lark-task-start'
import { useAppStore } from '@/store'

export function TaskPageLarkContent(): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const [snapshot, setSnapshot] = useState<LarkSourceSnapshot | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const lark = window.api?.lark
    if (!lark) {
      setFailed(true)
      return
    }
    let cancelled = false
    const apply = (next: LarkSourceSnapshot): void => {
      if (!cancelled) {
        setSnapshot(next)
        setFailed(false)
      }
    }
    void lark
      .snapshot()
      .then(apply)
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
        }
      })
    const unsubscribe = lark.onTasksChanged(() => {
      void lark
        .snapshot()
        .then(apply)
        .catch(() => {})
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  if (!snapshot && !failed) {
    return (
      <div className="mt-4 flex items-center justify-center py-14">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const connected = Boolean(
    snapshot?.config?.enabled && snapshot.identity && snapshot.state !== 'error'
  )
  const tasks = snapshot?.tasks ?? []
  const selected = tasks.find((task) => task.id === selectedId) ?? null

  if (!snapshot || (!connected && tasks.length === 0)) {
    return (
      <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
        <Bot className="mb-4 size-8 text-muted-foreground/60" />
        <p className="text-base font-medium text-foreground">
          {translate('taskPage.lark.connectTitle', 'Connect a Lark bot')}
        </p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {snapshot?.error
            ? snapshot.error
            : failed
              ? translate('taskPage.lark.loadFailed', 'Lark tasks could not be loaded.')
              : translate(
                  'taskPage.lark.connectBody',
                  'Add a bot-only Lark CLI, the groups to watch, and who may assign work. Messages that @ the bot show up here.'
                )}
        </p>
        <Button
          className="mt-5"
          onClick={() => {
            openSettingsPage()
            openSettingsTarget({ pane: 'tasks', repoId: null })
          }}
        >
          {translate('taskPage.lark.openSettings', 'Set up Lark')}
        </Button>
      </div>
    )
  }

  if (selected) {
    return (
      <LarkTaskDetail
        task={selected}
        onBack={() => setSelectedId(null)}
        onStart={() => {
          armLarkTaskStart(task.id)
          openModal('new-workspace-composer', {
            prefilledName: larkTaskWorkspaceSeed(selected.title),
            launchDraftPrompt: buildLarkTaskLaunchDraft(selected),
            telemetrySource: 'sidebar'
          })
        }}
      />
    )
  }

  return (
    <div className="mt-3 flex min-h-0 flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
      <div className="flex min-h-10 items-center justify-between border-b border-border/50 bg-muted/35 px-3 py-1">
        <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {translate('taskPage.lark.listTitle', 'Lark tasks')}
        </div>
        <span className="text-2xs text-muted-foreground">
          {snapshot.error ??
            (snapshot.state === 'listening'
              ? translate('taskPage.lark.listening', 'Listening')
              : translate('taskPage.lark.notListening', 'Not listening'))}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">
          {translate(
            'taskPage.lark.empty',
            'No Lark tasks yet. In a configured group, @ the bot with the request. Later messages in that thread attach to the same task.'
          )}
        </p>
      ) : (
        <ul className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
          {tasks.toReversed().map((task) => (
            <li key={task.id} className="border-b border-border/40 last:border-b-0">
              <button
                type="button"
                className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/40"
                onClick={() => setSelectedId(task.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{task.title}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {task.bot.chatId}
                  </span>
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {formatTime(task.importedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function LarkTaskDetail({
  task,
  onBack,
  onStart
}: {
  task: LarkTask
  onBack: () => void
  onStart: () => void
}): React.JSX.Element {
  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          {translate('taskPage.lark.back', 'Lark tasks')}
        </Button>
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {task.title}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={(event) => openAppHttpLink(task.url, { event })}
        >
          <ExternalLink className="size-3.5" />
          {translate('taskPage.lark.openChat', 'Open in Lark')}
        </Button>
        <Button type="button" size="sm" onClick={onStart}>
          {translate('taskPage.lark.startWork', 'Start work')}
        </Button>
      </div>
      <pre className="scrollbar-sleek min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 font-sans text-sm text-foreground">
        {task.description}
      </pre>
    </div>
  )
}

function formatTime(value: string): string {
  const time = Date.parse(value)
  if (Number.isNaN(time)) {
    return ''
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(time)
}
