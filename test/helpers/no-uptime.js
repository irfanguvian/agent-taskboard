'use strict';
// Test preload (NODE_OPTIONS=--require <this>): os.uptime throws as it does inside a board run's sandbox (libuv
// uv_uptime EPERM), so tbd's claimPid runs with no boot time. Production never loads this file.
const os = require('node:os');

os.uptime = () => {
  throw new Error('A system error occurred: uv_uptime returned EPERM (operation not permitted)');
};
