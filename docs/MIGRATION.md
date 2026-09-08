# Migration

## MQTT 5.0 Enhanced Authentication (§4.12)

A v5 `CONNECT` carrying an Authentication Method is now handled by the new
[`authenticateEnhanced`](Aedes.md#handler-authenticateenhanced-client-method-data-callback)
hook. __Behaviour change:__ when that hook is not configured (the default), such
a `CONNECT` is now rejected with CONNACK reason code `0x8C` (Bad authentication
method). Previously the Authentication Method was ignored and the client fell
through to the username/password
[`authenticate`](Aedes.md#handler-authenticate-client-username-password-callback)
hook, typically getting CONNACK `0x00`.

If you have SCRAM- or OAuth-capable clients that send an Authentication Method
and you have not opted into enhanced auth, they will stop connecting. To restore
them, set `authenticateEnhanced` and implement the exchange (see the handler
docs). When it is set, the two hooks __chain__: `authenticateEnhanced` runs the
AUTH exchange, then your existing `authenticate` hook runs as before (with
`username`/`password`), so per-IP/allow-list policy there still applies.

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

- aedes-persistence: 10.2.2
- aedes-persistence-level: 9.1.2
- aedes-persistence-mongodb: 9.3.1
- aedes-persistence-redis: 11.2.1
