'use strict';
// sh: execFile that never rejects. Resolves { err, stdout, stderr }; err is null on exit 0.
// exec: execFile-shaped function, injectable for tests. opts.input: written to the child's stdin, then closed.
const { execFile } = require('node:child_process');

module.exports = (file, args, opts = {}, exec = /** @type {Function} */ (execFile)) => new Promise((resolve) => {
  const { input, ...o } = /** @type {any} */ (opts);
  const c = exec(file, args, { encoding: 'utf8', maxBuffer: 10 << 20, ...o }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  if (input !== undefined) {
    c.stdin.on('error', () => {}); // EPIPE: the child died first; its err says why
    c.stdin.end(input);
  }
});
