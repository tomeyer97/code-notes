// A title as the text of a Markdown link: its brackets would end the link early, so they go. No vscode here.

/** `title` without `[` and `]`, to sit inside `[…](…)`. */
export const mdLabel = (title: string) => title.replace(/[[\]]/g, '')
