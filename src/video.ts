import { promises as fs } from 'fs'
import { readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export type VideoFormat = 'mp4' | 'webm' | 'gif'

/**
 * Encode JPEG frames from a directory into a video file.
 * Frames must be named frame_00001.jpg, frame_00002.jpg, etc.
 * Returns the path to the encoded file.
 */
export async function encodeVideo(
  framesDir: string,
  options: { format?: VideoFormat; fps?: number; outDir?: string } = {}
): Promise<string> {
  const format = options.format ?? 'mp4'
  const fps = options.fps ?? 2

  // Verify ffmpeg is available
  const ffmpeg = Bun.which('ffmpeg')
  if (!ffmpeg) {
    throw new Error('ffmpeg is required for video encoding but was not found on PATH')
  }

  // Verify frames exist
  const files = readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort()
  if (files.length === 0) {
    throw new Error(`No JPEG frames found in ${framesDir}`)
  }

  const outDir = options.outDir ?? framesDir
  const outPath = join(outDir, `capture.${format}`)

  const args = buildFfmpegArgs(framesDir, outPath, format, fps)

  const proc = Bun.spawn(['ffmpeg', ...args], { stderr: 'pipe' })
  await proc.exited

  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`ffmpeg exited with code ${proc.exitCode}: ${stderr.slice(-500)}`)
  }

  return outPath
}

/**
 * Encode frames and return as a base64 data URL.
 * Use for small outputs or when a file path isn't practical.
 */
export async function encodeVideoToDataUrl(
  framesDir: string,
  options: { format?: VideoFormat; fps?: number } = {}
): Promise<string> {
  const format = options.format ?? 'mp4'
  const dir = join(tmpdir(), `webster-video-${Date.now()}`)
  await fs.mkdir(dir, { recursive: true })

  try {
    const outPath = await encodeVideo(framesDir, { ...options, outDir: dir })
    const buffer = await fs.readFile(outPath)
    const mimeType = format === 'mp4' ? 'video/mp4' : format === 'webm' ? 'video/webm' : 'image/gif'
    return `data:${mimeType};base64,${buffer.toString('base64')}`
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function buildFfmpegArgs(framesDir: string, outPath: string, format: VideoFormat, fps: number): string[] {
  const inputArgs = [
    '-y',
    '-framerate', String(fps),
    '-i', join(framesDir, 'frame_%05d.jpg'),
  ]

  switch (format) {
    case 'mp4':
      return [
        ...inputArgs,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        // Pad to even dimensions (H.264 requires it)
        '-vf', `pad=ceil(iw/2)*2:ceil(ih/2)*2`,
        '-movflags', '+faststart',
        outPath,
      ]

    case 'webm':
      return [
        ...inputArgs,
        '-c:v', 'libvpx-vp9',
        '-pix_fmt', 'yuv420p',
        '-b:v', '0',
        '-crf', '30',
        outPath,
      ]

    case 'gif':
      return [
        ...inputArgs,
        '-vf', `fps=${fps},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
        outPath,
      ]
  }
}
