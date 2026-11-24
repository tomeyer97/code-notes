// The player is drawn on the next animation frame, once however many times its state changed before it; while it
// plays, every frame. A hidden page gets no frames (the Listen view behind another view): it draws at once.

export class Frames {
  /** @param {() => void} draw */
  constructor(draw) {
    this.draw = draw
    this.frame = 0
    /** @type {(() => boolean) | undefined} draws every frame while this holds */
    this.loopWhile = undefined
  }

  /** Drawn on the next frame. */
  request() {
    if (document.hidden) { this.draw(); return }
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.draw()
      if (this.loopWhile && this.loopWhile()) this.request()
    })
  }

  /** Drawn every frame while `go()` holds (checked now and after each frame). */
  loop(go) {
    this.loopWhile = go
    if (go()) this.request()
  }

  cancel() {
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.loopWhile = undefined
  }
}
