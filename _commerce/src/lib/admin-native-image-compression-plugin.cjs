'use strict';

const { readFileSync } = require('node:fs');
const { resolve, basename } = require('node:path');

const SUPPORTED_DASHBOARD_VERSION = '2.21.0';
const VIRTUAL_ID = 'virtual:pawshop-native-image-compression';
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;

const replaceExactlyOnce = (source, before, after, label) => {
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`PawShop Admin compression patch could not safely locate ${label}.`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
};

const patchFileUpload = (source) => {
  let next = replaceExactlyOnce(
    source,
    'import { jsx, jsxs } from "react/jsx-runtime";\n',
    `import { jsx, jsxs } from "react/jsx-runtime";\nimport { prepareNativeImageFiles } from "${VIRTUAL_ID}";\n`,
    'the native file-upload imports'
  );
  next = replaceExactlyOnce(
    next,
    `  const handleUploaded = (files) => {\n    if (!files) {\n      return;\n    }\n    const fileList = Array.from(files);\n    const validFiles = [];\n    const rejectedFiles = [];\n    const normalizedMaxFileSize = Math.min(maxFileSize, Infinity);\n    fileList.forEach((file) => {\n      if (file.size > normalizedMaxFileSize) {\n        rejectedFiles.push({ file, reason: "size" });\n        return;\n      }\n      const id = Math.random().toString(36).substring(7);\n      const previewUrl = URL.createObjectURL(file);\n      validFiles.push({\n        id,\n        url: previewUrl,\n        file\n      });\n    });\n    onUploaded(validFiles, rejectedFiles);\n  };`,
    `  const handleUploaded = async (files) => {\n    if (!files) {\n      return;\n    }\n    const fileList = Array.from(files);\n    const validFiles = [];\n    const normalizedMaxFileSize = Math.min(maxFileSize, Infinity);\n    const prepared = await prepareNativeImageFiles(fileList, normalizedMaxFileSize);\n    prepared.files.forEach((file) => {\n      const id = Math.random().toString(36).substring(7);\n      const previewUrl = URL.createObjectURL(file);\n      validFiles.push({\n        id,\n        url: previewUrl,\n        file\n      });\n    });\n    onUploaded(validFiles, []);\n  };`,
    'the native file-upload handler'
  );
  return next;
};

const patchProductMediaUpload = (source) => {
  let next = replaceExactlyOnce(
    source,
    'import { jsx, jsxs } from "react/jsx-runtime";\n',
    `import { jsx, jsxs } from "react/jsx-runtime";\nimport { buildProductMedia, uploadSequentially } from "${VIRTUAL_ID}";\n`,
    'the product-media upload helpers'
  );
  next = replaceExactlyOnce(
    next,
    `    let uploaded = [];\n    if (filesToUpload.length) {\n      const { files: uploads } = await sdk.admin.upload.create({ files: filesToUpload.map((m) => m.file) }).catch(() => {\n        form.setError("media", {\n          type: "invalid_file",\n          message: t("products.media.failedToUpload")\n        });\n        return { files: [] };\n      });\n      uploaded = uploads;\n    }\n    const withUpdatedUrls = media.map((entry, i) => {\n      const toUploadIndex = filesToUpload.findIndex((m) => m.index === i);\n      if (toUploadIndex > -1) {\n        return { ...entry, url: uploaded[toUploadIndex]?.url };\n      }\n      return entry;\n    });`,
    `    const { uploadedByIndex, failures: uploadFailures } = await uploadSequentially(filesToUpload, async (item) => {\n      const { files: uploads } = await sdk.admin.upload.create({ files: [item.file] });\n      return uploads[0];\n    });\n    if (uploadFailures.length) {\n      form.setError("media", {\n        type: "invalid_file",\n        message: t("products.media.failedToUpload")\n      });\n      toast.error(uploadFailures.length + " image" + (uploadFailures.length === 1 ? "" : "s") + " failed to upload", {\n        description: uploadFailures.map(({ item, message }) => item.file.name + ": " + message).join("\\n"),\n        duration: 12000\n      });\n      return;\n    }\n    let withUpdatedUrls;\n    try {\n      withUpdatedUrls = buildProductMedia(media, uploadedByIndex);\n    } catch (error) {\n      form.setError("media", {\n        type: "invalid_file",\n        message: t("products.media.failedToUpload")\n      });\n      toast.error(error instanceof Error ? error.message : t("products.media.failedToUpload"));\n      return;\n    }`,
    'the product media batch upload'
  );
  return next;
};

