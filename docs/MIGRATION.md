# Migration

## From 1.x to 2.x

- Node.js 22.19.0 or later is required. aedes 2.x depends on mqtt-packet 10,
  which is ESM-only and relies on `require(esm)`.
- The default export is gone. In 1.x it was a stub that threw a migration
  error; in 2.x it does not exist. Use the named export, as shown below for
  0.x to 1.x.
- CommonJS keeps working through `require(esm)`:
  `const { Aedes } = require('aedes')`.

## From 0.x to 1.x

Version 1.x changes the persistence interface from callback to async/await.
This also means that the startup of Aedes needs to be awaited to avoid race
 conditions. 1.x also removed the default export to avoid mixups between old
  and new behaviour.

### ESM/Typescript

If you previously had code that looks like:

```js
import aedes from 'aedes'
const broker = aedes(opts)
```

You should replace it by:

```js
import { Aedes } from 'aedes'
const broker = await Aedes.createBroker(opts)
```

### Commonjs

If you previously had code that looks like:

```js
const aedes = require('aedes')
const broker = aedes(opts)
```

You should replace it by:

```js
const { Aedes } = require('aedes')
const broker = await Aedes.createBroker(opts)
```

Make sure that the persistence interface that you use is recent enough so that
it supports the new async interface. Aedes will exit if it does not find an
async persistence interface.
The following versions are the minimum versions to use:

- aedes-persistence: 11.0.0
- aedes-persistence-level: 9.1.2
- aedes-persistence-mongodb: 9.3.1
- aedes-persistence-redis: 11.2.1

aedes-persistence 11.0.0 adds `cleanIncoming(client)`, which aedes calls on a
clean-session CONNECT to discard the inbound QoS 2 dedup table as
[MQTT-3.1.2-6] requires (GHSA-p8r9-qf8w-p73r). aedes feature-detects the method,
so an older persistence keeps working — but until your persistence implements
it, a client reconnecting with `cleanSession` set can still have its first
colliding `messageId` acknowledged and silently dropped. The level, mongodb and
redis persistences need a release carrying this method before they are clear;
check their changelogs.
