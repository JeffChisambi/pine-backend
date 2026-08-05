#!/usr/bin/env node
/**
 * OCR smoke test: initialises the Tesseract worker exactly like the backend
 * provider does (local eng.traineddata, LSTM), renders a synthetic ID-back
 * image containing a TD1 MRZ, and checks the OCR output contains the MRZ.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

const MRZ = [
  'I<MWID231458907<<<<<<<<<<<<<<<',
  '7903122M3109155MWI<<<<<<<<<<<8',
  'CHISAMBI<<THELMER<<<<<<<<<<<<<',
];

// Render the MRZ in a monospace font on a white card
const svg = `<svg width="1000" height="280" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="white"/>
  ${MRZ.map(
    (l, i) =>
      `<text x="40" y="${90 + i * 60}" font-family="Courier New, monospace" font-size="44" font-weight="bold" letter-spacing="6" fill="black">${l.replace(/</g, '&lt;')}</text>`,
  ).join('\n')}
</svg>`;
const img = await sharp(Buffer.from(svg)).png().toBuffer();

const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
  langPath: path.resolve(process.cwd()),
  logger: () => {},
});
await worker.setParameters({
  tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
  tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
});
const t0 = Date.now();
const result = await worker.recognize(img);
console.log(`OCR completed in ${Date.now() - t0}ms, confidence=${result.data.confidence}`);
console.log('--- text ---');
console.log(result.data.text.trim());
const flat = result.data.text.replace(/\s+/g, '');
const ok =
  flat.includes('MWID23145890') && flat.includes('CHISAMBI') && flat.includes('7903122M');
console.log(ok ? '\n✓ MRZ recognised correctly' : '\n✗ MRZ NOT fully recognised');
await worker.terminate();
process.exit(ok ? 0 : 1);
