# Migration

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
