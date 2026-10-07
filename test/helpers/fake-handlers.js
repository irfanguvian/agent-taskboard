'use strict';
// Test preload (NODE_OPTIONS=--require <this>): registers a no-op handler for every <kind>/<phase> dir
// under TB_PHASES_DIR, so fixture phases count as built. Production never loads this file.
const fs = require('node:fs');
const path = require('node:path');
const phases = require('../../lib/phases');

const dir = process.env.TB_PHASES_DIR;
for (const kind of dir ? fs.readdirSync(dir) : []) {
  for (const phase of fs.readdirSync(path.join(dir, kind))) phases.registerHandler(`${kind}/${phase}`, async () => {});
}
