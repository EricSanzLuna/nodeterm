/** A whiteboard as read back from its side file (core/whiteboards.ts). */
export interface WhiteboardFile {
  /** The `.excalidraw` JSON, as written; absent when the read asked for the picture only. */
  scene?: string
  /** The PNG the node shows at rest, base64; absent when none was saved. */
  thumbnailBase64?: string
  /** Epoch ms of the scene's last write — the board's revision as far as readers care. */
  updatedAt: number
  /** True when this came from the source board because the node has none of its own yet. */
  fromSource: boolean
}
