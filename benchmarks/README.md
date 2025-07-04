# Benchmarks

This folder contains a number of scripts to perform benchmark testing and
reporting on it:

- bombing.js publishes QoS0 messages
- bombingQoS.js publishes QoS1 messages
- throughputCounter.js subscribes using QOS0 and receives messages
- throughputCounterQoS1.js subscribes using QOS1 and receives messages
- pingpong.js measures latency between sending and receiving the same
message
- server.js starts the Aedes server to use in the test
- runBenchmarks.js starts the server and runs Publish/Subscribe tests
with QoS0 and QoS1 using the scripts above it produces CSV data, this
 data includes the current git branch name.
- report.js reads the CSV data from STDIN and turns it into a Markdown
report, see the 'examples' folder

Examples:

```bash
node runBenchmark.js > result.csv
cat result.csv | node report.csv > result.md
```

```bash
node runBenchmark.js > result.branch.csv
cat result.main.csv result.branch.csv | node report.csv > result.combined.md
```

## WARNING

Running benchmarks and especially interpreting results can be misleading
E.g. performance of the benchmark run might depend on the presence (or absence)
 of other, unrelated, activity in the system.
