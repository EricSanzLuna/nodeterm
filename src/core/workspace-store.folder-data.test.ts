// A folder project can keep its canvas in app data instead of `<cwd>/.nodeterm/project.json`
// (issue #1145): the FOLDER-DATA-REF, a local-data ref with a working directory. The promise is
// that nothing is written into the folder, and the traps are the ways an existing path would
// break it: the watcher re-reading the folder file, a missing data file falling through to the
// folder branch, an older build writing a fresh file into the folder, and a copy left behind on
// the side a move departs from.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

let userData: string
let folder: string

const node = (id: string, over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  title: id, color: '#fff', group: null, ...over
})
const project = (over: Partial<Project> = {}): Project => ({
  id: 'project-p1', name: 'client-repo', color: '#7aa2f7', viewport: { x: 4, y: 5, zoom: 2 },
  cwd: folder, storeInAppData: true, nodes: [node('term-1', { cwd: path.join(folder, 'sub') })], ...over
})
const ws = (projects: Project[], active = projects[0]?.id ?? ''): Workspace =>
  ({ version: 2, activeProjectId: active, projects })

const dataFile = (id: string) => path.join(userData, 'inline-projects', `${id}.json`)
const folderFile = () => path.join(folder, '.nodeterm', 'project.json')
const readIndex = async () =>
  JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
const writeIndex = async (index: unknown) =>
  fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify(index))
const readData = async (id: string) => JSON.parse(await fs.readFile(dataFile(id), 'utf-8'))
const exists = (p: string) => fs.access(p).then(() => true, () => false)
const ids = (nodes: CanvasNodeState[]) => nodes.map((n) => n.id)
const foreignFile = (nodeId: string) => JSON.stringify({
  version: 1, rev: 99, savedAt: '2026-01-01T00:00:00.000Z', name: 'teammate', color: '#000',
  viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node(nodeId)]
})

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-folder-data-'))
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-folder-data-repo-'))
  initPlatform(fakePlatform({ userDataDir: userData }))
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  await fs.rm(folder, { recursive: true, force: true })
})

describe('a folder project stored in app data', () => {
  it('writes its canvas to app data and nothing into the folder', async () => {
    await new WorkspaceStore().save(ws([project()]))

    expect(await fs.readdir(folder)).toEqual([])
    expect(ids((await readData('project-p1')).nodes)).toEqual(['term-1'])
    const entry = (await readIndex()).entries[0]
    expect(entry).toMatchObject({ id: 'project-p1', cwd: folder, dataFile: true })
  })

  it('round-trips with its folder, the flag and absolute node cwds', async () => {
    await new WorkspaceStore().save(ws([project()]))
    const loaded = (await new WorkspaceStore().load()).projects[0]

    expect(loaded).toMatchObject({ id: 'project-p1', cwd: folder, storeInAppData: true })
    expect(loaded.nodes[0].cwd).toBe(path.join(folder, 'sub'))
    expect(loaded.viewport).toEqual({ x: 4, y: 5, zoom: 2 })
  })

  it('stores the index cache without cwd, so an older build opens an inline canvas', async () => {
    await new WorkspaceStore().save(ws([project()]))
    const index = await readIndex()
    expect(index.entries[0].project.cwd).toBeUndefined()
    expect(index.entries[0].project.storeInAppData).toBeUndefined()

    // A build that predates the kind takes the `e.project` branch: the same as this build reading
    // the entry without its `dataFile` flag.
    delete index.entries[0].dataFile
    await writeIndex(index)
    const old = new WorkspaceStore()
    const loaded = (await old.load()).projects[0]
    expect(loaded.cwd).toBeUndefined()
    expect(ids(loaded.nodes)).toEqual(['term-1'])

    await old.save(ws([loaded]))
    expect(await exists(path.join(folder, '.nodeterm'))).toBe(false)
  })

  it('reads its data file, never the folder file a teammate committed', async () => {
    await new WorkspaceStore().save(ws([project()]))
    await fs.mkdir(path.join(folder, '.nodeterm'))
    await fs.writeFile(folderFile(), foreignFile('term-foreign'))

    const loaded = (await new WorkspaceStore().load()).projects[0]
    expect(ids(loaded.nodes)).toEqual(['term-1'])
  })

  it('falls back to its cache, then a placeholder, never to the folder file', async () => {
    await new WorkspaceStore().save(ws([project()]))
    await fs.mkdir(path.join(folder, '.nodeterm'))
    await fs.writeFile(folderFile(), foreignFile('term-foreign'))
    await fs.rm(dataFile('project-p1'))

    const fromCache = (await new WorkspaceStore().load()).projects[0]
    expect(fromCache).toMatchObject({ cwd: folder, storeInAppData: true })
    expect(ids(fromCache.nodes)).toEqual(['term-1'])

    const index = await readIndex()
    delete index.entries[0].project
    await writeIndex(index)
    const store = new WorkspaceStore()
    const placeholder = (await store.load()).projects[0]
    expect(placeholder).toMatchObject({ unavailable: true, storeInAppData: true, cwd: folder })
    expect(placeholder.nodes).toEqual([])

    // Saving the placeholder back keeps the kind, so the next load still does not read the folder.
    await store.save(ws([placeholder]))
    expect((await readIndex()).entries[0]).toMatchObject({ cwd: folder, dataFile: true })
    expect((await new WorkspaceStore().load()).projects[0].unavailable).toBe(true)
  })

  it('is not watched: its folder file is not a local ref path', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project(), project({ id: 'project-p2', storeInAppData: undefined, cwd: folder + '-b' })]))
    expect(store.localRefPaths()).toEqual([path.join(folder + '-b', '.nodeterm', 'project.json')])
    expect(await store.readLocalRef('project-p1')).toBeNull()
    await fs.rm(folder + '-b', { recursive: true, force: true })
  })

  it('sits beside a folder ref on the same folder without demoting either', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([
      project({ id: 'project-ref', storeInAppData: undefined, nodes: [node('term-ref')] }),
      project()
    ]))
    const [ref, data] = (await new WorkspaceStore().load()).projects
    expect(ids(ref.nodes)).toEqual(['term-ref'])
    expect(ref.storeInAppData).toBeUndefined()
    expect(ids(data.nodes)).toEqual(['term-1'])
    expect(data.storeInAppData).toBe(true)
  })
})

