// The understanding check: its code is in src/check/ (index.ts is the controller). This file keeps `./check` the
// module that extension.ts imports (and keeps an older build's out/src/check.js from shadowing the folder).
export * from './check/index'
