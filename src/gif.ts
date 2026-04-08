import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// @ts-expect-error — gifenc has no type declarations
import { GIFEncoder, quantize, applyPalette } from 'gifenc'

export async function encodeGif(
  frames: { dataUrl: string; timestamp: number }[],
  fps = 2
): Promise<string> {
  if (frames.length === 0) throw new Error('No frames to encode')

  const ffmpeg = Bun.which('ffmpeg')
  if (ffmpeg) {
    return encodeWithFfmpeg(frames, fps)
  }
  return encodeWithGifenc(frames, fps)
}

async function encodeWithFfmpeg(
  frames: { dataUrl: string; timestamp: number }[],
  fps: number
): Promise<string> {
  const dir = join(tmpdir(), `webster-gif-${Date.now()}`)
  await fs.mkdir(dir, { recursive: true })

  try {
    // Detect format from the first frame's data URL (could be png or jpeg)
    const firstUrl = frames[0].dataUrl
    const ext = firstUrl.startsWith('data:image/jpeg') ? 'jpg' : 'png'

    for (let i = 0; i < frames.length; i++) {
      const base64 = frames[i].dataUrl.replace(/^data:image\/\w+;base64,/, '')
      await fs.writeFile(join(dir, `frame${String(i).padStart(4, '0')}.${ext}`), Buffer.from(base64, 'base64'))
    }

    const outPath = join(dir, 'out.gif')
    const proc = Bun.spawn([
      'ffmpeg', '-y',
      '-framerate', String(fps),
      '-i', join(dir, `frame%04d.${ext}`),
      '-vf', `fps=${fps},scale=iw:ih:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
      outPath,
    ], { stderr: 'pipe' })

    await proc.exited
    if (proc.exitCode !== 0) throw new Error('ffmpeg failed')

    const gifBuffer = await fs.readFile(outPath)
    return 'data:image/gif;base64,' + gifBuffer.toString('base64')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function encodeWithGifenc(
  frames: { dataUrl: string; timestamp: number }[],
  fps: number
): Promise<string> {
  const delayMs = Math.round(1000 / fps)
  const gif = GIFEncoder()

  for (const frame of frames) {
    const base64 = frame.dataUrl.replace(/^data:image\/\w+;base64,/, '')
    const imgData = await decodeImageData(base64)
    const { width, height, data } = imgData
    const palette = quantize(data, 256)
    const index = applyPalette(data, palette)
    gif.writeFrame(index, width, height, { palette, delay: delayMs })
  }

  gif.finish()
  const buffer = Buffer.from(gif.bytesView())
  return 'data:image/gif;base64,' + buffer.toString('base64')
}

async function decodeImageData(base64: string): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  try {
    const sharp = await import('sharp')
    const { data, info } = await sharp.default(Buffer.from(base64, 'base64'))
      .raw()
      .toBuffer({ resolveWithObject: true })
    return {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data.buffer),
    }
  } catch {
    // sharp not available — return a 1x1 transparent pixel stub
    return { width: 1, height: 1, data: new Uint8ClampedArray(4) }
  }
}
