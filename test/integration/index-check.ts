import { run as suite } from './check'

export async function run(): Promise<void> {
  console.log('code-notes understanding check')
  await suite()
  console.log('all passed')
}
