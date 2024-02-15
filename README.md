<!-- markdownlint-disable MD013 -->
# Aedes

![ci](https://github.com/moscajs/aedes/workflows/ci/badge.svg)
[![js-standard-style](https://img.shields.io/badge/code%20style-standard-brightgreen.svg?style=flat)](https://standardjs.com/)
[![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg)](https://github.com/moscajs/aedes/graphs/commit-activity)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/moscajs/aedes/pulls)\
[![Coverage Status](https://coveralls.io/repos/moscajs/aedes/badge.svg?branch=main&service=github)](https://coveralls.io/github/moscajs/aedes?branch=main)
[![Known Vulnerabilities](https://snyk.io/test/github/moscajs/aedes/badge.svg)](https://snyk.io/test/github/moscajs/aedes)\
![node](https://img.shields.io/node/v/aedes)
[![NPM version](https://img.shields.io/npm/v/aedes.svg?style=flat)](https://www.npmjs.com/aedes)
[![NPM downloads](https://img.shields.io/npm/dm/aedes.svg?style=flat)](https://www.npmjs.com/aedes)

[![opencollective](https://opencollective.com/aedes/donate/button.png)](https://opencollective.com/aedes/donate)

Barebone MQTT server that can run on any stream servers

- [Aedes](#aedes)
  - [Install](#install)
  - [Docker](#docker)
  - [API](#api)
  - [Features](#features)
  - [Examples](#examples)
  - [Clusters](#clusters)
  - [Extensions](#extensions)
  - [Middleware Plugins](#middleware-plugins)
    - [Persistence](#persistence)
    - [MQEmitter](#mqemitter)
  - [Acknowledgements](#acknowledgements)
  - [Mosca vs Aedes](#mosca-vs-aedes)
    - [Benchmark: Aedes](#benchmark-aedes)
      - [In memory - No clusters](#in-memory---no-clusters)
      - [Redis Persistence and Redis Emitter - With Clusters](#redis-persistence-and-redis-emitter---with-clusters)
      - [Mongo Persistence and Redis Emitter - With Clusters](#mongo-persistence-and-redis-emitter---with-clusters)
    - [Redis Persistence and Mongodb Emitter - With Clusters](#redis-persistence-and-mongodb-emitter---with-clusters)
    - [Benchmark: Mosca](#benchmark-mosca)
  - [Made with Aedes](#made-with-aedes)
  - [Collaborators](#collaborators)
  - [Contribution](#contribution)
  - [Support](#support)
    - [Backers](#backers)
    - [Sponsors](#sponsors)
  - [License](#license)

## Install

To install aedes, simply use npm:

```sh
npm install aedes
```

## Docker

Check Docker docs [here](https://github.com/moscajs/aedes-cli#docker)

## API

- [Aedes object](./docs/Aedes.md)
- [Client object](./docs/Client.md)

## Features

- Full compatible with [MQTT 3.1 and 3.1.1][ISO20922]
- Standard TCP Support
- SSL / TLS
- WebSocket Support
- Message Persistence
- Automatic Reconnect
- Offline Buffering
- Backpress-support API
- High Availability
- Clusterable
- Authentication and Authorization
- `$SYS` support
- Pluggable middlewares
- [Dynamic Topics][dynamic_topics] Support
- MQTT Bridge Support between aedes
- [MQTT 5.0][mqttv5] _(not support yet)_
- [Bridge Protocol][bridge_protocol] _(incoming connections only)_

## Examples

- [Examples](./docs/Examples.md)

## Clusters

Aedes needs on disk dbs like MongoDB and Redis in order to work with clusters. Based on our tests and users reports the best performances/stability are reached when using [aedes-persistence-mongodb] paired with [mqemitter-redis].

Other info:

- The repo [aedes-tests](https://github.com/moscajs/aedes-tests) is used to test aedes with clusters and different emitters/persistences. Check its source code to have a starting point on how to work with clusters

## Bridge connections

Normally, when publishing a message, the `retain` flag is consumed by Aedes and
then set to `false`.  This is done for two reasons:

- MQTT-3.3.1-9 states that it MUST set the RETAIN flag to 0 when a PUBLISH
  Packet is sent to a Client because it matches an established subscription
  regardless of how the flag was set in the message it received.
- When operating as a cluster, only one Aedes node may store the packet

Brokers that support the [Bridge Protocol][bridge_protocol] can connect to
Aedes.  When connecting with this special protocol, subscriptions work as usual
except that the `retain` flag in the packet is propagated as-is.

## Extensions

- [aedes-logging]: Logging module for Aedes, based on Pino
- [aedes-stats]: Stats for Aedes
- [aedes-cli]: Run Aedes MQTT Broker from the CLI
- [aedes-protocol-decoder]: Protocol decoder for Aedes MQTT Broker
- [aedes-server-factory]: Create a server instance such as TCP, HTTP, TLS...

## Middleware Plugins

### Persistence

- [aedes-persistence]: In-memory implementation of an Aedes persistence
- [aedes-persistence-mongodb]: MongoDB persistence for Aedes
- [aedes-persistence-redis]: Redis persistence for Aedes
- [aedes-persistence-level]: LevelDB persistence for Aedes
- [aedes-persistence-nedb]: NeDB persistence for Aedes

### MQEmitter

- [mqemitter]: An opinionated memory Message Queue with an emitter-style API
- [mqemitter-redis]: Redis-powered mqemitter
- [mqemitter-mongodb]: Mongodb based mqemitter
- [mqemitter-child-process]: Share the same mqemitter between a hierarchy of
  child processes
- [mqemitter-cs]: Expose a MQEmitter via a simple client/server protocol
- [mqemitter-p2p]: A P2P implementation of MQEmitter, based on HyperEmitter and
  a Merkle DAG
- [mqemitter-aerospike]: Aerospike mqemitter

## Acknowledgements

This library is born after a lot of discussion with all
[Mosca](http://www.npmjs.com/mosca) users and how that was deployed in
production. This addresses your concerns about performance and stability.

## Mosca vs Aedes

Example benchmark test with 1000 clients sending 5000 QoS 1 messsages. Used
[mqtt-benchmark] with command:

```sh
mqtt-benchmark --broker tcp://localhost:1883 --clients 1000 --qos 1 --count 5000
```

CPU INFO:

```sh
Architecture:        x86_64
CPU op-mode(s):      32-bit, 64-bit
Byte Order:          Little Endian
CPU(s):              8
On-line CPU(s) list: 0-7
Thread(s) per core:  2
Core(s) per socket:  4
Socket(s):           1
NUMA node(s):        1
Vendor ID:           GenuineIntel
CPU family:          6
Model:               94
Model name:          Intel(R) Core(TM) i7-6700HQ CPU @ 2.60GHz
Stepping:            3
CPU MHz:             800.014
CPU max MHz:         3500,0000
CPU min MHz:         800,0000
BogoMIPS:            5199.98
Virtualization:      VT-x
L1d cache:           32K
L1i cache:           32K
L2 cache:            256K
L3 cache:            6144K
```

### Benchmark: Aedes

#### In memory - No clusters

```sh
========= TOTAL (1000) =========
Total Ratio:                 1.000 (5000000/5000000)
Total Runtime (sec):         178.495
Average Runtime (sec):       177.845
Msg time min (ms):           0.077
Msg time max (ms):           199.805
Msg time mean mean (ms):     35.403
Msg time mean std (ms):      0.042
Average Bandwidth (msg/sec): 28.115
Total Bandwidth (msg/sec):   28114.678
```

#### Redis Persistence and Redis Emitter - With Clusters

```sh
========= TOTAL (1000) =========
Total Ratio:                 1.000 (5000000/5000000)
Total Runtime (sec):         114.404
Average Runtime (sec):       109.022
Msg time min (ms):           0.065
Msg time max (ms):           393.214
Msg time mean mean (ms):     21.520
Msg time mean std (ms):      0.595
Average Bandwidth (msg/sec): 45.896
Total Bandwidth (msg/sec):   45896.306
```

#### Mongo Persistence and Redis Emitter - With Clusters

```sh
========= TOTAL (1000) =========
Total Ratio:                 1.000 (5000000/5000000)
Total Runtime (sec):         112.769
Average Runtime (sec):       105.524
Msg time min (ms):           0.062
Msg time max (ms):           329.062
Msg time mean mean (ms):     20.750
Msg time mean std (ms):      0.878
Average Bandwidth (msg/sec): 47.464
Total Bandwidth (msg/sec):   47464.271
```

### Redis Persistence and Mongodb Emitter - With Clusters

```sh
========= TOTAL (1000) =========
Total Ratio:                 1.000 (5000000/5000000)
Total Runtime (sec):         118.587
Average Runtime (sec):       114.190
Msg time min (ms):           0.080
Msg time max (ms):           324.028
Msg time mean mean (ms):     22.558
Msg time mean std (ms):      0.730
Average Bandwidth (msg/sec): 43.832
Total Bandwidth (msg/sec):   43831.927
```

### Benchmark: [Mosca](http://www.npmjs.com/mosca)

```sh
========= TOTAL (1000) =========
Total Ratio:                 1.000 (5000000/5000000)
Total Runtime (sec):         264.934
Average Runtime (sec):       264.190
Msg time min (ms):           0.070
Msg time max (ms):           168.116
Msg time mean mean (ms):     52.629
Msg time mean std (ms):      0.074
Average Bandwidth (msg/sec): 18.926
Total Bandwidth (msg/sec):   18925.942
```

## Made with Aedes

Here is a list of some interesting projects that are using Aedes as MQTT Broker. Submit a PR or an issue if you would like to add yours

- [node-red-contrib-aedes](https://github.com/martin-doyle/node-red-contrib-aedes): MQTT broker for Node-Red based on Aedes
- [Mqtt2Mqtt](https://github.com/robertsLando/Mqtt2Mqtt): Mqtt Bridge between two brokers with UI
- [Kuzzle](https://github.com/kuzzleio/kuzzle): High performance and full featured IoT backend using MQTT alongside WebSocket and Http protocols

## Collaborators

- [__Gavin D'mello__](https://github.com/GavinDmello)
- [__Behrad Zari__](https://github.com/behrad)
- [__Gnought__](https://github.com/gnought)
- [__Daniel Lando__](https://github.com/robertsLando)
- [__Getlarge__](https://github.com/getlarge)

## Contribution

[![Help wanted](https://img.shields.io/github/labels/moscajs/aedes/help%20wanted)](https://github.com/moscajs/aedes/labels/help%20wanted)
[![Contributors](https://img.shields.io/github/contributors/moscajs/aedes)](https://github.com/moscajs/aedes/graphs/contributors)

Want to contribute? Check our list of
[features/bugs](https://github.com/moscajs/aedes/projects/1)

## Security notice

Messages sent to the broker are considered _valid_ once they pass the [`authorizePublish`](./docs/Aedes.md#handler-authorizepublish-client-packet-callback) callback.
In other terms, if permissions for the given client are revoked after the call completes, the message is still considered valid.
In case you are sending time-sensitive messages, make sure to use QoS 0 or connect with a clean session.

## Support

If there are bugs/leaks in production scenarios, we encourage people to send Pull Request and/or reach out maintainers for some paid support.

### Backers

Thank you to all our backers! :raised_hands:

[![Backers](https://opencollective.com/aedes/backers.svg?avatarHeight=64&width=890&button=false)](https://opencollective.com/aedes#backers)

### Sponsors

Become a sponsor to get your logo on our README on Github

[![Sponsor](https://opencollective.com/aedes/sponsors.svg)](https://opencollective.com/aedes#sponsor)

## License

Licensed under [MIT](./LICENSE).

[ISO20922]: https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/mqtt-v3.1.1.html
[mqttv5]: https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html
[bridge_protocol]: https://github.com/mqtt/mqtt.github.io/wiki/bridge_protocol
[dynamic_topics]: https://github.com/mqtt/mqtt.github.io/wiki/are_topics_dynamic
[mqtt-benchmark]: https://github.com/krylovsk/mqtt-benchmark

[aedes-logging]: https://www.npmjs.com/aedes-logging
[aedes-stats]: https://www.npmjs.com/aedes-stats
[aedes-cli]: https://www.npmjs.com/aedes-cli
[aedes-protocol-decoder]: https://www.npmjs.com/aedes-protocol-decoder
[aedes-server-factory]: https://www.npmjs.com/aedes-server-factory
[aedes-persistence]: https://www.npmjs.com/aedes-persistence
[aedes-persistence-mongodb]: https://www.npmjs.com/aedes-persistence-mongodb
[aedes-persistence-redis]: https://www.npmjs.com/aedes-persistence-redis
[aedes-persistence-level]: https://www.npmjs.com/aedes-persistence-level
[aedes-persistence-nedb]: https://www.npmjs.com/aedes-persistence-nedb

[mqemitter]: https://www.npmjs.com/mqemitter
[mqemitter-redis]: https://www.npmjs.com/mqemitter-redis
[mqemitter-mongodb]: https://www.npmjs.com/mqemitter-mongodb
[mqemitter-child-process]: https://www.npmjs.com/mqemitter-child-process
[mqemitter-cs]: https://www.npmjs.com/mqemitter-cs
[mqemitter-p2p]: https://www.npmjs.com/mqemitter-p2p
[mqemitter-aerospike]: https://www.npmjs.com/mqemitter-aerospike
