// The panel's key router: one document keydown listener that asks the parts of the panel in their order of priority
// whether a key is theirs (the first that owns it ends the search). The tutorial is first: while a card is up its
// keys are the tutorial's. The map (journey-graph.js) and the home (journey-home.js) still listen on their own and
// stay out while the tutorial is up (host.isTutorialUp()).

/** @param {((e: KeyboardEvent) => boolean)[]} owners in their order of priority; each returns whether it owned `e` */
export function routeKeys(owners) {
  document.addEventListener('keydown', (e) => {
    for (const owns of owners) if (owns(e)) return
  })
}
