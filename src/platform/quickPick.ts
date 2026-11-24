// A QuickPick as a promise: the item accepted, or undefined when it is hidden.

import * as vscode from 'vscode'

export interface PickOneOptions<T> {
  /** Enter with nothing selected takes the active item (a preselected row). */
  orActive?: boolean
  /** Gets the accept function before the pick shows (the integration tests answer a pick with it). */
  onOpen?: (accept: (item: T | undefined) => void) => void
  /** After it was hidden and disposed. */
  onHide?: () => void
}

/** Shows `qp` until an item is accepted or it is hidden (undefined); then it is disposed. */
export function pickOne<T extends vscode.QuickPickItem>(qp: vscode.QuickPick<T>, o: PickOneOptions<T> = {}): Promise<T | undefined> {
  return new Promise<T | undefined>((res) => {
    const accept = (item: T | undefined) => {
      res(item)
      qp.hide()
    }
    o.onOpen?.(accept)
    qp.onDidAccept(() => accept(qp.selectedItems[0] ?? (o.orActive ? qp.activeItems[0] : undefined)))
    qp.onDidHide(() => {
      res(undefined)
      qp.dispose()
      o.onHide?.()
    })
    qp.show()
  })
}
