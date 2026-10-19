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

import { promises as fs } from 'fs'
import { join } from 'path'
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

const isDir = async (p: string): Promise<boolean> => {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** The folders a board may be in, most specific first. A project folder that is GONE is left out
 *  so a write never resurrects `<cwd>/.nodeterm/whiteboards` under a directory the user deleted. */
async function candidateDirs(loc: WhiteboardLocation): Promise<string[]> {
  const dirs: string[] = []
  if (loc.projectCwd && (await isDir(loc.projectCwd))) dirs.push(projectWhiteboardsDir(loc.projectCwd))
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
  for (const dir of await candidateDirs(loc)) {
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
  const dirs = await candidateDirs(loc)
  const own = await readIn(dirs, nodeId, withScene !== false)
  if (own) return { ...own, fromSource: false }
  if (sourceId !== nodeId && safeId(sourceId)) {
    const copied = await readIn(dirs, sourceId, withScene !== false)
    if (copied) return { ...copied, fromSource: true }
  }
  return null
}
