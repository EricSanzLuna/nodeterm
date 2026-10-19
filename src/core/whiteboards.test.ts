import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  WHITEBOARD_SCENE_MAX_BYTES,
  appWhiteboardsDir,
  projectWhiteboardsDir,
  readWhiteboard,
  saveWhiteboard
} from './whiteboards'

const scene = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a' }] })
// Bytes that utf-8 text encoding would mangle (0x89 'PNG' header, a NUL, high bytes).
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80])
const png = pngBytes.toString('base64')

let root: string
let userDataDir: string
let projectCwd: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-whiteboards-'))
  userDataDir = join(root, 'userData')
  projectCwd = join(root, 'project')
  await fs.mkdir(projectCwd, { recursive: true })
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('saveWhiteboard / readWhiteboard', () => {
  it('writes beside project.json and reads the scene and picture back, picture byte-exact', async () => {
    const path = await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene, png)
    expect(path).toBe(join(projectWhiteboardsDir(projectCwd), 'whiteboard-1.excalidraw'))
    const read = await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1')
    expect(read).toMatchObject({ scene, fromSource: false })
    expect(Buffer.from(read!.thumbnailBase64!, 'base64').equals(pngBytes)).toBe(true)
    expect(read!.updatedAt).toBeGreaterThan(0)
  })

  it('uses the app folder for a project with no local cwd (cwd-less canvas, SSH project)', async () => {
    const path = await saveWhiteboard({ userDataDir }, 'whiteboard-1', scene)
    expect(path).toBe(join(appWhiteboardsDir(userDataDir), 'whiteboard-1.excalidraw'))
    expect((await readWhiteboard({ userDataDir }, 'whiteboard-1'))?.scene).toBe(scene)
  })

  it('never resurrects a deleted project folder; the board lands in the app folder instead', async () => {
    await rm(projectCwd, { recursive: true, force: true })
    const path = await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene)
    expect(path).toBe(join(appWhiteboardsDir(userDataDir), 'whiteboard-1.excalidraw'))
    await expect(fs.stat(projectCwd)).rejects.toThrow()
  })

  it('falls back to the app folder when the project folder will not take the file', async () => {
    await fs.writeFile(join(projectCwd, '.nodeterm'), 'not a directory')
    const path = await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene)
    expect(path).toBe(join(appWhiteboardsDir(userDataDir), 'whiteboard-1.excalidraw'))
    // ...and a read finds it there, since the project folder has no board.
    expect((await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1'))?.scene).toBe(scene)
  })

  it('refuses any id that could name a path, for both write and read', async () => {
    for (const bad of ['../escape', 'a/b', 'a\\b', '..', '', '.', 42 as unknown as string]) {
      expect(await saveWhiteboard({ projectCwd, userDataDir }, bad, scene)).toBeNull()
      expect(await readWhiteboard({ projectCwd, userDataDir }, bad)).toBeNull()
    }
    expect(await fs.readdir(root)).toEqual(['project'])
  })

  it('refuses a scene over the cap rather than truncating it', async () => {
    const big = 'x'.repeat(WHITEBOARD_SCENE_MAX_BYTES + 1)
    expect(await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', big)).toBeNull()
  })

  it('a copied node reads its source until it saves its own board', async () => {
    await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-orig', scene, png)
    const copy = await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-copy', 'whiteboard-orig')
    expect(copy).toMatchObject({ scene, fromSource: true })

    const edited = JSON.stringify({ type: 'excalidraw', elements: [] })
    await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-copy', edited)
    expect(await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-copy', 'whiteboard-orig')).toMatchObject({
      scene: edited,
      fromSource: false
    })
    // The source is untouched by the copy's save.
    expect((await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-orig'))?.scene).toBe(scene)
  })

  it('ignores an unsafe source id instead of following it', async () => {
    expect(await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', '../../etc/passwd')).toBeNull()
  })

  it('an empty picture means the board was cleared: the old picture is removed, not kept', async () => {
    await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene, png)
    await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene, '')
    expect((await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1'))?.thumbnailBase64).toBeUndefined()
  })

  it('a picture-only read (a board at rest) skips the scene but keeps the picture and revision', async () => {
    await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene, png)
    const rest = await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', undefined, false)
    expect(rest?.scene).toBeUndefined()
    expect(rest?.thumbnailBase64).toBe(png)
    expect(rest?.updatedAt).toBeGreaterThan(0)
  })

  it.skipIf(process.platform === 'win32')(
    'never follows a symlinked board file (a crafted repo cannot point a board at another file)',
    async () => {
      const secret = join(root, 'secret.txt')
      await fs.writeFile(secret, 'private key material')
      const dir = projectWhiteboardsDir(projectCwd)
      await fs.mkdir(dir, { recursive: true })
      await fs.symlink(secret, join(dir, 'whiteboard-evil.excalidraw'))
      await fs.symlink(secret, join(dir, 'whiteboard-evil.png'))
      expect(await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-evil')).toBeNull()
    }
  )

  it('answers null for a board that was never saved (a new, empty board)', async () => {
    expect(await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-new')).toBeNull()
  })
})
