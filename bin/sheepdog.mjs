#!/usr/bin/env node
// Start Sheepdog and open the board in the browser (pass --no-open to skip).
import { spawn } from 'node:child_process';
import '../server/index.mjs';

const port = Number(process.env.SHEEPDOG_PORT || 4848);
if (!process.argv.includes('--no-open')) {
  const url = `http://127.0.0.1:${port}/`;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  setTimeout(() => spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(), 800);
}
