import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { parseLarkIdList, type LarkBotConfig } from '../../../../../shared/lark/lark-bot-config'
import type { LarkSourceSnapshot } from '../../../../../shared/lark/lark-snapshot'
import { TaskSourceShowInTasksStep } from './TaskSourceShowInTasksStep'
import { TaskSourceStepRow } from './TaskSourceStepRow'

type TaskSourceLarkSetupProps = {
  visible: boolean
  canHide: boolean
  connected: boolean
  checking: boolean
  onToggleVisible: () => void
}

const CHAT_ID = /^oc_[A-Za-z0-9]+$/
const SENDER_ID = /^ou_[A-Za-z0-9]+$/

export function TaskSourceLarkSetup(props: TaskSourceLarkSetupProps): React.JSX.Element {
  const [cliPath, setCliPath] = useState('')
  const [chatIds, setChatIds] = useState('')
  const [senderIds, setSenderIds] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const lark = window.api?.lark
    if (!lark) {
      return
    }
    let cancelled = false
    const apply = (snapshot: LarkSourceSnapshot): void => {
      if (cancelled || !snapshot.config) {
        return
      }
      setCliPath(snapshot.config.cliPath)
      setChatIds(snapshot.config.chatIds.join('\n'))
      setSenderIds(snapshot.config.allowedSenderIds.join('\n'))
      setEnabled(snapshot.config.enabled)
      setStatus(snapshot.error ?? listenerStatus(snapshot))
    }
    void lark
      .snapshot()
      .then(apply)
      .catch(() => {})
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

  const save = (): void => {
    const parsedChats = parseLarkIdList(chatIds, CHAT_ID)
    const parsedSenders = parseLarkIdList(senderIds, SENDER_ID)
    if (!cliPath.trim()) {
      setError(
        translate('settings.tasks.lark.cliRequired', 'Enter the absolute path to the bot CLI.')
      )
      return
    }
    if (parsedChats.length === 0 || parsedSenders.length === 0) {
      setError(
        translate(
          'settings.tasks.lark.invalidIds',
          'Group IDs must look like oc_… and sender IDs must look like ou_….'
        )
      )
      return
    }
    const config: LarkBotConfig = {
      enabled,
      cliPath: cliPath.trim(),
      chatIds: parsedChats,
      allowedSenderIds: parsedSenders
    }
    setSaving(true)
    setError(null)
    void window.api.lark
      .saveConfig(config)
      .then((result) => {
        if (!result.ok) {
          setError(result.error)
          return
        }
        setStatus(result.snapshot.error ?? listenerStatus(result.snapshot))
      })
      .catch(() => {
        setError(
          translate('settings.tasks.lark.saveFailed', 'Could not save the Lark bot connection.')
        )
      })
      .finally(() => setSaving(false))
  }

  return (
    <ol className="divide-y divide-border/50">
      <TaskSourceStepRow
        index={1}
        state={props.checking ? 'in-progress' : props.connected ? 'done' : 'pending'}
        title={translate('settings.tasks.lark.connectTitle', 'Connect a Lark bot')}
        description={translate(
          'settings.tasks.lark.connectDescription',
          'Point at a bot-only Lark CLI that is already authorized. Orca does not copy the bot credential. New tasks come from @bot messages in the groups below; thread replies stay on the same task. When work starts and when that turn finishes, Orca replies in the original thread.'
        )}
      >
        <div className="mt-3 space-y-2">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">
              {translate('settings.tasks.lark.cliPath', 'Bot CLI path')}
            </span>
            <Input
              value={cliPath}
              onChange={(event) => setCliPath(event.target.value)}
              placeholder="/absolute/path/to/lark-cli"
              spellCheck={false}
              className="h-8 font-mono text-xs"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">
              {translate('settings.tasks.lark.chatIds', 'Group IDs')}
            </span>
            <Textarea
              value={chatIds}
              onChange={(event) => setChatIds(event.target.value)}
              placeholder="oc_…"
              spellCheck={false}
              className="min-h-16 font-mono text-xs"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">
              {translate('settings.tasks.lark.senderIds', 'Allowed sender IDs')}
            </span>
            <Textarea
              value={senderIds}
              onChange={(event) => setSenderIds(event.target.value)}
              placeholder="ou_…"
              spellCheck={false}
              className="min-h-16 font-mono text-xs"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-foreground">
            <Checkbox checked={enabled} onCheckedChange={(value) => setEnabled(value === true)} />
            {translate('settings.tasks.lark.listen', 'Listen for @bot messages')}
          </label>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
          <Button type="button" size="sm" disabled={saving} onClick={save}>
            {saving
              ? translate('settings.tasks.lark.saving', 'Checking bot…')
              : translate('settings.tasks.lark.save', 'Save Lark connection')}
          </Button>
        </div>
      </TaskSourceStepRow>
      <TaskSourceShowInTasksStep
        index={2}
        providerLabel={translate('settings.tasks.lark.name', 'Lark')}
        visible={props.visible}
        canHide={props.canHide}
        onToggleVisible={props.onToggleVisible}
      />
    </ol>
  )
}

function listenerStatus(snapshot: LarkSourceSnapshot): string | null {
  if (!snapshot.config) {
    return null
  }
  if (!snapshot.config.enabled) {
    return translate('settings.tasks.lark.stopped', 'Listening is off. Saved tasks stay in Tasks.')
  }
  if (snapshot.state === 'listening') {
    const who = snapshot.identity?.appId
    return who
      ? translate('settings.tasks.lark.listeningAs', 'Listening as {{appId}}.', { appId: who })
      : translate('settings.tasks.lark.listening', 'Listening.')
  }
  if (snapshot.state === 'starting' || snapshot.state === 'reconnecting') {
    return translate('settings.tasks.lark.connecting', 'Connecting to the Lark bot…')
  }
  return null
}
