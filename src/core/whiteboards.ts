// Where a whiteboard node's drawing lives (nodes/WhiteboardNode.tsx).
//
// The scene is NOT in the node's data. A board with a pasted screenshot is megabytes, and node
// data rides every 800 ms workspace save (the whole workspace in one IPC message, one ≤8 MiB
// Server Edition frame), the 256 KB-per-node team-sync cap, 100 canvas-undo snapshots and the
// phone mirror. So each board is a side file beside project.json, like a canvas image:
//
//   <cwd>/.nodeterm/whiteboards/<nodeId>.excalidraw   (+ <nodeId>.png, the picture the node shows)
//
// falling back to `<userData>/whiteboards/` for a cwd-less canvas, an SSH project (its cwd is on
// the remote host) or a project folder that has been deleted — the same cases, for the same
// reasons, as `canvasImageTarget` in canvas-images.ts.
//
// **The path is derived HERE from (project, node id), never accepted from the renderer.** A
// node's data comes from the git-shared project.json, which anyone with commit access can edit;
// taking a path from it would let a crafted canvas aim a read or an overwrite anywhere this
// process can reach. A node id is validated with `isSafeNodeId` (no separators, no `..`), so the
// only files this module ever touches are `<id>.excalidraw` / `<id>.png` in those two folders.
//
// **The project folder is bound by its REAL path** (`projectBoardsDir`). The id check covers the
// file name only: a repository can commit `.nodeterm` or `.nodeterm/whiteboards` as a symlink to any
// directory on this machine, and every component before the file name used to be followed — a save
// wrote `<id>.excalidraw` / `<id>.png` on the other side, and a read (which a hosted-team Viewer can
// ask for) served that side's files past the realpath jail every `fs:*` call gets. Each existing
// component is resolved and must stay inside the project's real root before anything is created
// through it; otherwise the project folder is not used and the board falls back to the app folder.

import { promises as fs } from 'fs'
import { isAbsolute, join, relative, sep } from 'path'
import { renameAtomic, tempNameFor, writeFileAtomic } from './fs-atomic'
import { readRegularFileBytesNoFollow } from './read-regular-file'
import { isSafeNodeId } from '../shared/safe-id'
import type { WhiteboardFile } from '../shared/whiteboard'

/** `isSafeNodeId` alone would pass a NUMBER (its regex coerces it); these arrive over IPC. */
const safeId = (id: unknown): id is string => typeof id === 'string' && isSafeNodeId(id)

export type { WhiteboardFile }

export const projectWhiteboardsDir = (projectCwd: string): string =>
  join(projectCwd, '.nodeterm', 'whiteboards')

export const appWhiteboardsDir = (userDataDir: string): string => join(userDataDir, 'whiteboards')

/** A scene is JSON text. 64 MB holds a board full of pasted screenshots with room to spare. */
export const WHITEBOARD_SCENE_MAX_BYTES = 64 * 1024 * 1024
/** The resting picture is capped at 1600 px on its long side, so 16 MB is generous. */
export const WHITEBOARD_THUMB_MAX_BYTES = 16 * 1024 * 1024

export interface WhiteboardLocation {
  projectCwd?: string
  userDataDir: string
}


/** `writeFileAtomic` writes TEXT (utf-8), which would mangle a PNG. Same publish discipline for
 *  bytes: an exclusive-create temp (named like every other, so the stale-temp sweep knows it),
 *  then the retrying atomic rename. */
