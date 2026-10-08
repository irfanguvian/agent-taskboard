'use strict';
// sh: execFile that never rejects. Resolves { err, stdout, stderr }; err is null on exit 0.
// exec: execFile-shaped function, injectable for tests.
const { execFile } = require('node:child_process');

module.exports = (file, args, opts = {}, exec = /** @type {Function} */ (execFile)) => new Promise((resolve) => {
  exec(file, args, { encoding: 'utf8', maxBuffer: 10 << 20, ...opts }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
});
