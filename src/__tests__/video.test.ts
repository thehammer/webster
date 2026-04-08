import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { encodeVideo, encodeVideoToDataUrl } from '../video.js'

const testDir = join(tmpdir(), `webster-video-test-${Date.now()}`)
const framesDir = join(testDir, 'frames')

// Generate a minimal valid JPEG via ffmpeg (1x1 red pixel)
async function generateTestFrames(count: number): Promise<void> {
  mkdirSync(framesDir, { recursive: true })
  for (let i = 1; i <= count; i++) {
    const name = `frame_${String(i).padStart(5, '0')}.jpg`
    const proc = Bun.spawn([
      'ffmpeg', '-y',
      '-f', 'lavfi', '-i', `color=c=red:s=64x64:d=1`,
      '-frames:v', '1',
      join(framesDir, name),
    ], { stderr: 'pipe' })
    await proc.exited
  }
}

beforeEach(async () => {
  await generateTestFrames(4)
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('encodeVideo', () => {
  test('encodes frames to mp4', async () => {
    const outPath = await encodeVideo(framesDir, { format: 'mp4', fps: 2, outDir: testDir })
    expect(outPath).toEndWith('.mp4')
    expect(existsSync(outPath)).toBe(true)
  })

  test('encodes frames to webm', async () => {
    const outPath = await encodeVideo(framesDir, { format: 'webm', fps: 2, outDir: testDir })
    expect(outPath).toEndWith('.webm')
    expect(existsSync(outPath)).toBe(true)
  })

  test('encodes frames to gif', async () => {
    const outPath = await encodeVideo(framesDir, { format: 'gif', fps: 2, outDir: testDir })
    expect(outPath).toEndWith('.gif')
    expect(existsSync(outPath)).toBe(true)
  })

  test('defaults to mp4 format', async () => {
    const outPath = await encodeVideo(framesDir, { outDir: testDir })
    expect(outPath).toEndWith('.mp4')
  })

  test('throws on empty frames directory', async () => {
    const emptyDir = join(testDir, 'empty')
    mkdirSync(emptyDir, { recursive: true })
    await expect(encodeVideo(emptyDir)).rejects.toThrow('No JPEG frames found')
  })
})

describe('encodeVideoToDataUrl', () => {
  test('returns a base64 data URL', async () => {
    const dataUrl = await encodeVideoToDataUrl(framesDir, { format: 'mp4', fps: 2 })
    expect(dataUrl).toStartWith('data:video/mp4;base64,')
  })

  test('gif data URL has correct mime type', async () => {
    const dataUrl = await encodeVideoToDataUrl(framesDir, { format: 'gif', fps: 2 })
    expect(dataUrl).toStartWith('data:image/gif;base64,')
  })
})
