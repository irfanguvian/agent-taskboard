'use strict';
// R-C: NODE_OPTIONS --require preload for scripts/measure-idle.js --modules. Writes the loaded files
// (Object.keys(require.cache)) to stderr as one line `mods-dump <json array>` on SIGUSR2, and once after MODS_DUMP_MS
// (default 5000). Never in an RSS sample run: the listener and the timer are not tbd's own.
const dump = () => process.stderr.write(`mods-dump ${JSON.stringify(Object.keys(require.cache))}\n`);
process.on('SIGUSR2', dump);
setTimeout(dump, Number(process.env.MODS_DUMP_MS) || 5000).unref();
