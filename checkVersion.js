// node 20 on windows has issues with node:test wildcard
// this script is only used by package.json
// example of usage in package.json:
// "unit": "node checkVersion.js && npm run unit:v20win32 || npm run unit:other",
// "unit:v20win32": "node --test --test-timeout=180000",
// "unit:other": "node --test --test-timeout=180000 test/*.js test/*.cjs",

import { platform, version, exit } from 'node:process'

const major = version.split('.')[0]
let exitCode = 1
// node 20 on windows returns 0
if ((major === 'v20') && platform === 'win32') {
  exitCode = 0
}
// all the others 1
console.log(`Running ${major} on ${platform} returning exitCode ${exitCode}`)
exit(exitCode)
