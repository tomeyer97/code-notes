// The extension's settings (`codeNotes.*`): the one way they are read.
import * as vscode from 'vscode'

export const cfg = () => vscode.workspace.getConfiguration('codeNotes')
