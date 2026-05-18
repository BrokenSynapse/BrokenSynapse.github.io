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

async function walk(root) {
  const out = [];
  async function visit(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else out.push(full);
    }
  }
  await visit(root);
  return out;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function maybeConvertKn5(input) {
  const files = await walk(input);
  const kn5 = files.filter(file => path.extname(file).toLowerCase() === '.kn5');
  if (!kn5.length) return { attempted: false, files: [] };

  const alreadyUsable = files.some(file => ['.dae', '.fbx', '.obj'].includes(path.extname(file).toLowerCase()));
  const converter = process.env.KN5_CONVERTER_SCRIPT || '/opt/kn5-obj-converter/convert.py';
  if (!await exists(converter)) {
    return {
      attempted: true,
      ok: false,
      files: kn5.map(file => path.relative(input, file).replace(/\\/g, '/')),
      skippedReason: alreadyUsable
        ? `KN5 converter not installed at ${converter}; using other model files if available.`
        : `KN5 converter not installed at ${converter}. Install MarvinSt/kn5-obj-converter or set KN5_CONVERTER_SCRIPT.`
    };
  }

  const python = process.env.KN5_PYTHON_BIN || process.env.PYTHON_BIN || 'python3';
  const before = await walk(input);
  const results = [];
  for (const file of kn5) {
    const result = await run(python, [converter, file], { cwd: path.dirname(file) });
    results.push({
      file: path.relative(input, file).replace(/\\/g, '/'),
      code: result.code,
      ok: result.code === 0,
      stdout: result.out.slice(-4000),
      stderr: result.err.slice(-4000)
    });
  }
  const after = await walk(input);
  const beforeSet = new Set(before.map(file => path.resolve(file)));
  const created = after
    .filter(file => !beforeSet.has(path.resolve(file)) && ['.obj', '.mtl'].includes(path.extname(file).toLowerCase()))
    .map(file => path.relative(input, file).replace(/\\/g, '/'));
  return { attempted: true, ok: results.every(r => r.ok), converter, python, files: kn5.map(file => path.relative(input, file).replace(/\\/g, '/')), created, results };
}

const input = path.resolve(arg('--input'));
const output = path.resolve(arg('--output'));
const blender = process.env.BLENDER_BIN || arg('--blender', 'blender');
const script = path.resolve('scripts/blender-convert-vehicle.py');

if (!input || !output) {
  throw new Error('Usage: node scripts/convert-vehicle-model.mjs --input <source-dir> --output <model.glb> [--blender blender]');
}

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.rm(output, { force: true });
const kn5 = await maybeConvertKn5(input);
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
  kn5,
  blenderStdout: result.out.slice(-24000),
  blenderStderr: result.err.slice(-24000)
};

console.log(JSON.stringify(report, null, 2));
if (!ok) {
  process.exitCode = 1;
}
