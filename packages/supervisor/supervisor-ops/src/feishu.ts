/**
 * Chat seam for the supervisor. The plugin owns message routing — which command
 * an inbound message carries, which events go out — and the deployment owns the
 * wire through {@link ChatTransport}. A bot adapter (the Feishu SDK in the
 * shipped deployment) implements the transport; this module imports none, so
 * tests and alternate deployments drive it with their own transport.
 * @module @deepseek-ai/dsh-supervisor-ops/feishu
 */

/** One inbound chat message. */
export interface ChatMessage {
  /** Transport-assigned message id. */
  id: string
  /** Conversation the message arrived in. */
  chatId: string
  /** Sender identity. */
  senderId: string
  /** Message text, trimmed. */
  text: string
  /** Epoch milliseconds the message arrived. */
  receivedAt: number
}

/** The chat provider seam: the plugin owns routing, the deployment owns the wire. */
export interface ChatTransport {
  /** Deliver one message to a conversation. */
  send(chatId: string, text: string): Promise<void>
  /** Subscribe to inbound messages; returns the disposer. */
  onMessage(handler: (message: ChatMessage) => void): () => void
}

/** Command an inbound message carries. */
export type ChatCommand = 'run' | 'status' | 'stop' | 'shutdown' | 'help' | 'chat'

/** Command words recognized after an optional leading slash. */
const COMMANDS: readonly ChatCommand[] = ['run', 'status', 'stop', 'shutdown', 'help']

/** Prefix that marks a message as a command rather than plain chat. */
const COMMAND_PREFIX = '/'

/**
 * Parse one inbound message into a command and its argument.
 * @param text - inbound message text, e.g. `/run ship the feature`.
 * @returns the command and the remainder trimmed; a message that names no
 * known command is `chat` with the original text as its argument.
 */
export function parseCommand(text: string): { command: ChatCommand; argument: string } {
  const trimmed = text.trim()
  const body = trimmed.startsWith(COMMAND_PREFIX) ? trimmed.slice(COMMAND_PREFIX.length) : trimmed
  const separator = body.search(/\s/)
  const word = (separator === -1 ? body : body.slice(0, separator)).toLowerCase()
  const argument = separator === -1 ? '' : body.slice(separator + 1).trim()
  const command = COMMANDS.find(candidate => candidate === word)
  return command === undefined ? { command: 'chat', argument: text } : { command, argument }
}

/** Events the supervisor pushes to a conversation. */
export type NotifyEvent = 'task-completed' | 'task-abnormal' | 'budget-alert' | 'checkpoint-taken' | 'limit-paused'

/**
 * Render one notification.
 * @param event - event the supervisor pushes.
 * @param payload - task id and detail, when the event carries them.
 * @returns one line naming the event and the task id when present, with the
 * detail on a second line when present.
 */
export function renderNotification(event: NotifyEvent, payload: { taskId?: string; detail?: string }): string {
  const head = payload.taskId === undefined ? `[supervisor] ${event}` : `[supervisor] ${event}: ${payload.taskId}`
  return payload.detail === undefined ? head : `${head}\n${payload.detail}`
}

/** Routes inbound chat messages to a handler and pushes notifications out. */
export class ChatBridge {
  /**
   * @param transport - deployment-provided chat provider.
   * @param handler - receives every parsed inbound message.
   */
  constructor(
    private readonly transport: ChatTransport,
    private readonly handler: (message: ChatMessage, command: { command: ChatCommand; argument: string }) => void,
  ) {}

  /**
   * Subscribe to the transport; returns the disposer that unsubscribes.
   * @returns a disposer that unsubscribes once; later calls do nothing.
   */
  start(): () => void {
    const unsubscribe = this.transport.onMessage((message) => {
      this.handler(message, parseCommand(message.text))
    })
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      unsubscribe()
    }
  }

  /**
   * Send one message; false when the transport rejected it.
   * @param chatId - conversation to send to.
   * @param text - message text.
   * @returns true when the transport accepted the message.
   */
  async notify(chatId: string, text: string): Promise<boolean> {
    try {
      await this.transport.send(chatId, text)
      return true
    } catch {
      // A rejected send is reported as false so a disconnected transport
      // cannot fail the supervisor step that merely wanted to notify.
      return false
    }
  }

  /**
   * Render and send one event notification; false when the transport rejected it.
   * @param chatId - conversation to send to.
   * @param event - event to render.
   * @param payload - task id and detail, when the event carries them.
   * @returns true when the transport accepted the message.
   */
  async notifyEvent(chatId: string, event: NotifyEvent, payload: { taskId?: string; detail?: string }): Promise<boolean> {
    return this.notify(chatId, renderNotification(event, payload))
  }
}
