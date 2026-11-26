import { execFile } from 'node:child_process';

export const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Run a program (never through a shell). Rejects with stderr on failure. */
export function run(cmd, args, { input, timeout = 20000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 20 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).toString().trim().slice(0, 300))) : resolve(stdout)));
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Call fn every ms milliseconds, never overlapping itself. Returns a function that runs it now. */
export function loop(fn, ms) {
  let timer = null;
  let running = false;
  const tick = async () => {
    clearTimeout(timer);
    if (running) return;
    running = true;
    try { await fn(); } catch (e) { log('loop error:', e.message); }
    running = false;
    timer = setTimeout(tick, typeof ms === 'function' ? ms() : ms);
  };
  tick();
  return tick;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
