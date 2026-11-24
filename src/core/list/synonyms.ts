// Words a question may use for the same thing: a question's word also finds its group's other words (match.ts,
// scoreJourney). Data only, so the table can be read and extended in one place. It was measured on real journeys
// (match.ts's header); some groups (env, cert, deploy, teardown) lean towards infrastructure code.

export const SYNONYMS: readonly (readonly string[])[] = [
  ['update', 'change', 'modify', 'edit', 'upgrade'],
  ['delete', 'remove', 'drop', 'destroy'],
  ['create', 'add', 'new', 'make'],
  ['start', 'launch', 'begin', 'boot'],
  ['stop', 'end', 'halt', 'teardown', 'shutdown'],
  ['auth', 'authentication', 'login', 'signin', 'sign'],
  ['permission', 'rbac', 'access', 'role', 'authorization'],
  ['save', 'store', 'persist', 'storage', 'write'],
  ['load', 'read', 'fetch'],
  ['test', 'check', 'verify', 'verdict'],
  ['deploy', 'install', 'release', 'rollout'],
  ['error', 'fail', 'failure', 'crash'],
  ['config', 'configuration', 'setting', 'settings'],
  ['user', 'account', 'member'],
  ['env', 'environment'],
  ['cert', 'certificate', 'tls', 'ssl'],
]