async function writeBytesAtomic(target: string, data: Buffer): Promise<void> {
  const tmp = tempNameFor(target)
  try {
    await fs.writeFile(tmp, data, { flag: 'wx' })
    await renameAtomic(tmp, target)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

/** `child` is `root` or below it, by path SEGMENTS (a sibling `root-x` is not inside `root`). A
 *  path on another Windows drive comes back from `relative` absolute, and is not inside either. */
const within = (root: string, child: string): boolean => {
  const rel = relative(root, child)
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..')
}

/**
 * The project's whiteboards folder by its real path, or null when it must not be used: the project
 * folder is gone, a component of `.nodeterm/whiteboards` leads outside the project (or dangles), or
 * — for a read — the folder does not exist. `create` makes it for a write; a read never creates.
 *
 * Every component that exists is resolved BEFORE anything is created through it: `mkdir -p` on a
 * `.nodeterm` that links out of the project would make `whiteboards` on the other side. A project
 * folder that is GONE is refused too, so a write never resurrects a directory the user deleted.
 */
async function projectBoardsDir(projectCwd: string, create: boolean): Promise<string | null> {
  const root = await fs.realpath(projectCwd).catch(() => null)
  if (!root || !(await fs.stat(root).then((s) => s.isDirectory(), () => false))) return null
  const boards = join(root, '.nodeterm', 'whiteboards')
  for (const p of [join(root, '.nodeterm'), boards]) {
    const present = await fs.lstat(p).then(
      () => true,
      (e: NodeJS.ErrnoException) => (e?.code === 'ENOENT' ? false : null)
    )
    if (present === null) return null
    if (!present) {
      if (!create) return null
      break
    }
    // A dangling link has no real path: refused, never created through.
    const real = await fs.realpath(p).catch(() => null)
    if (!real || !within(root, real)) return null
  }
  if (create) await fs.mkdir(boards, { recursive: true })
  const real = await fs.realpath(boards).catch(() => null)
  if (!real || !within(root, real)) return null
  return (await fs.stat(real).then((s) => s.isDirectory(), () => false)) ? real : null
}

/** The folders a board may be in, most specific first. `write` creates the project's folder; a read
 *  only looks in one that exists. A project folder that cannot be used (see `projectBoardsDir`) is
 *  left out, so the board lands in — or is read from — the app folder alone. */
async function candidateDirs(loc: WhiteboardLocation, write: boolean): Promise<string[]> {
  const dirs: string[] = []
  if (loc.projectCwd) {
    const dir = await projectBoardsDir(loc.projectCwd, write).catch(() => null)
    if (dir) dirs.push(dir)
  }
  dirs.push(appWhiteboardsDir(loc.userDataDir))
  return dirs
}

/**
 * Write a board's scene (and optionally its picture). Resolves the scene's absolute path, or null
 * when the input is refused (bad id, over the cap) or no folder would take it. Never throws: the
 * caller keeps the board open and says the save failed — a drawing that silently was not saved is
 * the failure this must not have. The project folder is tried first; a read-only checkout or a
 * `.nodeterm` that is a file falls back to the app folder, like a canvas image.
 */
export async function saveWhiteboard(
  loc: WhiteboardLocation,
  nodeId: string,
  scene: string,
  thumbnailBase64?: string
): Promise<string | null> {
  if (!safeId(nodeId)) return null
  if (typeof scene !== 'string' || Buffer.byteLength(scene) > WHITEBOARD_SCENE_MAX_BYTES) return null
  let thumb: Buffer | undefined
  if (typeof thumbnailBase64 === 'string' && thumbnailBase64.length) {
    // Measure the ENCODED length first: decoding a hostile 2 GB string is the allocation the cap
    // exists to prevent (same rule as uploads.ts).
    if (thumbnailBase64.length > WHITEBOARD_THUMB_MAX_BYTES * 1.4) return null
    thumb = Buffer.from(thumbnailBase64, 'base64')
    if (thumb.length > WHITEBOARD_THUMB_MAX_BYTES) return null
  }
  for (const dir of await candidateDirs(loc, true)) {
    try {
      await fs.mkdir(dir, { recursive: true })
      const scenePath = join(dir, `${nodeId}.excalidraw`)
      await writeFileAtomic(scenePath, scene)
      // The picture is best-effort: a board whose scene saved but whose picture did not is still
      // a saved board (the node re-renders the picture the next time it is opened).
      if (thumb) await writeBytesAtomic(join(dir, `${nodeId}.png`), thumb).catch(() => undefined)
      // An empty string means the board is empty now: drop the old picture instead of showing it.
      else if (thumbnailBase64 === '') await fs.rm(join(dir, `${nodeId}.png`), { force: true }).catch(() => undefined)
      return scenePath
    } catch {
      // try the next folder
    }
  }
  return null
}

/**
 * The board in the first folder that has one. Both files are read through ONE descriptor each with
 * symlinks refused (`readRegularFileBytesNoFollow`): `.nodeterm/` is git-shared, and a committed
 * symlink named `<id>.excalidraw` must not hand some other file on this machine to the renderer.
 */
async function readIn(
  dirs: string[],
  nodeId: string,
  withScene: boolean
): Promise<Omit<WhiteboardFile, 'fromSource'> | null> {
  for (const dir of dirs) {
    const scene = await readRegularFileBytesNoFollow(join(dir, `${nodeId}.excalidraw`), WHITEBOARD_SCENE_MAX_BYTES, {
      read: withScene
    })
    if (!scene) continue
    const png = await readRegularFileBytesNoFollow(join(dir, `${nodeId}.png`), WHITEBOARD_THUMB_MAX_BYTES)
    return {
      scene: scene.bytes?.toString('utf8'),
      thumbnailBase64: png?.bytes?.toString('base64'),
      updatedAt: scene.mtimeMs
    }
  }
  return null
}

/**
 * Read a board. `sourceId` is the board a duplicated or reopened node was copied from: until the
 * node saves its own file, it shows (and starts editing from) the source's — so a copy never
 * needed a file copy, and no board file is ever deleted out from under an undo or a reopen.
 * Resolves null when neither exists (a new, empty board).
 *
 * `withScene: false` answers only the picture and the revision — what a board at REST needs. The
 * scene (megabytes once screenshots are pasted in) is fetched when the board is opened, so a
 * canvas of twenty boards does not hold twenty drawings in the renderer.
 */
export async function readWhiteboard(
  loc: WhiteboardLocation,
  nodeId: string,
  sourceId?: string,
  withScene = true
): Promise<WhiteboardFile | null> {
  if (!safeId(nodeId)) return null
  const dirs = await candidateDirs(loc, false)
  const own = await readIn(dirs, nodeId, withScene !== false)
  if (own) return { ...own, fromSource: false }
  if (sourceId !== nodeId && safeId(sourceId)) {
    const copied = await readIn(dirs, sourceId, withScene !== false)
    if (copied) return { ...copied, fromSource: true }
  }
  return null
}
