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
  const result = media.map((entry, index) => {
    // A brand-new image (has a File) MUST use the URL returned by the upload
    // API. Use the entry's URL only for pre-existing images (file == null).
    // Never fall back with `uploaded?.url || entry.url`: an empty string from
    // the upload response is falsy and would silently fall back to a blob
    // preview URL (or a stale existing URL), which must never reach the payload.
    const uploaded = entry.file ? uploadedByIndex.get(index) : undefined;
    const url = uploaded ? uploaded.url : entry.url;
    if (!isHttpUploadUrl(url)) {
      throw new Error(`Image ${index + 1} has not finished uploading.`);
    }
    return { ...entry, ...(uploaded || {}), url };
  });

  // Final assertion before the product payload is built: every image URL must
  // be a non-empty HTTP(S) URL. Preview/object URLs and undefined are rejected
  // here, so `images[i].url` can never be emitted as undefined or a blob.
  for (let index = 0; index < result.length; index += 1) {
    const url = result[index]?.url;
    if (!isHttpUploadUrl(url)) {
      throw new Error(
        `Image ${index + 1} url is not a valid HTTP(S) URL (got ${JSON.stringify(url)}).`
      );
    }
  }

  return result;
}

module.exports = {
  buildProductMedia,
  isHttpUploadUrl,
  uploadSequentially,
};
