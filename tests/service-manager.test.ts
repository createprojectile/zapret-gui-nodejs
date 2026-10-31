/** Unit tests for service-manager pure helpers + updater version compare. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Mock the process layer: the old version of the test below shelled out to
// the real service database (powershell + sc, 30s timeout each) and flaked
// with "Test timed out in 30000ms" whenever PowerShell was slow to start.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn() }
})

import { execFile } from 'node:child_process'
import { parseScState, mapServiceStatus, queryServiceState, getIPSetMode, setIPSetMode, getGameFilterMode, setGameFilterMode, resolveGameFilterPorts, readGameFilterFile, validateGameFilterRange, expandEnvVars, normalizeWindowsPath, extractExePathFromImagePath, detectServiceOwnership, friendlyServiceError, buildServiceImagePath, quoteImagePathForSc } from '../src/main/service-manager'
import { compareVersions } from '../src/main/strategy-updater'

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>

interface FakeProcResult {
  stdout?: string
  stderr?: string
  /** Non-zero exit code → callback receives an Error carrying it. */
  code?: number
}

/** Feed canned `execFile` results (in call order) to code under test. */
function queueProcResults(results: FakeProcResult[]): void {
  const queue = [...results]
  execFileMock.mockImplementation(
    (_file: unknown, _args: unknown, _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const next = queue.shift() ?? {}
      if ((next.code ?? 0) === 0) {
        cb(null, next.stdout ?? '', next.stderr ?? '')
      } else {
        cb(Object.assign(new Error(`mock exit ${next.code}`), { code: next.code }), next.stdout ?? '', next.stderr ?? '')
      }
      return null
    }
  )
}

describe('parseScState', () => {
  it('parses RUNNING', () => {
    expect(parseScState('STATE              : 4  RUNNING')).toBe('RUNNING')
  })
  it('parses STOPPED', () => {
    expect(parseScState('STATE              : 1  STOPPED')).toBe('STOPPED')
  })
  it('maps missing service to NOT_INSTALLED', () => {
    expect(parseScState('[SC] OpenService FAILED 1060: The specified service does not exist.')).toBe('NOT_INSTALLED')
  })
})

describe('mapServiceStatus (Get-Service output, locale-independent)', () => {
  it('maps enum names regardless of case/whitespace', () => {
    expect(mapServiceStatus('Running')).toBe('RUNNING')
    expect(mapServiceStatus('  Stopped\r\n')).toBe('STOPPED')
    expect(mapServiceStatus('StartPending')).toBe('START_PENDING')
    expect(mapServiceStatus('StopPending')).toBe('STOP_PENDING')
  })
  it('maps empty/unknown to UNKNOWN', () => {
    expect(mapServiceStatus('')).toBe('UNKNOWN')
    expect(mapServiceStatus('Paused')).toBe('UNKNOWN')
  })
})

