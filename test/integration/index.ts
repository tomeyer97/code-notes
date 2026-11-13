import { run as suite } from './suite'

export async function run(): Promise<void> {
  console.log('code-notes integration test')
  await suite()
  console.log('all passed')
}
