#!/usr/bin/env node
'use strict';
// P1 AC5 idle probe: tbd on a temp TB_HOME with 200 reminders + 1 SSE client; samples RSS + cputime
// every 30 s for --minutes N (default 10). Target: peak RSS < 80 MB, cputime delta < 6 s.
// Usage: node scripts/measure-idle.js [--minutes 10]
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { startTbd } = require('../test/helpers/tbd');

const i = process.argv.indexOf('--minutes');
const minutes = i > 0 ? Number(process.argv[i + 1]) : 10;
if (!(minutes > 0)) {
  console.error('error: --minutes must be a number > 0');
  process.exit(2);
}

// ps time= is [[dd-]hh:]mm:ss.cc
const seconds = (t) => t.split(/[-:]/).reduce((acc, p) => acc * 60 + Number(p), 0);
const sample = (pid) => new Promise((resolve, reject) => {
  execFile('ps', ['-o', 'rss=,time=', '-p', String(pid)], (err, out) => {
    if (err) return reject(err);
    const [rss, time] = out.trim().split(/\s+/);
    resolve({ rss_mb: Number(rss) / 1024, cpu_s: seconds(time) });
  });
});

async function main() {
  const tasks = Array.from({ length: 200 }, (_, n) => ({
    id: `t_${String(n).padStart(6, '0')}`, type: 'reminder', title: `idle reminder ${n}`,
    status: ['inbox', 'now', 'next', 'later', 'done'][n % 5], created: '2026-10-01',
  }));
  const tbd = await startTbd({ files: { 'tasks.json': { tasks } } });
  const pid = Number(fs.readFileSync(path.join(tbd.tbHome, 'tbd.pid'), 'utf8'));
  const sse = http.get({ host: '127.0.0.1', port: tbd.port, path: '/events' }, (res) => res.resume());
  const samples = [await sample(pid)];
  console.log(`tbd pid ${pid}, ${minutes} min, sampling every 30 s`);
  console.log(`t=0s rss=${samples[0].rss_mb.toFixed(1)}MB cpu=${samples[0].cpu_s.toFixed(2)}s`);
  for (let s = 30; s <= minutes * 60; s += 30) {
    await new Promise((r) => setTimeout(r, 30_000));
    const x = await sample(pid);
    samples.push(x);
    console.log(`t=${s}s rss=${x.rss_mb.toFixed(1)}MB cpu=${x.cpu_s.toFixed(2)}s`);
  }
  sse.destroy();
  await tbd.stop();
  const peak = Math.max(...samples.map((x) => x.rss_mb));
  const cpu = samples.at(-1).cpu_s - samples[0].cpu_s;
  console.log(JSON.stringify({ minutes, peak_rss_mb: Number(peak.toFixed(1)), cputime_delta_s: Number(cpu.toFixed(2)), rss_ok: peak < 80, cpu_ok: cpu < 6 }));
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
