// Persistence of the transcript index (audit #7). Only the path-explicit helpers are exercised:
// `initTranscriptIndex` walks the real ~/.claude/projects, which a unit test must never read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { loadPersistedIndex, persistIndex } from './transcript-index'
import type { TranscriptIndexEntry } from './transcript-index-core'

const entry = (id: string, text: string): TranscriptIndexEntry => ({
  sessionId: id,
  transcriptPath: `/p/${id}.jsonl`,
  cwd: '/c',
  mtime: 1,
  title: id,
  text
})

function errWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code })
}

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nt-transcript-index-'))
  file = join(dir, 'transcript-index.json')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('persistIndex', () => {
  it('round-trips through loadPersistedIndex', async () => {
    const index = [entry('a', 'alpha'), entry('b', 'beta')]
    expect(await persistIndex(file, index)).toBe(true)
    expect(loadPersistedIndex(file)).toEqual(index)
  })

  it('a failure between the temp write and the rename leaves the old index intact', async () => {
    // The bare writeFile this replaced truncated the target first, so dying mid-write left
    // unparseable JSON → an empty index → a ~779 MB, ~3.2 s cold rescan on the next launch.
    const old = [entry('a', 'old text')]
    expect(await persistIndex(file, old)).toBe(true)
    const before = await readFile(file, 'utf8')

    let tempWritten = false
    vi.spyOn(fs, 'rename').mockImplementation((async (from: string) => {
      // The temp really was written in full before the "crash" — the failure is between the two.
      tempWritten = (await readFile(from, 'utf8')).includes('new text')
      throw errWithCode('EIO')
    }) as unknown as typeof fs.rename)

    expect(await persistIndex(file, [entry('a', 'new text'), entry('b', 'more')])).toBe(false)
    expect(tempWritten).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(loadPersistedIndex(file)).toEqual(old)
    // writeFileAtomic removes its own temp on a failure it survives.
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'writes the file 0600 — it holds transcript text (POSIX mode bits; Windows has none to check)',
    async () => {
      await writeFile(file, '[]', { mode: 0o644 }) // the old 0644 file is replaced, not chmod-inherited
      expect(await persistIndex(file, [entry('a', 'x')])).toBe(true)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
  )
})

describe('loadPersistedIndex', () => {
  it('reads missing, truncated or non-array files as an empty index', async () => {
    expect(loadPersistedIndex(file)).toEqual([])
    await writeFile(file, '[{"sessionId":"a","tran')
    expect(loadPersistedIndex(file)).toEqual([])
    await writeFile(file, '{"not":"an array"}')
    expect(loadPersistedIndex(file)).toEqual([])
  })
})
