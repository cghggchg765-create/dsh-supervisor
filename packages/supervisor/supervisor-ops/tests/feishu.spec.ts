import { describe, expect, it } from 'vitest'
import {
  ChatBridge,
  parseCommand,
  renderNotification,
  type ChatCommand,
  type ChatMessage,
  type ChatTransport,
} from '../src/feishu.ts'

/** Transport double: records outbound messages and lets a test deliver inbound ones. */
class FakeTransport implements ChatTransport {
  readonly sent: { chatId: string; text: string }[] = []
  /** When true, `send` rejects, standing in for a disconnected bot. */
  rejectSends = false
  /** How many times a disposer unsubscribed. */
  unsubscribeCount = 0
  private handler: ((message: ChatMessage) => void) | undefined

  send(chatId: string, text: string): Promise<void> {
    if (this.rejectSends) return Promise.reject(new Error('transport offline'))
    this.sent.push({ chatId, text })
    return Promise.resolve()
  }

  onMessage(handler: (message: ChatMessage) => void): () => void {
    this.handler = handler
    return () => {
      this.unsubscribeCount += 1
      this.handler = undefined
    }
  }

  /** Deliver one inbound message to the current subscriber. */
  deliver(message: ChatMessage): void {
    this.handler?.(message)
  }
}

/** One inbound message fixture. */
function inbound(text: string): ChatMessage {
  return { id: `msg-${text}`, chatId: 'chat-1', senderId: 'user-1', text, receivedAt: 1_000 }
}

describe('command parsing', () => {
  it('reads a run command and its trimmed argument', () => {
    expect(parseCommand('/run build the feature')).toEqual({ command: 'run', argument: 'build the feature' })
    expect(parseCommand('/RUN  ship   it  ')).toEqual({ command: 'run', argument: 'ship   it' })
  })

  it('accepts every command with or without the leading slash', () => {
    expect(parseCommand('/status')).toEqual({ command: 'status', argument: '' })
    expect(parseCommand('status')).toEqual({ command: 'status', argument: '' })
    expect(parseCommand('/stop')).toEqual({ command: 'stop', argument: '' })
    expect(parseCommand('/shutdown')).toEqual({ command: 'shutdown', argument: '' })
    expect(parseCommand('/help')).toEqual({ command: 'help', argument: '' })
    expect(parseCommand('/status now')).toEqual({ command: 'status', argument: 'now' })
  })

  it('treats plain text as chat and preserves it verbatim', () => {
    expect(parseCommand('  what is the status?  ')).toEqual({ command: 'chat', argument: '  what is the status?  ' })
  })

  it('treats an unknown slash command as chat and preserves it', () => {
    expect(parseCommand('/frobnicate now')).toEqual({ command: 'chat', argument: '/frobnicate now' })
    expect(parseCommand('/')).toEqual({ command: 'chat', argument: '/' })
  })
})

describe('notification rendering', () => {
  it('names the event and the task id on one line', () => {
    expect(renderNotification('task-completed', { taskId: 'task-a' })).toBe('[supervisor] task-completed: task-a')
  })

  it('adds the detail on a second line', () => {
    expect(renderNotification('task-completed', { taskId: 'task-a', detail: 'deliverable written' }))
      .toBe('[supervisor] task-completed: task-a\ndeliverable written')
  })

  it('renders an event that carries neither task id nor detail on one line', () => {
    expect(renderNotification('budget-alert', {})).toBe('[supervisor] budget-alert')
    expect(renderNotification('budget-alert', { detail: 'daily budget reached' }))
      .toBe('[supervisor] budget-alert\ndaily budget reached')
  })
})

describe('chat bridge', () => {
  it('routes every inbound message to the handler with its parsed command', () => {
    const transport = new FakeTransport()
    const seen: { message: ChatMessage; command: { command: ChatCommand; argument: string } }[] = []
    const bridge = new ChatBridge(transport, (message, command) => { seen.push({ message, command }) })
    bridge.start()
    const message = inbound('/run ship it')
    transport.deliver(message)
    expect(seen).toEqual([{ message, command: { command: 'run', argument: 'ship it' } }])
  })

  it('unsubscribes exactly once when the returned disposer is called again', () => {
    const transport = new FakeTransport()
    const bridge = new ChatBridge(transport, () => {})
    const dispose = bridge.start()
    dispose()
    dispose()
    expect(transport.unsubscribeCount).toBe(1)
  })

  it('sends a message and reports the transport acceptance', async () => {
    const transport = new FakeTransport()
    const bridge = new ChatBridge(transport, () => {})
    expect(await bridge.notify('chat-1', 'hello')).toBe(true)
    expect(transport.sent).toEqual([{ chatId: 'chat-1', text: 'hello' }])
  })

  it('reports false when the transport rejects the send', async () => {
    const transport = new FakeTransport()
    transport.rejectSends = true
    const bridge = new ChatBridge(transport, () => {})
    expect(await bridge.notify('chat-1', 'hello')).toBe(false)
    expect(transport.sent).toEqual([])
  })

  it('renders an event notification before sending it', async () => {
    const transport = new FakeTransport()
    const bridge = new ChatBridge(transport, () => {})
    expect(await bridge.notifyEvent('chat-1', 'checkpoint-taken', { taskId: 'task-a' })).toBe(true)
    expect(transport.sent).toEqual([{ chatId: 'chat-1', text: '[supervisor] checkpoint-taken: task-a' }])
    transport.rejectSends = true
    expect(await bridge.notifyEvent('chat-1', 'task-abnormal', {})).toBe(false)
  })
})
