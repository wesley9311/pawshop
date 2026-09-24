'use strict';

const NATIVE_UPLOAD_LIMIT_BYTES = 1024 * 1024;
const NATIVE_UPLOAD_TARGET_BYTES = Math.floor(0.9 * 1024 * 1024);
const COMPRESSIBLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const QUALITY_STEPS = [0.94, 0.9, 0.86, 0.8, 0.72, 0.64, 0.55];
const SCALE_STEPS = [1, 0.92, 0.84, 0.76, 0.68, 0.6, 0.52];

function compressionAttempts(type, width, height) {
  const attempts = [];
  for (const scale of SCALE_STEPS) {
    const scaledWidth = Math.max(1, Math.round(width * scale));
    const scaledHeight = Math.max(1, Math.round(height * scale));
    const qualities = type === 'image/png' ? [undefined] : QUALITY_STEPS;
    for (const quality of qualities) attempts.push({ width: scaledWidth, height: scaledHeight, quality });
  }
  return attempts;
}

function validateCompressionCandidate(file, maxBytes = NATIVE_UPLOAD_LIMIT_BYTES) {
  if (file.type === 'image/avif') {
    throw new Error('AVIF was kept unchanged because the native Medusa upload path does not safely accept and re-encode it. Please use the PawShop Product Media uploader instead.');
  }
  if (file.size <= maxBytes) return false;
  if (!COMPRESSIBLE_TYPES.has(file.type)) {
    throw new Error('Only JPG, PNG, and WebP images over 1 MB can be compressed safely in this upload path.');
  }
  return true;
}

async function compressToLimit(file, dimensions, encode, makeFile, maxBytes = NATIVE_UPLOAD_LIMIT_BYTES, targetBytes = Math.min(NATIVE_UPLOAD_TARGET_BYTES, maxBytes)) {
  if (!validateCompressionCandidate(file, maxBytes)) return file;

  let smallest;
  for (const attempt of compressionAttempts(file.type, dimensions.width, dimensions.height)) {
    const blob = await encode(attempt);
    if (blob.type !== file.type) throw new Error(`This browser cannot safely encode ${file.type}.`);
    if (!smallest || blob.size < smallest.size) smallest = blob;
    if (blob.size <= targetBytes) return makeFile(blob, file);
  }
  if (smallest && smallest.size <= maxBytes) return makeFile(smallest, file);
  throw new Error('The image could not be reduced below 1 MB without excessive quality loss. Please use the PawShop Product Media uploader.');
}

module.exports = {
  NATIVE_UPLOAD_LIMIT_BYTES,
  NATIVE_UPLOAD_TARGET_BYTES,
  QUALITY_STEPS,
  SCALE_STEPS,
  compressionAttempts,
  validateCompressionCandidate,
  compressToLimit,
};
