#!/usr/bin/env node
/**
 * Smoke test for the InsightFace ONNX models: loads both sessions, runs a
 * dummy inference, and prints output tensor names/shapes so the SCRFD parser
 * can be validated against the real export format.
 *
 * Usage: node scripts/face-smoke-test.mjs [path-to-face-image]
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');
const sharp = require('sharp');

const MODEL_DIR = process.env.KYC_MODEL_DIR ?? path.resolve('models/insightface');
const packs = [
  { det: 'det_10g.onnx', rec: 'w600k_r50.onnx' },
  { det: 'det_500m.onnx', rec: 'w600k_mbf.onnx' },
];
const pack = packs.find(
  (p) => fs.existsSync(path.join(MODEL_DIR, p.det)) && fs.existsSync(path.join(MODEL_DIR, p.rec)),
);
if (!pack) { console.error('No model pack found in', MODEL_DIR); process.exit(1); }

console.log('Pack:', pack);

const det = await ort.InferenceSession.create(path.join(MODEL_DIR, pack.det));
const rec = await ort.InferenceSession.create(path.join(MODEL_DIR, pack.rec));
console.log('det inputs :', det.inputNames, ' outputs:', det.outputNames);
console.log('rec inputs :', rec.inputNames, ' outputs:', rec.outputNames);

// Build a 640×640 input (image if provided, else gray)
const imgPath = process.argv[2];
const SIZE = 640;
const srcBuffer = imgPath
  ? await sharp(imgPath).resize(SIZE, SIZE, { fit: 'fill' }).removeAlpha().raw().toBuffer()
  : await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: { r: 128, g: 128, b: 128 } } })
      .raw().toBuffer();

const n = SIZE * SIZE;
const px = new Float32Array(3 * n);
for (let i = 0; i < n; i++) {
  const r = srcBuffer[i * 3], g = srcBuffer[i * 3 + 1], b = srcBuffer[i * 3 + 2];
  px[i] = (b - 127.5) / 128.0;
  px[n + i] = (g - 127.5) / 128.0;
  px[2 * n + i] = (r - 127.5) / 128.0;
}
const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', px, [1, 3, SIZE, SIZE]) });
for (const [name, t] of Object.entries(out)) {
  const data = t.data;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
  console.log(`det out "${name}": dims=[${t.dims}] len=${data.length} max=${max.toFixed(4)}`);
}

// Recognition on a 112×112 crop
const RS = 112;
const crop = imgPath
  ? await sharp(imgPath).resize(RS, RS, { fit: 'fill' }).removeAlpha().raw().toBuffer()
  : await sharp({ create: { width: RS, height: RS, channels: 3, background: { r: 128, g: 128, b: 128 } } })
      .raw().toBuffer();
const rn = RS * RS;
const rpx = new Float32Array(3 * rn);
for (let i = 0; i < rn; i++) {
  rpx[i] = (crop[i * 3] - 127.5) / 127.5;
  rpx[rn + i] = (crop[i * 3 + 1] - 127.5) / 127.5;
  rpx[2 * rn + i] = (crop[i * 3 + 2] - 127.5) / 127.5;
}
const rout = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', rpx, [1, 3, RS, RS]) });
for (const [name, t] of Object.entries(rout)) {
  console.log(`rec out "${name}": dims=[${t.dims}] len=${t.data.length}`);
}
console.log('\nSmoke test complete.');
