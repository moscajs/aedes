const { fork, execSync } = require('node:child_process')
const { cpus } = require('node:os')
const path = require('node:path')

const gitBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim()
const numCores = cpus().length
const cpuType = cpus()[0].model.trim()

const scripts = {
  server: path.join(__dirname, 'server.js'),
  sender: path.join(__dirname, 'sender.js'),
  receiver: path.join(__dirname, 'receiver.js'),
  pingpong: path.join(__dirname, 'pingpong.js'),
}

function spawn (script, cmdArgs = [], msgType = 'rate', args = {}) {
  const child = fork(script, cmdArgs, { env: { ...process.env, ...args } })
  const results = []
  child.on('message', msg => {
    if (msg.type === msgType) results.push(msg.data)
  })
  return { child, results }
}

async function throughputTest (scripts, qos, warmupCount, maxCount) {
  console.error('Starting test for QoS', qos)
  await new Promise(resolve => {
    console.error(`Starting warmup for QoS${qos}`)
    // 1. Start server (no rates to collect)
    const server = fork(scripts.server)

    // 2. Start throughput receiver
    const receiver = spawn(scripts.receiver, [`-q ${qos}`], 'rate')

    // 3. Start throughput sender
    const sender = spawn(scripts.sender, [`-q ${qos}`], 'rate')
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
          console.log(`${gitBranch}, sender.js,${config} , ${result}`)
        }
        for (const result of receiver.results) {
          console.log(`${gitBranch}, receiver.js,${config} , ${result}`)
        }
        resolve()
      }
    }
  })
}
async function latencyTest (scripts, qos, warmupCount, maxCount, score) {
  console.error('Starting latency test for QoS', qos)
  await new Promise(resolve => {
    console.error(`Starting warmup for QoS${qos}`)
    // 1. Start server (no rates to collect)
    const server = fork(scripts.server)

    // 2. Start latency measurement
    const pingpong = spawn(scripts.pingpong, [`-q ${qos}`], 'latency')
    const config = `"QoS=${qos}, Cores=${numCores}, Score='${score}'"`
    pingpong.child.on('message', checkDone)

    // 4. Collect and print latency
    let counter = 0
    function checkDone () {
      counter++
      process.stderr.write('.')
      if (counter === warmupCount) {
        console.error('\n starting measurement')
        pingpong.results.length = 0
      }
      if (counter === (maxCount + warmupCount)) {
        pingpong.child.kill()
        server.kill()
        for (const result of pingpong.results) {
          console.log(`${gitBranch}, pingpong.js ,${config} , ${result[score]}`)
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
  await throughputTest(scripts, 0, opts.warmupCount, opts.maxCount)
  await throughputTest(scripts, 1, opts.warmupCount, opts.maxCount)
  await latencyTest(scripts, 1, opts.warmupCount, opts.maxCount, opts.latencyScore)
  console.error('Tests done')
  process.exit(0)
}

const defaultopts = {
  warmupCount: 5,
  maxCount: 10,
  latencyScore: 'perc95'   // valid score names are mean, median, perc95 and perc99
}
main(defaultopts).catch(err => {
  console.error('Error in main:', err)
  process.exit(1)
})