describe('moving a folder project between the two locations', () => {
  it('to app data: writes the data file and clears an older copy of its own first', async () => {
    const store = new WorkspaceStore()
    // A leftover from an earlier stay in app data: same id, populated.
    await fs.mkdir(path.dirname(dataFile('project-p1')), { recursive: true })
    await fs.writeFile(dataFile('project-p1'), foreignFile('term-stale'))
    await store.save(ws([project({ storeInAppData: undefined, nodes: [] })]))

    await store.save(ws([project({ nodes: [] })]))
    const loaded = (await new WorkspaceStore().load()).projects[0]
    expect(loaded.nodes).toEqual([])
    expect(loaded.storeInAppData).toBe(true)
  })

  it('to the folder: writes the folder file, then deletes the data file', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    await store.save(ws([project({ storeInAppData: undefined })]))

    expect(await exists(dataFile('project-p1'))).toBe(false)
    const file = JSON.parse(await fs.readFile(folderFile(), 'utf-8'))
    expect(ids(file.nodes)).toEqual(['term-1'])
    // The folder file carries portable cwds, as every folder project's does.
    expect(file.nodes[0].cwd).toBe('./sub')
    const loaded = (await new WorkspaceStore().load()).projects[0]
    expect(loaded.storeInAppData).toBeUndefined()
    expect(loaded.nodes[0].cwd).toBe(path.join(folder, 'sub'))
  })

  it('to the folder: keeps the data file while the folder write cannot land', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    // A FILE where the `.nodeterm` directory would go: the folder leg's mkdir fails.
    await fs.writeFile(path.join(folder, '.nodeterm'), 'not a directory')
    await store.save(ws([project({ storeInAppData: undefined })]))

    expect(ids((await readData('project-p1')).nodes)).toEqual(['term-1'])
  })

  it('"Set folder…" on a cwd-less canvas no longer leaves its data file behind', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: undefined, storeInAppData: undefined })]))
    expect(await exists(dataFile('project-p1'))).toBe(true)

    await store.save(ws([project({ storeInAppData: undefined })]))
    expect(await exists(dataFile('project-p1'))).toBe(false)
    expect(await exists(folderFile())).toBe(true)
  })
})
