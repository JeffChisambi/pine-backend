#!/usr/bin/env node
/**
 * Download InsightFace ONNX models for the KYC face-recognition pipeline.
 *
 * Usage:
 *   node scripts/download-models.mjs                 # buffalo_s (~16 MB, good accuracy)
 *   node scripts/download-models.mjs --pack buffalo_l # buffalo_l (~183 MB, best accuracy)
 *
 * Files land in models/insightface/. The InsightFaceProvider auto-discovers
 * whichever pack is present (preferring buffalo_l), so no config is needed.
 * Source: https://huggingface.co/deepghs/insightface — a mirror of the
 * official deepinsight/insightface release packs.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_DIR = process.env.KYC_MODEL_DIR ?? path.join(ROOT, 'models', 'insightface');

const BASE = 'https://huggingface.co/deepghs/insightface/resolve/main';

const PACKS = {
  buffalo_s: [
    { file: 'det_500m.onnx', url: `${BASE}/buffalo_s/det_500m.onnx` },
    { file: 'w600k_mbf.onnx', url: `${BASE}/buffalo_s/w600k_mbf.onnx` },
  ],
  buffalo_l: [
    { file: 'det_10g.onnx', url: `${BASE}/buffalo_l/det_10g.onnx` },
    { file: 'w600k_r50.onnx', url: `${BASE}/buffalo_l/w600k_r50.onnx` },
  ],
};

const packArg = process.argv.indexOf('--pack');
const pack = packArg > -1 ? process.argv[packArg + 1] : 'buffalo_s';
if (!PACKS[pack]) {
  console.error(`Unknown pack "${pack}". Use one of: ${Object.keys(PACKS).join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(MODEL_DIR, { recursive: true });

async function download({ file, url }) {
  const dest = path.join(MODEL_DIR, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) {
    console.log(`✓ ${file} already present (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB) — skipping`);
    return;
  }
  console.log(`↓ ${file} …`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.download`;
  const out = fs.createWriteStream(tmp);
  let received = 0;
  for await (const chunk of res.body) {
    out.write(chunk);
    received += chunk.length;
    if (total) process.stdout.write(`\r  ${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
  }
  await new Promise((r) => out.end(r));
  fs.renameSync(tmp, dest);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  console.log(`\r✓ ${file} (${(received / 1e6).toFixed(1)} MB)  sha256=${sha.slice(0, 16)}…`);
  return { file, sha };
}

console.log(`Downloading InsightFace pack "${pack}" → ${MODEL_DIR}\n`);
const sums = {};
for (const item of PACKS[pack]) {
  const r = await download(item);
  if (r) sums[r.file] = r.sha;
}
// Write checksums.json so the provider's integrity check has data to verify
const checksumPath = path.join(MODEL_DIR, 'checksums.json');
const existing = fs.existsSync(checksumPath)
  ? JSON.parse(fs.readFileSync(checksumPath, 'utf-8'))
  : {};
fs.writeFileSync(checksumPath, JSON.stringify({ ...existing, ...sums }, null, 2));
console.log('\nDone. Restart the backend to load the models.');