// Hermetic (mocked execFile): covers queryServiceState orchestration without
// touching the real service database. Runs on any platform, in milliseconds.
describe('queryServiceState', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('reports a missing service as NOT_INSTALLED', async () => {
    queueProcResults([
      { stdout: '' }, // Get-Service prints no Status for a missing service
      {
        stdout: '[SC] OpenService FAILED 1060:\r\nThe specified service does not exist as an installed service.',
        code: 1060
      }
    ])
    await expect(queryServiceState('zapret-gui-definitely-missing-12345')).resolves.toBe('NOT_INSTALLED')
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('returns Get-Service status without falling back to sc', async () => {
    queueProcResults([{ stdout: 'Running\r\n' }])
    await expect(queryServiceState('zapret')).resolves.toBe('RUNNING')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })
})

describe('friendlyServiceError', () => {
  it('maps 1060 to an actionable message', () => {
    const msg = friendlyServiceError('start', '[SC] StartService: OpenService FAILED 1060:\nThe specified service does not exist.')
    expect(msg).toContain('not installed')
    expect(msg).toContain('Strategies')
  })
  it('passes other failures through trimmed', () => {
    expect(friendlyServiceError('stop', '  some other failure  ')).toBe('some other failure')
    expect(friendlyServiceError('start', '')).toBe('Service start failed')
  })
})

describe('compareVersions', () => {
  it('compares semver', () => {
    expect(compareVersions('1.10.2', '1.10.2')).toBe(0)
    expect(compareVersions('1.10.3', '1.10.2')).toBe(1)
    expect(compareVersions('1.9.9', '1.10.0')).toBe(-1)
    expect(compareVersions('2.0', '1.99.99')).toBe(1)
  })
})

describe('getIPSetMode / setIPSetMode', () => {
  it('round-trips none -> any -> loaded via backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-ipset-'))
    const list = path.join(dir, 'ipset-all.txt')
    const backup = path.join(dir, 'ipset-all.txt.backup')
    fs.writeFileSync(list, '1.1.1.0/24\n2.2.2.0/24\n', 'utf8')
    expect(getIPSetMode(dir)).toBe('loaded')

    setIPSetMode(dir, 'none')
    expect(getIPSetMode(dir)).toBe('none')
    expect(fs.existsSync(backup)).toBe(true)

    setIPSetMode(dir, 'any')
    expect(getIPSetMode(dir)).toBe('any')

    setIPSetMode(dir, 'loaded')
    expect(getIPSetMode(dir)).toBe('loaded')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('throws on loaded without backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-ipset-'))
    fs.writeFileSync(path.join(dir, 'ipset-all.txt'), '', 'utf8')
    expect(() => setIPSetMode(dir, 'loaded')).toThrow()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the list recoverable when switching loaded -> any', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-ipset-'))
    const list = path.join(dir, 'ipset-all.txt')
    const backup = path.join(dir, 'ipset-all.txt.backup')
    fs.writeFileSync(list, '1.1.1.0/24\n', 'utf8')

    setIPSetMode(dir, 'any')

    expect(getIPSetMode(dir)).toBe('any')
    expect(fs.readFileSync(backup, 'utf8')).toBe('1.1.1.0/24\n')
    setIPSetMode(dir, 'loaded')
    expect(fs.readFileSync(list, 'utf8')).toBe('1.1.1.0/24\n')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('getGameFilterMode / setGameFilterMode', () => {
  it('round-trips modes through the flag file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-game-'))
    expect(getGameFilterMode(dir)).toBe('disabled')
    setGameFilterMode(dir, 'all')
    expect(getGameFilterMode(dir)).toBe('all')
    setGameFilterMode(dir, 'tcp')
    expect(getGameFilterMode(dir)).toBe('tcp')
    setGameFilterMode(dir, 'udp')
    expect(getGameFilterMode(dir)).toBe('udp')
    setGameFilterMode(dir, 'disabled')
    expect(getGameFilterMode(dir)).toBe('disabled')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads legacy bare-token files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-game-legacy-'))
    fs.mkdirSync(path.join(dir, 'utils'), { recursive: true })
    for (const mode of ['all', 'tcp', 'udp'] as const) {
      fs.writeFileSync(path.join(dir, 'utils', 'game_filter.enabled'), mode, 'utf8')
      expect(getGameFilterMode(dir)).toBe(mode)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads service.bat 1.10.3 format with custom ranges', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-game-new-'))
    fs.mkdirSync(path.join(dir, 'utils'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'utils', 'game_filter.enabled'), 'mode=tcp\ntcp=2000-3000\nudp=4000-5000\n', 'utf8')
    expect(resolveGameFilterPorts(dir)).toEqual({ tcp: '2000-3000', udp: '12', mode: 'tcp' })
    fs.writeFileSync(path.join(dir, 'utils', 'game_filter.enabled'), 'mode=all\ntcp=2000-3000\nudp=4000-5000\n', 'utf8')
    expect(resolveGameFilterPorts(dir)).toEqual({ tcp: '2000-3000', udp: '4000-5000', mode: 'all' })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('falls back to defaults on garbage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-game-garbage-'))
    fs.mkdirSync(path.join(dir, 'utils'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'utils', 'game_filter.enabled'), 'mode=bogus\ntcp=99999\ udp=0\n', 'utf8')
    expect(resolveGameFilterPorts(dir)).toEqual({ tcp: '12', udp: '12', mode: 'disabled' })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('preserves custom ranges when switching modes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-game-preserve-'))
    fs.mkdirSync(path.join(dir, 'utils'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'utils', 'game_filter.enabled'), 'mode=all\ntcp=2000-3000\nudp=4000-5000\n', 'utf8')
    setGameFilterMode(dir, 'udp')
    expect(resolveGameFilterPorts(dir)).toEqual({ tcp: '12', udp: '4000-5000', mode: 'udp' })
    expect(readGameFilterFile(dir).tcpRange).toBe('2000-3000')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('validateGameFilterRange', () => {
  it('accepts ports and ranges', () => {
    expect(validateGameFilterRange('1024-65535')).toBe('1024-65535')
    expect(validateGameFilterRange('80,443,8000-8100')).toBe('80,443,8000-8100')
    expect(validateGameFilterRange(' 1024 - 1934 ')).toBe('1024-1934')
  })
  it('rejects invalid input', () => {
    expect(validateGameFilterRange('')).toBeNull()
    expect(validateGameFilterRange('0')).toBeNull()
    expect(validateGameFilterRange('080')).toBeNull()
    expect(validateGameFilterRange('65536')).toBeNull()
    expect(validateGameFilterRange('9000-8000')).toBeNull()
    expect(validateGameFilterRange('80,,443')).toBeNull()
    expect(validateGameFilterRange('abc')).toBeNull()
  })
})

