// Release preflight: every production dependency must resolve to the npm
// registry. During MQTT 5.0 integration the companion packages are pinned to
// git fork SHAs on the mqttv5 branch; this guard ensures a release/publish to
// main can never accidentally ship those personal-fork sources.
//
// Run via `npm run check:deps`; wired into the release-it before:init hook.
import pkg from '../package.json' with { type: 'json' }

// A registry range is a plain semver spec (e.g. ^3.0.0, ~1.2, 1.x). Anything
// pointing at git/file/url sources is rejected.
const NON_REGISTRY = /^(github:|git\+|git:|git@|file:|link:|https?:|ssh:)/

const offenders = Object.entries(pkg.dependencies || {})
  .filter(([, spec]) => NON_REGISTRY.test(spec) || spec.includes('/'))

if (offenders.length > 0) {
  console.error('Release blocked: production dependencies must resolve to the npm registry,')
  console.error('but the following point at a non-registry (git/file/url) source:')
  for (const [name, spec] of offenders) {
    console.error(`  - ${name}: ${spec}`)
  }
  console.error('Flip these to published version ranges before releasing.')
  process.exit(1)
}

console.log('OK: all production dependencies resolve to the npm registry.')
