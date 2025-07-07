#! /usr/bin/env node

const readline = require('readline')

const defaultUnit = 'msg/s' // default unit for the results
const units = {
  'pingpong.js': 'ms'
}

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
    const config = fields[2]
    const parsedConfig = parseConfig(config)
    const value = Number(fields[3])
    const key = `${benchmark} QoS${parsedConfig.QoS}`
    if (!results[label]) {
      results[label] = {}
    }
    const resultsL2 = results[label]
    if (!resultsL2[key]) {
      resultsL2[key] = {
        values: [],
        benchmark,
        config,
        unit: units[benchmark] || defaultUnit
      }
    }
    const resultsL3 = resultsL2[key]
    resultsL3.values.push(value)
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

  console.log(`\n # Benchmark Results for ${label}`)
  console.log(`|Benchmark | Config | Units | ${roundLabels.join(' |')}`)
  console.log(`|----------|--------|-------|${roundLabels.map(() => '---').join('|')}`)
  for (const key in results) {
    const { unit, values, benchmark, config } = results[key]
    console.log(`| ${benchmark} | ${config} | ${unit}| ${values.join(' |')}`)
  }
  console.log('\n')
}

function calculateAverages (results) {
  const avg = {}
  for (const label in results) {
    const resultsL2 = results[label]
    for (const key in resultsL2) {
      const { unit, values, benchmark, config } = resultsL2[key]
      if (!avg[key]) {
        avg[key] = {}
      }
      avg[key][label] = {
        value: values.reduce((acc, num) => acc + num, 0) / values.length,
        benchmark,
        unit,
        config
      }
    }
  }
  return avg
}

function reportAverages (avg) {
  console.log('\n # Overall Benchmark Results')
  console.log('| Label | Benchmark | Config | Average | Units | Percentage')
  console.log('|-------|-----------|--------|---------|-------|-----------')
  for (const key in avg) {
    let perc
    let ref
    for (const label in avg[key]) {
      const { value, unit, benchmark, config } = avg[key][label]
      if (perc === undefined) {
        perc = 100
        ref = value
      } else {
        perc = ((value / ref) * 100).toFixed(2)
      }
      console.log(`| ${label} | ${benchmark} | ${config} | ${value.toFixed(0)} | ${unit} | ${perc}%`)
    }
  }
}

async function report () {
  const { results, maxCounts } = await gatherData()
  const avg = calculateAverages(results)
  reportAverages(avg)
  for (const label in results) {
    reportPerLabel(label, results[label], maxCounts)
  }
}

report()
