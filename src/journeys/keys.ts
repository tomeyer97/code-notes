// The keys the journeys' maps are kept by: each built in one place and typed apart, so a map by one kind of key can't
// be asked with another. The strings are what the stored state is under (followed edits, renames): never change one.
// No vscode here: unit-tested.
import type { JStep } from '../core/format/journeyModel'
import { folderFileKey } from '../platform/keys'

declare const kind: unique symbol
type Key<K extends string> = string & { readonly [kind]: K }

/** One step of one loaded journey, as written: `<journey key>|<step id>|<file>:<written start>`. */
export type StepKey = Key<'step'>
/** A file in a workspace folder, the same for every journey: `<folder uri>|<path>` (platform/keys.ts). */
export type FileInFolderKey = Key<'fileInFolder'>
/** One journey's steps in one file: `<journey key>|<path>`. */
export type JourneyFileKey = Key<'journeyFile'>

export const keys = {
  step: (journeyKey: string, s: Pick<JStep, 'id' | 'file' | 'range'>) => `${journeyKey}|${s.id}|${s.file}:${s.range.start}` as StepKey,
  fileIn: (folder: { toString(): string } | string, file: string) => folderFileKey(folder, file) as FileInFolderKey,
  journeyFile: (journeyKey: string, file: string) => `${journeyKey}|${file}` as JourneyFileKey,
}
