#!/usr/bin/env node
/**
 * Test driver: boot the pacing Loader composition, register a scripted model
 * adapter whose first request fails with a rate limit, and let automatic pacing
 * resume the run. The observed model-visible text and the adapter's request
 * count land in `./supervisor-pacing-loader-report.json` for the spec.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('supervisor pacing driver requires a config path')

type ScriptEntry = StreamChunk[] | Error

/** Adapter whose every request is scripted: a failure, then a text response. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry instanceof Error) throw entry
    for (const chunk of entry) yield chunk
  }
}

/** One successful text response. */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const ctx = await boot('supervisor-pacing-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  const adapter = new ScriptedAdapter([
    new LlmError('slow down', 'RATE_LIMIT', { providerRetryAfterMs: 1 }),
    textResponse('resumed'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)

  const notices: string[] = []
  ctx.on('agent/inbox/inserted', ({ message }) => {
    for (const block of message.content) {
      if (block.type === 'text') notices.push(block.text)
    }
  })

  const agent = await ctx.agentLoop.create(SessionId('pacing-loader-agent'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do the work' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  const deadline = Date.now() + 30_000
  while (notices.every(text => !text.startsWith('[pacing]')) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  while (adapter.requests.length < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  await writeFile('./supervisor-pacing-loader-report.json', JSON.stringify({
    notice: notices.find(text => text.startsWith('[pacing]')) ?? '',
    notices: notices.length,
    requests: adapter.requests.length,
    messages: adapter.requests.at(-1)?.messages.flatMap(message => message.content)
      .flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n') ?? '',
  }))
} finally {
  await ctx.fiber.dispose()
}