const patchProductCreateUpload = (source) => {
  let next = replaceExactlyOnce(
    source,
    'import { jsx as jsx11, jsxs as jsxs9 } from "react/jsx-runtime";\n',
    `import { jsx as jsx11, jsxs as jsxs9 } from "react/jsx-runtime";\nimport { buildProductMedia, uploadSequentially } from "${VIRTUAL_ID}";\n`,
    'the product-create upload helpers'
  );
  next = replaceExactlyOnce(
    next,
    `    let uploadedMedia = [];\n    try {\n      if (media.length) {\n        const thumbnailReq = media.find((m) => m.isThumbnail);\n        const otherMediaReq = media.filter((m) => !m.isThumbnail);\n        const fileReqs = [];\n        if (thumbnailReq) {\n          fileReqs.push(\n            sdk.admin.upload.create({ files: [thumbnailReq.file] }).then((r) => r.files.map((f) => ({ ...f, isThumbnail: true })))\n          );\n        }\n        if (otherMediaReq?.length) {\n          fileReqs.push(\n            sdk.admin.upload.create({\n              files: otherMediaReq.map((m) => m.file)\n            }).then((r) => r.files.map((f) => ({ ...f, isThumbnail: false })))\n          );\n        }\n        uploadedMedia = (await Promise.all(fileReqs)).flat();\n      }\n    } catch (error) {\n      if (error instanceof Error) {\n        toast.error(error.message);\n      }\n    }`,
    `    const indexedMedia = media.map((item, index) => ({ ...item, index }));\n    const { uploadedByIndex, failures: uploadFailures } = await uploadSequentially(indexedMedia, async (item) => {\n      const { files: uploads } = await sdk.admin.upload.create({ files: [item.file] });\n      return uploads[0];\n    });\n    if (uploadFailures.length) {\n      toast.error(uploadFailures.length + " image" + (uploadFailures.length === 1 ? "" : "s") + " failed to upload", {\n        description: uploadFailures.map(({ item, message }) => item.file.name + ": " + message).join("\\n"),\n        duration: 12000\n      });\n      return;\n    }\n    let uploadedMedia;\n    try {\n      uploadedMedia = buildProductMedia(media, uploadedByIndex).map((item) => ({ ...item, isThumbnail: item.isThumbnail }));\n    } catch (error) {\n      toast.error(error instanceof Error ? error.message : "Product media upload failed.");\n      return;\n    }`,
    'the product-create batch upload'
  );
  return next;
};

const patchProductMediaSubmittingState = (source) => replaceExactlyOnce(
  source,
  'jsx(Button, { size: "small", type: "submit", isLoading: isPending, children: t("actions.save") })',
  'jsx(Button, { size: "small", type: "submit", isLoading: isPending || form.formState.isSubmitting, disabled: form.formState.isSubmitting, children: t("actions.save") })',
  'the product-media save pending state'
);

const patchProductCreateSubmittingState = (source) => {
  let next = replaceExactlyOnce(
    source,
    'isLoading: isPending,\n              className: "whitespace-nowrap",',
    'isLoading: isPending || form.formState.isSubmitting,\n              disabled: form.formState.isSubmitting,\n              className: "whitespace-nowrap",',
    'the product-create draft pending state'
  );
  next = replaceExactlyOnce(
    next,
    'isLoading: isPending,\n              showInventoryTab',
    'isLoading: isPending || form.formState.isSubmitting,\n              showInventoryTab',
    'the product-create publish pending state'
  );
  return next;
};

const pawshopNativeImageCompressionPlugin = () => {
  const dashboardPackage = require.resolve('@medusajs/dashboard/package.json');
  const dashboardVersion = JSON.parse(readFileSync(dashboardPackage, 'utf8')).version;
  if (dashboardVersion !== SUPPORTED_DASHBOARD_VERSION) {
    throw new Error(`PawShop Admin compression patch supports @medusajs/dashboard ${SUPPORTED_DASHBOARD_VERSION}, found ${dashboardVersion}. Review the upstream upload code before upgrading.`);
  }
  const modulePath = resolve(__dirname, '../admin/lib/native-image-compression.ts');

  return {
    name: 'pawshop-native-image-compression',
    enforce: 'pre',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
    },
    load(id) {
      if (id === RESOLVED_VIRTUAL_ID) {
        return `export { buildProductMedia, prepareNativeImageFiles, uploadSequentially } from ${JSON.stringify(modulePath)};`;
      }
    },
    transform(source, id) {
      const name = basename(id.split('?')[0]);
      if (name === 'chunk-QR6FHSFY.mjs') return { code: patchFileUpload(source), map: null };
      if (name === 'product-media-72TTTVV5.mjs') return { code: patchProductMediaSubmittingState(patchProductMediaUpload(source)), map: null };
      if (name === 'product-create-BGKDACMU.mjs') return { code: patchProductCreateSubmittingState(patchProductCreateUpload(source)), map: null };
    },
  };
};

module.exports = {
  SUPPORTED_DASHBOARD_VERSION,
  patchFileUpload,
  patchProductMediaUpload,
  patchProductMediaSubmittingState,
  patchProductCreateUpload,
  patchProductCreateSubmittingState,
  pawshopNativeImageCompressionPlugin,
};
