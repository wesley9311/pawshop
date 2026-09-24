import { toast } from '@medusajs/ui'
import compressionPolicy from './native-image-compression-policy.cjs'
import uploadPolicy from './native-image-upload-policy.cjs'

export const NATIVE_UPLOAD_LIMIT_BYTES = compressionPolicy.NATIVE_UPLOAD_LIMIT_BYTES
export const NATIVE_UPLOAD_TARGET_BYTES = compressionPolicy.NATIVE_UPLOAD_TARGET_BYTES
export const buildProductMedia = uploadPolicy.buildProductMedia
export const uploadSequentially = uploadPolicy.uploadSequentially

export type NativeImageFailure = {
  file: File
  message: string
}

export type NativeImageBatchResult = {
  files: File[]
  failures: NativeImageFailure[]
  compressedCount: number
}

type DecodedImage = {
  width: number
  height: number
  source: CanvasImageSource
  close?: () => void
}

const decodeImage = async (file: File): Promise<DecodedImage> => {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file)
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      close: () => bitmap.close(),
    }
  }

  const objectUrl = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = objectUrl
    await image.decode()
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      source: image,
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

const canvasBlob = (
  image: DecodedImage,
  width: number,
  height: number,
  type: string,
  quality?: number
) => new Promise<Blob>((resolve, reject) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: type !== 'image/jpeg' })
  if (!context) {
    reject(new Error('This browser could not prepare the image canvas.'))
    return
  }
  context.drawImage(image.source, 0, 0, width, height)
  canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error(`This browser cannot encode ${type}.`)),
    type,
    quality
  )
})

const asFile = (blob: Blob, original: File) => new File([blob], original.name, {
  type: original.type,
  lastModified: original.lastModified,
})

export const compressNativeImage = async (
  file: File,
  maxBytes = NATIVE_UPLOAD_LIMIT_BYTES,
  targetBytes = Math.min(NATIVE_UPLOAD_TARGET_BYTES, maxBytes)
): Promise<File> => {
  if (!compressionPolicy.validateCompressionCandidate(file, maxBytes)) return file

  const image = await decodeImage(file)
  try {
    return compressionPolicy.compressToLimit(
      file,
      image,
      ({ width, height, quality }: { width: number; height: number; quality?: number }) =>
        canvasBlob(image, width, height, file.type, quality),
      asFile,
      maxBytes,
      targetBytes
    )
  } finally {
    image.close?.()
  }
}

export const prepareNativeImageFiles = async (
  input: File[],
  maxBytes = NATIVE_UPLOAD_LIMIT_BYTES
): Promise<NativeImageBatchResult> => {
  const files: File[] = []
  const failures: NativeImageFailure[] = []
  let compressedCount = 0
  const oversizedCount = input.filter((file) => file.size > maxBytes).length
  const toastId = oversizedCount
    ? toast.loading(`Preparing ${oversizedCount} large image${oversizedCount === 1 ? '' : 's'} for upload...`)
    : undefined

  for (const file of input) {
    try {
      const prepared = await compressNativeImage(file, maxBytes)
      files.push(prepared)
      if (prepared !== file) compressedCount += 1
    } catch (error) {
      failures.push({
        file,
        message: error instanceof Error ? error.message : 'Image processing failed.',
      })
    }
  }

  if (toastId !== undefined) toast.dismiss(toastId)
  if (compressedCount) {
    toast.success(`${compressedCount} image${compressedCount === 1 ? '' : 's'} compressed`, {
      description: 'Original filenames and image formats were kept.',
    })
  }
  if (failures.length) {
    toast.error(`${failures.length} image${failures.length === 1 ? '' : 's'} could not be prepared`, {
      description: failures.map(({ file, message }) => `${file.name}: ${message}`).join('\n'),
      duration: 12000,
    })
  }

  return { files, failures, compressedCount }
}