describe('foreign zapret ownership detection', () => {
  it('extracts exe path from quoted ImagePath with args', () => {
    expect(extractExePathFromImagePath('"C:\\zapret\\bin\\winws.exe" --wf-tcp=80')).toBe('C:\\zapret\\bin\\winws.exe')
  })
  it('extracts exe path from unquoted ImagePath', () => {
    expect(extractExePathFromImagePath('C:\\zapret\\winws.exe --args')).toBe('C:\\zapret\\winws.exe')
  })
  it('normalizes case/slashes/quotes', () => {
    expect(normalizeWindowsPath('"C:/Zapret/Bin/WINWS.EXE"')).toBe('c:\\zapret\\bin\\winws.exe')
  })
  it('expands %VAR% segments', () => {
    process.env.ZAPRET_TEST_DIR = 'C:\\Users\\Test'
    expect(expandEnvVars('%ZAPRET_TEST_DIR%\\bin\\winws.exe')).toBe('C:\\Users\\Test\\bin\\winws.exe')
    delete process.env.ZAPRET_TEST_DIR
  })
  it('reports none when service is not installed', () => {
    expect(detectServiceOwnership('NOT_INSTALLED', '"C:\\zapret\\winws.exe"', 'C:\\app\\bin')).toBe('none')
  })
  it('reports unknown when ImagePath is missing', () => {
    expect(detectServiceOwnership('RUNNING', null, 'C:\\app\\bin')).toBe('unknown')
    expect(detectServiceOwnership('RUNNING', '   ', 'C:\\app\\bin')).toBe('unknown')
  })
  it('reports ours when exe dir matches own bin dir (case-insensitive)', () => {
    const own = 'C:\\Users\\Me\\AppData\\Roaming\\zapret-gui\\data\\bin'
    expect(
      detectServiceOwnership('RUNNING', `"${own}\\winws.exe" --wf-tcp=80 --wf-udp=443`, own)
    ).toBe('ours')
    expect(detectServiceOwnership('STOPPED', '"c:\\users\\me\\appdata\\roaming\\zapret-gui\\data\\BIN\\winws.exe"', own)).toBe('ours')
  })
  it('reports foreign when exe lives in another bundle folder', () => {
    const own = 'C:\\Users\\Me\\AppData\\Roaming\\zapret-gui\\data\\bin'
    expect(detectServiceOwnership('RUNNING', '"C:\\zapret\\bin\\winws.exe" --wf-tcp=80', own)).toBe('foreign')
    expect(detectServiceOwnership('RUNNING', '"D:\\Flowseal\\zapret\\winws.exe"', own)).toBe('foreign')
  })
})

describe('buildServiceImagePath', () => {
  it('quotes only the exe, keeps args outside (paths with spaces)', () => {
    expect(buildServiceImagePath('C:\\Users\\Ivan Petrov\\bin\\winws.exe', ['--wf-tcp=80'])).toBe(
      '"C:\\Users\\Ivan Petrov\\bin\\winws.exe" --wf-tcp=80'
    )
  })
  it('preserves already-quoted args with spaces', () => {
    expect(buildServiceImagePath('C:\\bin\\winws.exe', ['--ipset="C:\\my lists\\ipset.txt"'])).toBe(
      '"C:\\bin\\winws.exe" --ipset="C:\\my lists\\ipset.txt"'
    )
  })
  it('strips newlines/quotes from the exe path (injection)', () => {
    expect(buildServiceImagePath('C:\\bin\\winws.exe"\r\nnet user x', [])).toBe('"C:\\bin\\winws.exenet user x"')
  })
  it('round-trips through extractExePathFromImagePath', () => {
    const img = buildServiceImagePath('C:\\Users\\Me\\AppData\\Roaming\\zapret-gui\\data\\bin\\winws.exe', ['--wf-tcp=80'])
    expect(extractExePathFromImagePath(img)).toBe('C:\\Users\\Me\\AppData\\Roaming\\zapret-gui\\data\\bin\\winws.exe')
  })
})

