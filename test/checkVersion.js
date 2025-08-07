// node 20 on windows has issues with node:test wildcards
import { platform, version } from 'node:process'
const major = version.split('.')[0]
console.log(`Running ${major} on ${platform}`)
if ((major === 'v20') || platform === 'win32') {
  process.exit(0)
}
process.exit(1)
