#!/usr/bin/env node
// Action entrypoint: opens the office pane. Shells out to the Herdr CLI rather
// than the raw socket so it behaves the same on Windows named pipes.
import { spawnSync } from 'node:child_process';

const bin = process.env.HERDR_BIN_PATH || 'herdr';
const popup = process.argv.includes('--popup');
const args = [
  'plugin',
  'pane',
  'open',
  '--plugin',
  process.env.HERDR_PLUGIN_ID || 'office.view',
  '--entrypoint',
  popup ? 'office-popup' : 'office',
];
if (!popup) args.push('--focus');

const res = spawnSync(bin, args, { stdio: 'inherit' });
process.exit(res.status ?? 1);