describe('quoteImagePathForSc', () => {
  it('wraps the whole value in one outer pair of quotes', () => {
    expect(quoteImagePathForSc('"C:\\bin\\winws.exe" --wf-tcp=80')).toBe(
      '"\\"C:\\bin\\winws.exe\\" --wf-tcp=80"'
    )
  })
  it('escapes inner quotes with backslashes (MSVCRT argv rules)', () => {
    expect(quoteImagePathForSc('"C:\\a b\\winws.exe" --ipset="C:\\my lists\\x.txt"')).toBe(
      '"\\"C:\\a b\\winws.exe\\" --ipset=\\"C:\\my lists\\x.txt\\""'
    )
  })
  it('doubles backslash runs preceding a quote', () => {
    expect(quoteImagePathForSc('"C:\\dir\\" --x')).toBe('"\\"C:\\dir\\\\\\" --x"')
  })
  it('leaves %VAR% untouched (doubling corrupts the common case)', () => {
    expect(quoteImagePathForSc('"C:\\bin\\winws.exe" --foo=%BAR%')).toBe(
      '"\\"C:\\bin\\winws.exe\\" --foo=%BAR%"'
    )
  })
})

describe('ensureListFilesExist', () => {
  it('heals missing files: bundled restore, user stub, leaves existing alone', async () => {
    const { ensureListFilesExist } = await import('../src/main/service-manager')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-lists-'))
    try {
      const listsDir = path.join(tmp, 'lists')
      fs.mkdirSync(listsDir, { recursive: true })
      // Existing custom file must survive untouched.
      fs.writeFileSync(path.join(listsDir, 'list-exclude.txt'), 'custom\n')
      const logs: string[] = []
      const healed = ensureListFilesExist(
        listsDir,
        [
          '--hostlist-exclude=' + path.join(listsDir, 'list-exclude.txt'),
          '--hostlist=' + path.join(listsDir, 'list-general.txt'),
          '--ipset-exclude=' + path.join(listsDir, 'ipset-exclude-user.txt')
        ],
        (t) => logs.push(t)
      )
      expect(healed).toEqual(['list-general.txt', 'ipset-exclude-user.txt'])
      expect(fs.readFileSync(path.join(listsDir, 'list-exclude.txt'), 'utf8')).toBe('custom\n')
      // Stock list restored from bundled-assets (byte-identical).
      expect(fs.readFileSync(path.join(listsDir, 'list-general.txt'), 'utf8')).toBe(
        fs.readFileSync(path.join(process.cwd(), 'bundled-assets', 'lists', 'list-general.txt'), 'utf8')
      )
      // Unknown user file gets the ipset sentinel stub.
      expect(fs.readFileSync(path.join(listsDir, 'ipset-exclude-user.txt'), 'utf8')).toBe('203.0.113.113/32\n')
      expect(logs.some((l) => l.includes('Restored'))).toBe(true)
      expect(logs.some((l) => l.includes('Created'))).toBe(true)
      // Second run is a no-op.
      expect(ensureListFilesExist(listsDir, ['--ipset-exclude=' + path.join(listsDir, 'ipset-exclude-user.txt')])).toEqual([])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('refuses to create files outside the lists dir', async () => {
    const { ensureListFilesExist } = await import('../src/main/service-manager')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-lists-'))
    try {
      const listsDir = path.join(tmp, 'lists')
      fs.mkdirSync(listsDir, { recursive: true })
      const outside = path.join(tmp, 'evil.txt')
      expect(() => ensureListFilesExist(listsDir, [`--ipset=${outside}`])).toThrow(/outside the lists folder/)
      expect(fs.existsSync(outside)).toBe(false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
