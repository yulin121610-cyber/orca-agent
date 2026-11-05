export type LarkEventSession = {
  stdout: AsyncIterable<Buffer | string>
  stderr: NodeJS.EventEmitter
  closed: Promise<void>
  stop: () => void
  failOnStreamError: (fail: () => void) => void
}
