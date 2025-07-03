#! /usr/bin/env node

const readline = require('readline')
const unit = 'msg/s' // default unit for the results

function parseConfig (config) {
  // parse config string like "QoS=0, Cores=2" into an object
  const configObj = {}
  const parts = config.split(',').map(part => part.trim())
  for (const part of parts) {
    const [key, value] = part.split('=').map(s => s.trim())
    if (key && value) {
      configObj[key] = value
    }
  }
  return configObj
}

async function gatherData () {
  // read CSV data from STDIN
  const results = {}
  let maxCounts = 0
  const rl = readline.createInterface({
    input: process.stdin
  })
  // split each line by comma but retain commas inside quotes
  for await (const line of rl) {
    const fields = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g).map(s => s.replace(/^"|"$/g, ''))
    const label = fields[0]
    if (!label) {
      continue // skips empty lines
    }
    const benchmark = fields[1]
    const config = parseConfig(fields[2])
    const value = Number(fields[3])
    const key = `${benchmark} QoS${config.QoS}`
    if (!results[label]) {
      results[label] = {}
    }
    const resultsL2 = results[label]
    if (!resultsL2[key]) {
      resultsL2[key] = { values: [] }
    }
    const resultsL3 = resultsL2[key]
    resultsL3.values.push(value)
    resultsL3.config = config
    if (resultsL3.values.length > maxCounts) {
      maxCounts = resultsL3.values.length
    }
  }
  return { results, maxCounts }
}

function reportPerLabel (label, results, maxCounts, avg) {
  const roundLabels = []
  for (let i = 0; i < maxCounts; i++) {
    roundLabels.push(`Round ${i + 1}`)
  }

  console.log(`\n # Benchmark Results ${label}`)
  console.log(`|Benchmark | Units | ${roundLabels.join(' |')}`)
  console.log(`|----------|-------|${roundLabels.map(() => '---').join('|')}`)
  for (const key in results) {
    console.log(`| ${key} | ${unit}| ${results[key].values.join(' |')}`)
    if (!avg[key]) {
      avg[key] = {}
    }
    avg[key][label] = results[key].values.reduce((acc, num) => acc + num, 0) / results[key].values.length
  }
  console.log('\n')
  return avg
}

async function report () {
  const { results, maxCounts } = await gatherData()
  const labels = Object.keys(results)
  const avg = {}
  for (const label of labels) {
    reportPerLabel(label, results[label], maxCounts, avg)
  }
  console.log(`\n # Combined Results`)
  console.log('| Label | Benchmark | Average | Units')
  console.log('|----------|---------|------|---')
  for (const key in avg) {
    for (const label in avg[key]) {
        console.log(`| ${label} | ${key} | ${avg[key][label].toFixed(0)} | ${unit} |`)
    }
  }
}

report()
