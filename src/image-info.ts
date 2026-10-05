/**
 * 图片字节的元信息提取：宽高与内容哈希。
 *
 * 宽高用于工具返回值与项目记录（尺寸能力校验要靠它事后核对）；
 * 哈希用于**内容寻址文件名**——同内容同哈希天然去重，也让只读路由可以安全长缓存。
 *
 * 只解析头部，不引入图像库。识别不出的格式返回 0 宽高而不是抛错：
 * 尺寸信息缺失不该让一次成功的生图失败。
 */
import { createHash } from 'node:crypto'

export interface ImageInfo {
  readonly width: number
  readonly height: number
  readonly sha256: string
  readonly mediaType: string
}

/** PNG：IHDR 固定在第 16 字节起。 */
function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined
  const view = (offset: number): number =>
    ((bytes[offset] as number) << 24) |
    ((bytes[offset + 1] as number) << 16) |
    ((bytes[offset + 2] as number) << 8) |
    (bytes[offset + 3] as number)
  return { width: view(16), height: view(20) }
}

/** GIF：逻辑屏幕描述符。 */
function gifSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 10) return undefined
  return {
    width: (bytes[6] as number) | ((bytes[7] as number) << 8),
    height: (bytes[8] as number) | ((bytes[9] as number) << 8),
  }
}

/** WebP：VP8X / VP8L / VP8 三种块布局。 */
function webpSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined
  const chunk = String.fromCharCode(
    bytes[12] as number,
    bytes[13] as number,
    bytes[14] as number,
    bytes[15] as number,
  )

  if (chunk === 'VP8X') {
    const w = 1 + ((bytes[24] as number) | ((bytes[25] as number) << 8) | ((bytes[26] as number) << 16))
    const h = 1 + ((bytes[27] as number) | ((bytes[28] as number) << 8) | ((bytes[29] as number) << 16))
    return { width: w, height: h }
  }

  if (chunk === 'VP8 ') {
    const w = ((bytes[26] as number) | ((bytes[27] as number) << 8)) & 0x3fff
    const h = ((bytes[28] as number) | ((bytes[29] as number) << 8)) & 0x3fff
    return { width: w, height: h }
  }

  if (chunk === 'VP8L' && bytes.length >= 25) {
    const bits =
      (bytes[21] as number) |
      ((bytes[22] as number) << 8) |
      ((bytes[23] as number) << 16) |
      ((bytes[24] as number) << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }

  return undefined
}

/** JPEG：扫描段直到 SOFn。 */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1] as number
    // SOF0..SOF15，排除 DHT(0xc4) / JPG(0xc8) / DAC(0xcc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: ((bytes[offset + 5] as number) << 8) | (bytes[offset + 6] as number),
        width: ((bytes[offset + 7] as number) << 8) | (bytes[offset + 8] as number),
      }
    }
    const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number)
    if (length <= 0) return undefined
    offset += 2 + length
  }
  return undefined
}

function dimensions(bytes: Uint8Array, mediaType: string): { width: number; height: number } | undefined {
  if (mediaType === 'image/png') return pngSize(bytes)
  if (mediaType === 'image/jpeg') return jpegSize(bytes)
  if (mediaType === 'image/webp') return webpSize(bytes)
  if (mediaType === 'image/gif') return gifSize(bytes)
  return undefined
}

/**
 * 提取宽高与 sha256。
 * @param bytes - 图片字节。
 * @param mediaType - 已识别的媒体类型（由魔数嗅探得到）。
 */
export function imageInfo(bytes: Uint8Array, mediaType: string): ImageInfo {
  const size = dimensions(bytes, mediaType)
  return {
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mediaType,
  }
}
