# Whiteboard nodes

A **whiteboard** is a canvas node holding an infinite drawing board, for sketching an idea during a
call or a screenshare: freehand pen, shapes, arrows that stay attached to what they point at, text,
pasted images, undo and export. It embeds [Excalidraw](https://github.com/excalidraw/excalidraw)
(`@excalidraw/excalidraw`, MIT) rather than reimplementing one.

Add one from right-click → **New view → New whiteboard**, the sessions-sidebar "+", the Dock, or
⌘K "New whiteboard" (`node.newWhiteboard`, unbound by default). A new board opens ready to draw.
Double-click (or Enter on) a board to draw on it again; Esc or a click outside finishes. The header
has **Present** (maximize + Excalidraw's zen mode, restored on Esc) and **Copy as image** (the board
as a PNG on the clipboard). Its default size is a Settings → Behavior → Default node size entry.

## Editing happens in an overlay, not in the node

React Flow scales every node with `transform: scale(zoom)`. Excalidraw sizes its canvas and maps
the pointer from `getBoundingClientRect()`, so inside a scaled node it draws away from the pointer
and its bitmap goes soft. So at rest the node shows a **picture** of the board, and editing mounts
**one** live Excalidraw portaled into `.canvas-root` — outside `.flow-wrap` — laid exactly over the
node's on-screen box (`nodes/WhiteboardNode.tsx`). That also keeps it away from the canvas's
capture-phase wheel listener on `.flow-wrap` (⌘-wheel and pinch always zoom the canvas, even over
`.nowheel`) and from xyflow's middle-button pan. The overlay:

- follows the box as the canvas pans/zooms and the node moves, resizes or maximizes, and calls
  Excalidraw's `refresh()` when it does (Excalidraw caches its offsets otherwise);
- runs Excalidraw at `boardZoom × canvasZoom` (`whiteboard/zoom.ts`), so the drawing scales with the
  canvas like every other node — and stays sharp, since Excalidraw redraws at the real size. The
  file stores only the board zoom;
- is clipped to the canvas area and stacked at z 10, under the sessions sidebar (12) and Dock (20);
- treats a press on the node's own frame (header, Maximize, title) as staying in the board.

Only one editor is ever mounted, and it unmounts when editing ends — Excalidraw keeps some state
module-global, and one live instance costs ~3 MB the first time. Measured: no heap growth over five
open/close cycles, no running animations open or closed.

## The keyboard belongs to the board while it is open

Excalidraw's focused element is a plain `<div>`, which no "is this a text field" check recognises,
so canvas commands fired over it: Space panned the whole canvas (verified in the dev build),
Delete/⌘Z/⌘[ reached canvas commands. The overlay carries `data-nt-keyboard-owner`; the shared
check `isKeyboardOwnerTarget` (`lib/keyContext.ts`) makes every typing-aware site stand down for
it: the dispatcher's `isTypingTarget`, Space-to-pan, pane-focus release, the zoom shortcuts and the
copy gesture. Esc is caught in the capture phase (Excalidraw does not let it bubble) and ends
editing only when Excalidraw has nothing of its own to cancel. ⌘0 stays with the canvas: main
claims it before the page.

## Storage: a side file addressed by node id

The drawing is **not** in node data — a board with a pasted screenshot is megabytes, and node data
rides the 800 ms whole-workspace save (one ≤8 MiB Server Edition frame), the 256 KB-per-node
team-sync cap, 100 canvas-undo snapshots and the phone mirror. `core/whiteboards.ts` writes:

    <cwd>/.nodeterm/whiteboards/<nodeId>.excalidraw   + <nodeId>.png (the resting picture)

falling back to `<userData>/whiteboards/` for a cwd-less canvas, an SSH project and a deleted or
read-only project folder (the `canvas-images.ts` rules). Writes are atomic (`writeFileAtomic`; the
PNG through `tempNameFor` + `renameAtomic`, since `writeFileAtomic` writes text).

**The core derives the path from (project, node id); it never accepts one.** Node data comes from
the git-shared `project.json`, which anyone with commit access can edit — a path taken from it
could aim a read or an overwrite anywhere. A node id must be a `string` passing `isSafeNodeId`
(the regex alone would accept a number). Node data carries only:

- `whiteboardSource` — the board a **duplicate or reopen** (which get new ids) reads until it saves
  its own. No file is ever copied, and none is deleted when a node is, so undo and ⇧⌘T always find
  the drawing. Re-validated on load like every hand-editable field.
- `boardRev` — epoch ms, bumped once per editing session that changed the board (never per
  stroke), so strokes never reach the workspace save, canvas undo or team sync.

Saves happen 1.5 s after the last change, when editing ends (with the picture), and on unmount
(project switch, node closed, quit). Each compares the current version with what is on disk rather
than trusting an `onChange` flag; the unmount flush writes a snapshot kept from `onChange`, because
by cleanup time Excalidraw's api answers an empty scene. A board whose file does not parse is shown
as unreadable and never opened, so an autosave cannot overwrite it.

The two channels (`files.saveWhiteboard`, `files.readWhiteboard`) are registered in core for both
shells and classified in both relay policies exactly like a canvas image (save: editors only;
both scoped to the shared project).

## Bundle and assets

- Excalidraw is a renderer-only **devDependency**, loaded with `React.lazy` the first time a board
  is opened: its JS (~1.7 MB) and CSS (~145 KB) are their own chunks, never in `boot`.
- **Fonts are served locally** by `scripts/excalidraw-assets-plugin.ts`: Excalidraw fetches
  `${EXCALIDRAW_ASSET_PATH}fonts/<Family>/<file>.woff2` by exact path (default: a CDN, blocked by
  the CSP and absent offline). The plugin serves `dist/prod/fonts` in dev and emits it under
  `excalidraw-assets/` in builds, without Xiaolai (the 12 MB CJK family; CJK text falls back to a
  system font). ~480 KB.
- `@excalidraw/mermaid-to-excalidraw` is **aliased to a stub** (`whiteboard/mermaid-stub.ts`): it
  pulls in all of mermaid for "text to diagram", ~10 MB of chunks (renderer output 48 MB → 38 MB).
  A pasted mermaid definition falls back to plain text.
- Scoped `overrides` under `@excalidraw/excalidraw` (nanoid, sass, lodash-es, katex, mermaid,
  @mermaid-js/parser) clear the 14 advisories 0.18.1 brings in; without them Dependency review fails.

## Not in this version

Live multi-user drawing (team sync is whole-node, last writer wins), agents reading a linked board
(a follow-up), kanban cards (CLAUDE.md: non-session kinds are not cards), and Excalidraw's own
open/save-file actions (they fail in Electron; saving is ours).
