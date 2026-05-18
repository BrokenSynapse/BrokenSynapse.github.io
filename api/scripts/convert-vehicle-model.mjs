import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] || fallback : fallback;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
  });
}

const input = path.resolve(arg('--input'));
const output = path.resolve(arg('--output'));
const blender = process.env.BLENDER_BIN || arg('--blender', 'blender');
const script = path.resolve('scripts/blender-convert-vehicle.py');

if (!input || !output) {
  throw new Error('Usage: node scripts/convert-vehicle-model.mjs --input <source-dir> --output <model.glb> [--blender blender]');
}

await fs.mkdir(path.dirname(output), { recursive: true });
const result = await run(blender, ['--background', '--factory-startup', '--python', script, '--', input, output]);
let outputStat = null;
try {
  outputStat = await fs.stat(output);
} catch {}

const ok = result.code === 0 && !!outputStat && outputStat.size > 0;
const report = {
  ok,
  input,
  output,
  blender: blender,
  blenderExitCode: result.code,
  outputExists: !!outputStat,
  outputBytes: outputStat ? outputStat.size : 0,
  blenderStdout: result.out.slice(-24000),
  blenderStderr: result.err.slice(-24000)
};

console.log(JSON.stringify(report, null, 2));
if (!ok) {
  process.exitCode = 1;
}
