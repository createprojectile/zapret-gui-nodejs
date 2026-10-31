/** Unit tests for the Telegram IPSet guard. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureIPSetForTelegram } from '../src/main/ipset-ensure'
import { getIPSetMode, setIPSetMode } from '../src/main/service-manager'

const TELEGRAM = '91.108.56.0/24\n149.154.160.0/20\n104.16.0.0/24\n'
const OTHER = '104.16.0.0/24\n172.64.0.0/13\n'

let dir: string
let list: string
let backup: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-ensure-'))
  list = path.join(dir, 'ipset-all.txt')
  backup = path.join(dir, 'ipset-all.txt.backup')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Write N entries and return the payload the injected downloader reports. */
function downloadWriting(text: string) {
  return vi.fn(async () => {
    fs.writeFileSync(list, text, 'utf8')
    return { lines: text.trim().split('\n').length, bytes: Buffer.byteLength(text) }
  })
}

describe('ensureIPSetForTelegram', () => {
  it('leaves a loaded list with Telegram ranges untouched', async () => {
    fs.writeFileSync(list, TELEGRAM, 'utf8')
    const download = vi.fn()
    const r = await ensureIPSetForTelegram({ listsDir: dir, download })
    expect(r).toMatchObject({ mode: 'loaded', changed: false, reason: 'ok' })
    expect(r.lines).toBe(3)
    expect(download).not.toHaveBeenCalled()
  })

  it('restores the backup when mode is none', async () => {
    fs.writeFileSync(backup, TELEGRAM, 'utf8')
    setIPSetMode(dir, 'none')
    expect(getIPSetMode(dir)).toBe('none')
    const download = vi.fn()

    const r = await ensureIPSetForTelegram({ listsDir: dir, download })

    expect(r).toMatchObject({ mode: 'loaded', changed: true, reason: 'restored', lines: 3 })
    expect(getIPSetMode(dir)).toBe('loaded')
    expect(fs.readFileSync(list, 'utf8')).toBe(TELEGRAM)
    expect(download).not.toHaveBeenCalled()
  })

  it('downloads when mode is none and no backup exists', async () => {
    fs.writeFileSync(list, '203.0.113.113/32\n', 'utf8')
    const download = downloadWriting(TELEGRAM)

    const r = await ensureIPSetForTelegram({ listsDir: dir, download })

    expect(r).toMatchObject({ mode: 'loaded', changed: true, reason: 'downloaded' })
    expect(download).toHaveBeenCalledTimes(1)
    expect(getIPSetMode(dir)).toBe('loaded')
  })

  it('refreshes a loaded list that lacks Telegram ranges', async () => {
    fs.writeFileSync(list, OTHER, 'utf8')
    const download = downloadWriting(TELEGRAM)

    const r = await ensureIPSetForTelegram({ listsDir: dir, download })

    expect(r).toMatchObject({ mode: 'loaded', changed: true, reason: 'downloaded' })
    expect(fs.readFileSync(list, 'utf8')).toContain('149.154.')
  })

  it('keeps "any" mode but caches a real list in .backup', async () => {
    fs.writeFileSync(list, '', 'utf8')
    expect(getIPSetMode(dir)).toBe('any')
    const download = vi.fn(async () => {
      fs.writeFileSync(list, TELEGRAM, 'utf8')
      return { lines: 3, bytes: TELEGRAM.length }
    })

    const r = await ensureIPSetForTelegram({ listsDir: dir, download })

    expect(r).toMatchObject({ mode: 'any', changed: true, reason: 'downloaded' })
    expect(getIPSetMode(dir)).toBe('any')
    expect(fs.readFileSync(backup, 'utf8')).toBe(TELEGRAM)
    // And the cached list can now be activated without another download.
    setIPSetMode(dir, 'loaded')
    expect(fs.readFileSync(list, 'utf8')).toBe(TELEGRAM)
  })

  it('does not download twice when "any" already has a backup', async () => {
    fs.writeFileSync(list, '', 'utf8')
    fs.writeFileSync(backup, TELEGRAM, 'utf8')
    const download = vi.fn()

    const r = await ensureIPSetForTelegram({ listsDir: dir, download })

    expect(r).toMatchObject({ mode: 'any', changed: false, reason: 'ok', lines: 3 })
    expect(download).not.toHaveBeenCalled()
  })

  it('logs a warning and never throws when the download fails', async () => {
    fs.writeFileSync(list, '203.0.113.113/32\n', 'utf8')
    const onLog = vi.fn()

    const r = await ensureIPSetForTelegram({
      listsDir: dir,
      download: async () => {
        throw new Error('offline')
      },
      onLog
    })

    expect(r).toMatchObject({ mode: 'none', changed: false, reason: 'download-failed' })
    expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('offline'))
  })
})
