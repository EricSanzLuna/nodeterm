import '@excalidraw/excalidraw/index.css'
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import {
  Excalidraw,
  MainMenu,
  exportToBlob,
  getNonDeletedElements,
  hashElementsVersion,
  restore,
  serializeAsJSON
} from '@excalidraw/excalidraw'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { boardZoom, rescaleForCanvas, screenZoom } from './zoom'

/** After the last change, how long until the scene is written. Long enough that a burst of
 *  strokes is one write; short enough that a crash loses a few seconds, not a session. */
const AUTOSAVE_MS = 1500

/** First-open pen for screensharing: a heavier stroke and clean (not sketchy) lines read better
 *  on a compressed video feed. Only applies to a board with no saved pen. */
const SCREENSHARE_DEFAULTS: Partial<AppState> = {
  currentItemStrokeWidth: 2,
  currentItemRoughness: 0
}

/** What counts as "the board changed": element versions plus the set of embedded files. Excalidraw's
 *  onChange also fires for every pointer move and menu open, which must not schedule a write. */
const versionOf = (elements: readonly ExcalidrawElement[], files: BinaryFiles): string =>
  `${hashElementsVersion(elements)}:${Object.keys(files).length}`

async function thumbnailBase64(api: ExcalidrawImperativeAPI): Promise<string | undefined> {
  const elements = getNonDeletedElements(api.getSceneElements())
  if (elements.length === 0) return undefined
  const state = api.getAppState()
  const blob = await exportToBlob({
    elements,
    appState: { ...state, exportBackground: true, exportWithDarkMode: state.theme === 'dark' },
    files: api.getFiles(),
    mimeType: 'image/png',
    maxWidthOrHeight: 1600
  })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** A board's contents at one moment: what a save writes and what its version is computed from. */
interface Snapshot {
  elements: readonly ExcalidrawElement[]
  appState: Partial<AppState>
  files: BinaryFiles
}

const fromApi = (api: ExcalidrawImperativeAPI): Snapshot => ({
  elements: api.getSceneElementsIncludingDeleted(),
  appState: api.getAppState(),
  files: api.getFiles()
})

/** The file keeps the BOARD zoom (see whiteboard/zoom.ts), never the canvas-scaled one. */
const serialize = (s: Snapshot, canvasZoom: number): string => {
  const onScreen = (s.appState.zoom as AppState['zoom'] | undefined)?.value ?? 1
  const appState = { ...s.appState, zoom: { value: boardZoom(onScreen, canvasZoom) } } as AppState
  return serializeAsJSON(s.elements, appState, s.files, 'local')
}

export default function WhiteboardEditor({
  initialScene,
  theme,
  canvasZoom,
  present,
  geometryKey,
  overlayRef,
  frameRef,
  onSave,
  onExit
}: {
  /** The board's `.excalidraw` JSON as read from its file; undefined for a new board. */
  initialScene: string | undefined
  theme: 'dark' | 'light'
  /** Screenshare mode: Excalidraw's zen mode (toolbars hidden) on a maximized node. */
  present: boolean
  /** The React Flow canvas zoom. The board renders at its own zoom times this one. */
  canvasZoom: number
  /** Changes whenever the overlay moves or resizes, so Excalidraw re-reads its offsets. */
  geometryKey: string
  overlayRef: RefObject<HTMLDivElement | null>
  /** The node's own frame: a press there (header, Maximize, title) keeps the editor open. */
  frameRef: RefObject<HTMLDivElement | null>
  onSave: (scene: string, thumbnailBase64?: string) => Promise<boolean>
  onExit: (changed: boolean) => void
}): React.JSX.Element {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const canvasZoomRef = useRef(canvasZoom)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exitingRef = useRef(false)
  const changedThisSessionRef = useRef(false)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  // Parsed once per mount. A file that does not parse never reaches here: the node validates it on
  // load and refuses to open an editor over a board it could not read, so a save never overwrites one.
  const initialData = useMemo(() => {
    const parsed = initialScene ? restore(JSON.parse(initialScene), null, null) : null
    return {
      elements: parsed?.elements ?? [],
      appState: {
        ...SCREENSHARE_DEFAULTS,
        ...parsed?.appState,
        zoom: { value: screenZoom(parsed?.appState?.zoom?.value ?? 1, canvasZoom) } as AppState['zoom']
      },
      files: parsed?.files
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The versions already on disk: the scene, and the picture (written only when editing ends).
  // Taken from what was LOADED, not from Excalidraw's first onChange — which need not come before
  // the first edit, and an edit mistaken for the baseline would never be saved.
  const savedVersionRef = useRef<string>(versionOf(initialData.elements, initialData.files ?? {}))
  const thumbVersionRef = useRef<string>(savedVersionRef.current)
  // The latest contents, kept from every onChange. The unmount flush writes THIS, never the api:
  // by the time a cleanup runs Excalidraw has already torn down and its api answers an EMPTY scene
  // — writing that erased the whole board when a node was closed within the autosave window.
  const latestRef = useRef<Snapshot>({
    elements: initialData.elements,
    appState: initialData.appState,
    files: initialData.files ?? {}
  })

  /**
   * Write whatever differs from disk. Every caller decides by comparing versions, never by a dirty
   * flag an onChange had to set. `unmounting` reads the kept snapshot instead of the api (see
   * `latestRef`) and writes no picture — exporting one needs the live editor.
   */
  const flush = useCallback(async (withThumbnail: boolean, unmounting = false): Promise<void> => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    const api = apiRef.current
    if (!unmounting && api) latestRef.current = fromApi(api)
    const snap = latestRef.current
    const version = versionOf(snap.elements, snap.files)
    const needScene = version !== savedVersionRef.current
    const needThumb = !unmounting && !!api && withThumbnail && version !== thumbVersionRef.current
    if (!needScene && !needThumb) return
    // '' = "the board is empty now": the core removes the old picture rather than keep showing it.
    const thumb = needThumb && api ? ((await thumbnailBase64(api).catch(() => undefined)) ?? '') : undefined
    if (await onSaveRef.current(serialize(snap, canvasZoomRef.current), thumb)) {
      savedVersionRef.current = version
      if (needThumb) thumbVersionRef.current = version
      changedThisSessionRef.current = true
    }
  }, [])

  const exit = useCallback(async () => {
    if (exitingRef.current) return
    exitingRef.current = true
    await flush(true)
    onExit(changedThisSessionRef.current)
  }, [flush, onExit])

  // Leaving without an exit (a project switch, the node deleted, the app quitting): write whatever
  // is unsaved. The api is still readable synchronously here; the write itself is async and the
  // core finishes it after this component is gone.
  useEffect(
    () => () => {
      if (!exitingRef.current) void flush(false, true)
    },
    [flush]
  )

  // Follow the canvas zoom while the board is open. Scroll is in scene units, so the scene point at
  // the board's top-left stays at its top-left — the same anchor the node box scales from.
  useEffect(() => {
    const api = apiRef.current
    const prev = canvasZoomRef.current
    canvasZoomRef.current = canvasZoom
    if (!api || prev === canvasZoom) return
    const value = rescaleForCanvas(api.getAppState().zoom.value, prev, canvasZoom)
    api.updateScene({ appState: { zoom: { value } as AppState['zoom'] } })
  }, [canvasZoom])

  // Excalidraw caches its container's offsets and only refreshes them on window scroll/resize; the
  // overlay moving with the canvas is neither, so tell it.
  useEffect(() => {
    apiRef.current?.refresh()
  }, [geometryKey])

  useEffect(() => {
    // Escape ends editing only when Excalidraw has nothing of its own to cancel (a selection, a
    // text edit, a half-drawn element, an open menu); otherwise it is Excalidraw's. Capture phase
    // on the overlay: Excalidraw does not let Escape bubble.
    const overlay = overlayRef.current
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const s = apiRef.current?.getAppState()
      const busy =
        !!s &&
        (Object.keys(s.selectedElementIds).length > 0 ||
          !!s.editingTextElement ||
          !!s.newElement ||
          s.openMenu !== null ||
          s.openPopup !== null ||
          s.openDialog !== null)
      if (!busy) {
        e.preventDefault()
        e.stopPropagation()
        void exit()
      }
    }
    // A press outside the board ends editing — except on the node's own frame, so Maximize, the
    // title and dragging the header all keep the board open (the overlay follows the node).
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && (overlay?.contains(t) || frameRef.current?.contains(t))) return
      void exit()
    }
    overlay?.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      overlay?.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [exit, overlayRef, frameRef])

  return (
    <Excalidraw
      excalidrawAPI={(api) => {
        apiRef.current = api
      }}
      initialData={initialData}
      onChange={(elements, appState, files) => {
        latestRef.current = { elements, appState, files }
        if (versionOf(elements, files) === savedVersionRef.current) return
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => void flush(false), AUTOSAVE_MS)
      }}
      theme={theme}
      zenModeEnabled={present}
      autoFocus
      aiEnabled={false}
      UIOptions={{
        canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: null }
      }}
    >
      <MainMenu>
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
    </Excalidraw>
  )
}
