const { fork, execSync } = require('node:child_process')
const { cpus } = require('node:os')
const path = require('node:path')

const serverPath = path.join(__dirname, 'server.js')
const gitBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim()
const numCores = cpus().length
const cpuType = cpus()[0].model.trim()

const scripts = {
  QoS0: {
    server: serverPath,
    receiver: path.join(__dirname, 'throughputCounter.js'),
    sender: path.join(__dirname, 'bombing.js')
  },
  QoS1: {
    server: serverPath,
    receiver: path.join(__dirname, 'throughputCounterQoS1.js'),
    sender: path.join(__dirname, 'bombingQoS1.js')
  },
}

function spawn (script, args = {}) {
  const child = fork(script, [], { env: { ...process.env, ...args } })
  const results = []
  child.on('message', msg => {
    if (msg.type === 'rate') results.push(msg.data)
  })
  return { child, results }
}

async function QoStest (scripts, qos, warmupCount, maxCount) {
  console.error('Starting test for QoS', qos)
  await new Promise(resolve => {
    console.error(`Starting warmup for QoS${qos}`)
    // 1. Start server (no rates to collect)
    const server = fork(scripts[`QoS${qos}`].server)

    // 2. Start throughput listener
    const receiver = spawn(scripts[`QoS${qos}`].receiver)

    // 3. Start load generator
    const sender = spawn(scripts[`QoS${qos}`].sender)
    const config = `"QoS=${qos}, Cores=${numCores}"`
    sender.child.on('message', checkDone)

    // 4. Collect and print rates
    let counter = 0
    function checkDone () {
      counter++
      process.stderr.write('.')
      if (counter === warmupCount) {
        console.error('\n starting measurement')
        receiver.results.length = 0
        sender.results.length = 0
      }
      if (counter === (maxCount + warmupCount)) {
        sender.child.kill()
        receiver.child.kill()
        server.kill()
        for (const result of sender.results) {
          console.log(`${gitBranch}, Sender,${config} , ${result}`)
        }
        for (const result of receiver.results) {
          console.log(`${gitBranch}, Receiver,${config} , ${result}`)
        }
        resolve()
      }
    }
  })
}

async function main (opts) {
  console.error(`Running benchmarks on branch: ${gitBranch} using ${cpuType} with ${numCores} cores`)
  if (numCores < 3) {
    console.error('WARNING: Not enough CPU cores to run proper benchmarks, at least 4 cores are recommended')
  }
  await QoStest(scripts, 0, opts.warmupCount, opts.maxCount)
  await QoStest(scripts, 1, opts.warmupCount, opts.maxCount)
  console.error('Tests done')
  process.exit(0)
}

const defaultopts = {
  warmupCount: 5,
  maxCount: 10
}
main(defaultopts).catch(err => {
  console.error('Error in main:', err)
  process.exit(1)
})
