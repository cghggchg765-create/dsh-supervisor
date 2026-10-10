import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HeartbeatStore, sanitize } from '../src/heartbeat.ts'
import { SpillLog } from '../src/spill.ts'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('heartbeat records', () => {
  it('reports a terminal with no output as fresh until it is touched', async () => {
    const store = new HeartbeatStore(join(root, 'heartbeat'), 30)
    expect(await store.read('pty-1')).toBeUndefined()
    const record = await store.touch('pty-1', 'stdin_read', 5_000)
    expect(record.lastOutputAt).toBe(5_000)
    expect(store.isStale(record, 34_999)).toBe(false)
    expect(store.isStale(record, 35_000)).toBe(true)
  })

  it('keeps the newest observation time when an older one arrives late', async () => {
    const store = new HeartbeatStore(join(root, 'heartbeat'), 30)
    await store.touch('pty-1', 'stdin_read', 9_000)
    const record = await store.touch('pty-1', 'timeout', 1_000)
    expect(record.lastOutputAt).toBe(9_000)
    expect(record.lastWaitReason).toBe('timeout')
  })

  it('counts consecutive stale passes and clears the count once output resumes', async () => {
    const store = new HeartbeatStore(join(root, 'heartbeat'), 30)
    let record = await store.touch('pty-1', 'stdin_read', 0)
    record = await store.recordCheck(record, true)
    expect(record.consecutiveStaleChecks).toBe(1)
    record = await store.recordCheck(record, true)
    expect(record.consecutiveStaleChecks).toBe(2)
    record = await store.recordCheck(record, false)
    expect(record.consecutiveStaleChecks).toBe(0)
  })

  it('lists every supervised terminal and forgets a closed one', async () => {
    const store = new HeartbeatStore(join(root, 'heartbeat'), 30)
    await store.touch('pty-1', 'stdin_read', 0)
    await store.touch('pty-2', 'timeout', 0)
    expect((await store.list()).map(record => record.sessionId).sort()).toEqual(['pty-1', 'pty-2'])
    await store.remove('pty-1')
    expect((await store.list()).map(record => record.sessionId)).toEqual(['pty-2'])
  })

  it('treats a malformed record as absent rather than failing the caller', async () => {
    const directory = join(root, 'heartbeat')
    const store = new HeartbeatStore(directory, 30)
    await store.touch('pty-1', 'stdin_read', 0)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(directory, 'pty-1.json'), '{ not json', 'utf8')
    expect(await store.read('pty-1')).toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('lists nothing before a terminal is supervised', async () => {
    const store = new HeartbeatStore(join(root, 'heartbeat'), 30)
    expect(await store.list()).toEqual([])
  })

  it('skips files that are not heartbeat records when listing', async () => {
    const directory = join(root, 'heartbeat')
    const store = new HeartbeatStore(directory, 30)
    await store.touch('pty-1', 'stdin_read', 0)
    await writeFile(join(directory, 'notes.txt'), 'not a heartbeat', 'utf8')
    expect((await store.list()).map(record => record.sessionId)).toEqual(['pty-1'])
  })

  it('surfaces an unreadable heartbeat file instead of reporting it absent', async () => {
    const directory = join(root, 'heartbeat')
    const store = new HeartbeatStore(directory, 30)
    await mkdir(join(directory, 'pty-1.json'), { recursive: true })
    await expect(store.read('pty-1')).rejects.toThrow()
    await expect(store.list()).rejects.toThrow()
  })

  it('surfaces a heartbeat path that cannot be scanned', async () => {
    const path = join(root, 'heartbeat')
    await writeFile(path, 'this is a file, not a directory', 'utf8')
    const store = new HeartbeatStore(path, 30)
    await expect(store.list()).rejects.toThrow()
  })
})

describe('path-segment sanitizing', () => {
  it('keeps safe ids unchanged', () => {
    expect(sanitize('pty-1.2_3')).toBe('pty-1.2_3')
  })

  it('removes separators so a hostile id stays one path segment', () => {
    const sanitized = sanitize('../../etc/passwd')
    expect(sanitized).not.toContain('/')
    expect(sanitized).not.toContain('\\')
    expect(sanitize('a/b\\c')).toBe('a_b_c')
  })

  it('never yields a bare dot segment', () => {
    expect(sanitize('..')).toBe('_')
    expect(sanitize('.')).toBe('_')
  })

  it('bounds an over-long id and strips the leading dot run of a hidden name', () => {
    expect(sanitize('a'.repeat(200))).toHaveLength(120)
    expect(sanitize('.hidden')).toBe('_hidden')
  })
})

describe('spill logs', () => {
  it('appends observed output under a task scope and reads the tail back', async () => {
    const log = new SpillLog(join(root, 'spill'), true, 1024 * 1024)
    const first = await log.append('pty-1', 'task-a', 'line one')
    expect(first.written).toBe(true)
    await log.append('pty-1', 'task-a', 'line two')
    const tail = await log.readTail(first.path, 1024 * 1024)
    expect(tail).toContain('line one')
    expect(tail).toContain('line two')
    expect(first.path).toContain('task-a')
  })

  it('scopes an unbound terminal under the fallback directory', async () => {
    const log = new SpillLog(join(root, 'spill'), true, 1024)
    const result = await log.append('pty-1', undefined, 'x')
    expect(result.path).toContain('_unbound')
  })

  it('stops recording once the byte cap is reached', async () => {
    const log = new SpillLog(join(root, 'spill'), true, 10)
    const result = await log.append('pty-1', undefined, 'y'.repeat(64))
    expect(result.capped).toBe(true)
    const second = await log.append('pty-1', undefined, 'more')
    expect(second.written).toBe(false)
    expect(second.capped).toBe(true)
  })

  it('writes nothing when spill is disabled and reports a missing log as absent', async () => {
    const log = new SpillLog(join(root, 'spill'), false, 1024)
    const result = await log.append('pty-1', undefined, 'ignored')
    expect(result).toEqual({ path: result.path, written: false, capped: false })
    expect(await log.readTail(join(root, 'spill', 'missing.log'), 10)).toBeUndefined()
  })

  it('exposes the log path a terminal would use without creating it', () => {
    const log = new SpillLog(join(root, 'spill'), true, 1024)
    expect(log.pathFor('pty-1', 'task-a')).toBe(join(root, 'spill', 'task-a', 'pty-1.log'))
    expect(log.pathFor('pty-1', '')).toBe(join(root, 'spill', '_unbound', 'pty-1.log'))
    expect(log.pathFor('pty-1')).toBe(join(root, 'spill', '_unbound', 'pty-1.log'))
  })

  it('writes nothing for an empty settlement', async () => {
    const log = new SpillLog(join(root, 'spill'), true, 1024)
    const result = await log.append('pty-1', 'task-a', '')
    expect(result).toEqual({ path: result.path, written: false, capped: false })
    expect(await log.readTail(result.path, 10)).toBeUndefined()
  })

  it('returns an empty tail for an existing empty log', async () => {
    const log = new SpillLog(join(root, 'spill'), true, 1024)
    const { path } = await log.append('pty-1', 'task-a', 'later removed by the cap')
    await rm(path)
    await writeFile(path, '', 'utf8')
    expect(await log.readTail(path, 10)).toBe('')
  })

  it('returns only the bounded tail of a log larger than that bound', async () => {
    const log = new SpillLog(join(root, 'spill'), true, 1024 * 1024)
    const { path } = await log.append('pty-1', 'task-a', 'x'.repeat(500))
    expect(await log.readTail(path, 10)).toHaveLength(10)
  })

  it('surfaces a log path that cannot be read instead of reporting it missing', async () => {
    const path = join(root, 'spill', 'pty-1.log')
    await mkdir(path, { recursive: true })
    const log = new SpillLog(join(root, 'spill'), true, 1024)
    await expect(log.readTail(path, 10)).rejects.toThrow()
  })

  it('surfaces a filesystem error other than a missing log', async () => {
    const log = new SpillLog('bad\u0000root', true, 1024)
    await expect(log.append('pty-1', undefined, 'x')).rejects.toThrow()
  })
})
