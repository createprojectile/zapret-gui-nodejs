/**
 * Keep the IPSet data usable for the built-in Telegram proxy.
 *
 * The proxy reaches Telegram over raw TCP to the datacenter addresses
 * (`91.108.0.0/16`, `149.154.160.0/20`). Only an `--ipset` list can match a
 * bare IP — the domain lists cannot — and `none` mode leaves a sentinel that
 * matches nothing, so every DC connection times out while the UI still offers
 * to start the proxy.
 *
 * `any` mode already works: nfqws treats an empty include list as "every IP"
 * (`nfq/ipset.c`: "old behavior compat: all include lists are empty means check
 * passes"). That desyncs every connection on the port, so the user's explicit
 * choice is kept — but a real list is cached in `.backup` so switching to
 * `loaded` needs no download.
 *
 * nfqws re-reads the list from disk whenever its size or mtime changes
 * (`file_mod_signature()` + `IpsetsReloadCheck()`), so a changed list applies
 * without restarting the service.
 * @module main/ipset-ensure
 */
import fs from 'node:fs'
import path from 'node:path'
import type { IPSetMode } from '../shared/types'
import { getIPSetMode, setIPSetMode } from './service-manager'
import { updateIPSetList } from './strategy-updater'

/** `91.108.0.0/16` and `149.154.160.0/20` — Telegram datacenters. */
const TELEGRAM_RANGES = /^(?:91\.108\.|149\.154\.)/m

export interface IPSetEnsureResult {
  /** Mode after the check. */
  mode: IPSetMode
  /** The list or the mode changed on disk. */
  changed: boolean
  /** Entries in the active list (or in the cached backup for `any`). */
  lines: number
  reason: 'ok' | 'restored' | 'downloaded' | 'download-failed'
}

export interface IPSetEnsureOptions {
  listsDir: string
  /** Upstream downloader — injectable so tests never hit the network. */
  download?: () => Promise<{ lines: number; bytes: number }>
  onLog?: (level: 'info' | 'warn', text: string) => void
}

function countEntries(file: string): number {
  try {
    let n = 0
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (line.trim().length > 0) n++
    }
    return n
  } catch {
    return 0
  }
}

function hasTelegramRanges(file: string): boolean {
  try {
    return TELEGRAM_RANGES.test(fs.readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

function detail(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Make sure the Telegram DC ranges are covered before the proxy starts.
 *
 * - `loaded` with DC ranges → nothing to do.
 * - `none` → restore the backup (or download), switch to `loaded`.
 * - `loaded` without DC ranges (stale/short list) → refresh from upstream.
 * - `any` → keep the mode, cache a real list in `.backup` for later.
 *
 * Never throws: a proxy that cannot start is worse than one started with a
 * warning, and the caller has no useful recovery anyway.
 */
export async function ensureIPSetForTelegram({
  listsDir,
  download = updateIPSetList,
  onLog
}: IPSetEnsureOptions): Promise<IPSetEnsureResult> {
  const listFile = path.join(listsDir, 'ipset-all.txt')
  const backupFile = path.join(listsDir, 'ipset-all.txt.backup')
  const mode = getIPSetMode(listsDir)

  if (mode === 'loaded' && hasTelegramRanges(listFile)) {
    return { mode, changed: false, lines: countEntries(listFile), reason: 'ok' }
  }

  // `any` matches every IP, Telegram included. Preserve the choice, but leave a
  // usable list behind so the "Loaded" button is not a dead end.
  if (mode === 'any') {
    if (countEntries(backupFile) > 0) {
      return { mode, changed: false, lines: countEntries(backupFile), reason: 'ok' }
    }
    try {
      const r = await download()
      // The updater may re-apply the previous mode itself; make the outcome
      // explicit so the cached list survives regardless of its internals.
      if (getIPSetMode(listsDir) !== 'any') setIPSetMode(listsDir, 'any')
      onLog?.('info', `IPSet list cached for "Loaded" mode: ${r.lines} entries.`)
      return { mode: 'any', changed: true, lines: r.lines, reason: 'downloaded' }
    } catch (e) {
      onLog?.('warn', `IPSet list could not be fetched (${detail(e)}). Telegram relies on "Any" mode.`)
      return { mode, changed: false, lines: 0, reason: 'download-failed' }
    }
  }

  // `none` (sentinel, matches nothing) or a list without DC ranges: the proxy
  // would connect to an IP that nfqws never desyncs.
  if (mode === 'none' && countEntries(backupFile) > 0) {
    setIPSetMode(listsDir, 'loaded')
    const lines = countEntries(listFile)
    onLog?.('info', `IPSet enabled for Telegram: ${lines} entries restored.`)
    return { mode: 'loaded', changed: true, lines, reason: 'restored' }
  }

  try {
    const r = await download()
    if (getIPSetMode(listsDir) !== 'loaded') setIPSetMode(listsDir, 'loaded')
    if (!hasTelegramRanges(listFile)) {
      onLog?.('warn', 'IPSet list has no Telegram ranges — the proxy may still time out.')
    }
    onLog?.('info', `IPSet list loaded for Telegram: ${r.lines} entries.`)
    return { mode: 'loaded', changed: true, lines: r.lines, reason: 'downloaded' }
  } catch (e) {
    onLog?.('warn', `IPSet list could not be fetched (${detail(e)}). The Telegram proxy may time out.`)
    return { mode: getIPSetMode(listsDir), changed: false, lines: 0, reason: 'download-failed' }
  }
}
