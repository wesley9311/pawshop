'use strict';

function isHttpUploadUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function uploadSequentially(items, uploadOne) {
  const uploadedByIndex = new Map();
  const failures = [];

  for (const item of items) {
    try {
      const uploaded = await uploadOne(item);
      if (!uploaded || !isHttpUploadUrl(uploaded.url)) {
        throw new Error('The upload returned no valid HTTP(S) file URL.');
      }
      uploadedByIndex.set(item.index, uploaded);
    } catch (error) {
      failures.push({
        item,
        message: error instanceof Error ? error.message : 'Upload failed.',
      });
    }
  }

  return { uploadedByIndex, failures };
}

function buildProductMedia(media, uploadedByIndex) {
  return media.map((entry, index) => {
    const uploaded = entry.file ? uploadedByIndex.get(index) : undefined;
    const url = uploaded?.url || entry.url;
    if (!isHttpUploadUrl(url)) {
      throw new Error(`Image ${index + 1} has not finished uploading.`);
    }
    return { ...entry, ...(uploaded || {}), url };
  });
}

module.exports = {
  buildProductMedia,
  isHttpUploadUrl,
  uploadSequentially,
};
