// What check.mjs measures in a scene, by class (media/journey-scene.css). A text in an actor box that none of these
// cover fails the check ("text no check covers"), so a new actor's text is never silently left unchecked: add its
// class to TEXT (it must fit its box) or to CUT (it may end in "…").

/** Text that must fit its box: never wider than it. */
export const TEXT = [
  // the frame every actor has
  '.scn-label',
  // service, table, cluster
  '.scn-fn',
  '.scn-check',
  '.scn-row',
  '.scn-pod',
  '.scn-inner-label',
  // terminal, file, chat, queue, gauge
  '.tm-line',
  '.fl-line',
  '.ch-msg.on',
  '.qu-note',
  '.qu-drop',
  '.ga-note',
  // the browser
  '.br-url',
  '.br-addr',
  '.br-top > b',
  '.br-cart',
  '.br-name',
  '.br-btn',
  '.br-mark span',
  // the web app
  '.ap-top *',
  '.ap-dialog *',
  '.ap-logo',
  '.ap-tr',
  '.ap-start',
  '.ap-title',
  '.ap-title > b',
  '.ap-card',
  '.ap-none',
  '.ap-ctitle',
  '.ap-ev',
  '.ap-ev span',
  '.ap-msg.on',
  '.ap-box',
  '.ap-row.on b',
  '.ap-row.on span',
  '.ap-banner.on',
  '.ap-picnote',
  '.ap-stitle',
  '.ap-notice',
  '.ap-signin',
].join(', ')

/** Text a box may cut with "…" (it says so in the stylesheet), or a word too short to overflow. */
export const CUT = [].join(', ')

/** What must stay inside its actor's box. */
export const IN_ACTOR = [
  '.scn-label',
  '.scn-fn',
  '.scn-check',
  '.scn-row',
  '.scn-pod',
  '.scn-inner',
  '.tm-line',
  '.br-card',
  '.br-cartw',
  '.ap-tabs',
  '.ap-dialog',
  '.ap-card',
  '.ap-ev',
  '.ap-signwrap',
].join(', ')
