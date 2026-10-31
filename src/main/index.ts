/**
 * Electron main entry: window, tray, auto-updater, first-run wizard flag.
 * @module main/index
 */
import { app, BrowserWindow, shell, dialog } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { ensureDataDirSeeded, getDataDir, getAppLogPath, getTgProxyLogPath, getBundledAssetsDir, getListsDir, getBinDir } from './paths'
import { initLogger, setLogsEnabled, isLogsEnabled, clearBufferedLogs, info, warn, err, onLog, getBufferedLogs } from './logger'
import type { LogLine } from '../shared/types'
import { setupAutoUpdater } from './app-updater'
import { ensureIPSetForTelegram } from './ipset-ensure'
import { registerIpcHandlers, listStrategies, stopAllTesting } from './ipc-handlers'
import { setupTray, getTrayLabels, destroyTray, type TrayContext } from './tray'
import { loadSettings, saveSettings, onSettingsChanged } from './settings'
import {
  getStatus,
  startService,
  stopService,
  installStrategy,
  getGameFilterMode,
  setGameFilterMode,
  getIPSetMode,
  setIPSetMode
} from './service-manager'
import { isAdmin, relaunchAppAsAdmin } from './exec'
import { isLinux } from './platform'
import { hasRootPrivilege, ensureRootPrivilege, isRootProcess, stopPrivilegeKeepAlive } from './linux-privilege'
import {
  getLinuxStatus,
  startLinuxService,
  stopLinuxService,
  installLinuxStrategy
} from './linux-service'
import { TG_PROXY_RESTART_ARG, ADMIN_RELAUNCH_ARG, isAdminHandoverArgv } from '../shared/constants'
import { isAllowedExternalUrl, isAllowedNavigationTarget } from './shell-security'
import { IPC } from '../shared/types'
import { translate } from '../shared/i18n'
import type { GameFilterMode, IPSetMode, TrayPage, ZapretStatus } from '../shared/types'
import { ensureTgProxySecret } from './ipc-handlers'
import { shouldStartMinimized } from './linux-autostart'
import { getTgProxyStats, getTgProxyStatus, startTgProxy, stopTgProxy, tgStartOptsFromSettings } from './tg-proxy'

let mainWindow: BrowserWindow | null = null
let isQuitting = false

/**
 * Unified elevation probe: Windows = admin token, Linux = held root via the
 * privilege helper (Electron itself is never root there).
 */
async function currentElevation(): Promise<boolean> {
  try {
    return isLinux() ? await hasRootPrivilege() : await isAdmin()
  } catch {
    return false
  }
}

async function statusSnapshot(elevated: boolean) {
  if (isLinux()) return getLinuxStatus(elevated, getDataDir(), getBinDir())
  return getStatus(elevated)
}

async function startUnified(): Promise<void> {
  if (isLinux()) await startLinuxService(getDataDir(), (t) => info('app', t))
  else await startService()
}

async function stopUnified(): Promise<void> {
  if (isLinux()) await stopLinuxService(getDataDir(), (t) => info('app', t))
  else await stopService()
}

function appIconPath(): string {
  const bundled = getBundledAssetsDir()
  if (isLinux()) {
    for (const name of ['icon.png', '../build/app-icon.png', 'icon.ico']) {
      const p = name.startsWith('../') ? path.join(bundled, name) : path.join(bundled, name)
      try {
        if (fs.existsSync(p)) return p
      } catch {
        /* next */
      }
    }
    return path.join(bundled, 'icon.ico')
  }
  return path.join(bundled, 'icon.ico')
}
// `onLog` subscription is global (not per-window): createWindow() runs on
// every second-instance/activate, and a per-window subscribe would duplicate
// log delivery N times.
//
// Delivery is batched: tg-proxy emits hundreds of session lines per minute
// and one IPC + one React setState per line kept the renderer (and the
// main process via sync file writes) needlessly hot. Lines are queued and
// flushed as a single `on-logs` array every 400ms (or 100 lines).
let logForwardingArmed = false
let logQueue: LogLine[] = []
let logFlushTimer: NodeJS.Timeout | null = null
function flushLogQueue(): void {
  if (logFlushTimer) {
    clearTimeout(logFlushTimer)
    logFlushTimer = null
  }
  if (logQueue.length === 0) return
  const batch = logQueue
  logQueue = []
  try {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(IPC.onLogs, batch)
    }
  } catch {
    /* renderer gone */
  }
}
function scheduleLogFlush(): void {
  if (logFlushTimer) return
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null
    flushLogQueue()
  }, 400)
  logFlushTimer.unref?.()
}
/** Drop queued (not yet delivered) lines — used when logs are switched off. */
export function dropQueuedLogs(): void {
  logQueue = []
  if (logFlushTimer) {
    clearTimeout(logFlushTimer)
    logFlushTimer = null
  }
}
function armLogForwarding(): void {
  if (logForwardingArmed) return
  logForwardingArmed = true
  onLog((line) => {
    if (!isLogsEnabled()) return
    logQueue.push(line)
    if (logQueue.length >= 100) flushLogQueue()
    else scheduleLogFlush()
  })
}
app.on('before-quit', () => {
  isQuitting = true
  try {
    stopPrivilegeKeepAlive()
  } catch {
    /* best-effort */
  }
  try {
    // A foreground/config test spawns winws.exe directly (no service) —
    // without this it keeps running as an orphan after the app exits.
    stopAllTesting()
  } catch {
    /* best-effort */
  }
  try {
    // The TG proxy is an in-process listener — close it synchronously-ish
    // so the port is released before quit.
    void stopTgProxy().catch(() => undefined)
  } catch {
    /* best-effort */
  }
  destroyTray()
})

// Any settings save (GUI toggles included) rebuilds the tray menu at once
// instead of waiting for the 15s timer tick. The log switch is applied to
// the logger here so `logsEnabled: false` stops all log work instantly and
// drops everything buffered so far (stale tab counters must go to zero).
onSettingsChanged((next) => {
  try {
    setLogsEnabled(next.logsEnabled !== false)
    if (next.logsEnabled === false) {
      dropQueuedLogs()
      clearBufferedLogs()
    }
  } catch {
    /* best-effort */
  }
  void refreshTray()
})

function toTrayStatus(s: string): ZapretStatus {
  if (s === 'RUNNING') return 'running'
  if (s === 'STOPPED') return 'stopped'
  if (s === 'NOT_INSTALLED') return 'not-installed'
  return 'unknown'
}

let refreshTrayRunning = false
let refreshTrayQueued = false
let serviceBusy = false
/** Set while a tray-initiated "relaunch as admin" UAC flow is in flight. */
let trayRelaunchInFlight = false

async function refreshTray(): Promise<void> {
  if (refreshTrayRunning) {
    refreshTrayQueued = true
    return
  }
  refreshTrayRunning = true
  try {
    const settings = loadSettings()
    if (!settings.showTrayIcon) {
      destroyTray()
      return
    }
    const admin = await currentElevation()
    const st = await statusSnapshot(admin)
    const zs = toTrayStatus(st.zapret)
    let strategies: Array<{ id: string; name: string }> = []
    try {
      strategies = listStrategies().map((s) => ({ id: s.id, name: s.name }))
    } catch {
      strategies = []
    }
    let gameFilter: GameFilterMode = 'disabled'
    try {
      gameFilter = getGameFilterMode(getDataDir())
    } catch {
      /* best-effort */
    }
    let ipset: IPSetMode = 'none'
    try {
      ipset = getIPSetMode(getListsDir())
    } catch {
      /* best-effort */
    }
    let tgProxy: 'running' | 'stopped' | 'error' = 'stopped'
    let tgProxyPort = settings.tgProxy.port
    try {
      tgProxy = getTgProxyStatus().status
      tgProxyPort = getTgProxyStats().port
    } catch {
      /* best-effort */
    }
    const ctx: TrayContext = {
      isAdmin: admin,
      ownership: st.ownership,
      activeStrategy: st.activeStrategy,
      activeStrategyId: settings.activeStrategyId,
      strategies,
      totalStrategies: strategies.length,
      gameFilter,
      ipset,
      autoLaunch: settings.autoLaunch,
      minimizeToTray: settings.minimizeToTrayOnClose,
      startMinimized: settings.startMinimizedToTray,
      tgProxy,
      tgProxyPort,
      version: app.getVersion(),
      trayStrategyMenu: settings.trayStrategyMenu,
      trayServiceMenu: settings.trayServiceMenu,
      trayNavigateMenu: settings.trayNavigateMenu,
      trayGameFilterMenu: settings.trayGameFilterMenu,
      trayIPSetMenu: settings.trayIPSetMenu,
      trayToolsMenu: settings.trayToolsMenu,
      trayQuickSettings: settings.trayQuickSettings
    }
    // Labels follow the app language (also refreshed by the 15s timer,
    // so a language switch applies to the tray shortly after).
    setupTray(zs, getTrayLabels(settings.locale, zs, isLinux() ? 'linux' : 'win32'), ctx, trayCallbacks())
  } catch {
    /* tray refresh is best-effort */
  } finally {
    refreshTrayRunning = false
    if (refreshTrayQueued) {
      refreshTrayQueued = false
      void refreshTray()
    }
  }
}

function showMainWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
}

function toggleMainWindow(): void {
  const w = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null
  if (!w) {
    createWindow()
    return
  }
  if (w.isVisible() && w.isFocused()) {
    w.hide()
  } else {
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  }
}

/** Tell the renderer its cached status/strategies/settings may be stale. */
function notifyRenderer(): void {
  try {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(IPC.statusChanged)
      mainWindow.webContents.send(IPC.tgProxyStatusChanged)
    }
  } catch {
    /* renderer gone */
  }
}

function navigateTo(page: TrayPage): void {
  showMainWindow()
  try {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(IPC.navigate, page)
    }
  } catch {
    /* renderer gone */
  }
}

/**
 * Service control straight from the tray (no renderer round-trip: the old
 * `webContents.send('zapret:tray-start')` only worked while the Dashboard
 * page was mounted and subscribed).
 */
async function serviceAction(kind: 'start' | 'stop' | 'restart'): Promise<void> {
  if (serviceBusy) return
  serviceBusy = true
  try {
    const st = await statusSnapshot(await currentElevation())
    if (st.ownership === 'foreign') {
      // A third-party service must not be touched — explain in the app.
      navigateTo('dashboard')
      return
    }
    if (kind === 'start') await startUnified()
    else if (kind === 'stop') await stopUnified()
    else {
      await stopUnified().catch(() => undefined)
      await startUnified()
    }
    info('app', `Service ${kind} from tray: OK.`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err('app', `Tray ${kind} failed: ${msg.slice(0, 300)}`)
    dialog.showErrorBox('Zapret GUI', msg.slice(0, 500))
  } finally {
    serviceBusy = false
    notifyRenderer()
    await refreshTray()
  }
}

/** Apply a strategy straight from the tray submenu. */
async function applyStrategyFromTray(id: string): Promise<void> {
  // Same guard as serviceAction: double-clicking two strategies must not
  // run concurrent `sc delete/create` cycles.
  if (serviceBusy) return
  serviceBusy = true
  try {
    const st = await statusSnapshot(await currentElevation())
    if (st.ownership === 'foreign') {
      // A third-party service must not be touched — explain in the app.
      navigateTo('strategies')
      return
    }
    const s = listStrategies().find((x) => x.id === id) ?? null
    if (!s) {
      navigateTo('strategies')
      return
    }
    info('app', `Installing strategy "${s.name}" from tray...`)
    if (isLinux()) {
      await installLinuxStrategy(s, { dataDir: getDataDir(), binDir: getBinDir(), listsDir: getListsDir() }, (t) =>
        info('app', t)
      )
    } else {
      await installStrategy(s, getDataDir(), (t) => info('app', t))
    }
    saveSettings({ activeStrategyId: s.id })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err('app', `Tray strategy install failed: ${msg.slice(0, 300)}`)
    dialog.showErrorBox('Zapret GUI', msg.slice(0, 500))
  } finally {
    serviceBusy = false
    notifyRenderer()
    await refreshTray()
  }
}

/** Start/stop/restart the built-in TG proxy straight from the tray. */
async function tgProxyAction(kind: 'start' | 'stop' | 'restart'): Promise<void> {
  if (serviceBusy) return
  serviceBusy = true
  try {
    if (kind === 'stop') {
      await stopTgProxy()
      const s = loadSettings()
      saveSettings({ tgProxy: { ...s.tgProxy, enabled: false } })
      info('tg-proxy', 'TG proxy stopped from tray.')
    } else {
      const s = ensureTgProxySecret()
      if (kind === 'restart') await stopTgProxy().catch(() => undefined)
      const bound = await startTgProxy(tgStartOptsFromSettings(s.tgProxy))
      saveSettings({ tgProxy: { ...s.tgProxy, enabled: true, port: bound.port } })
      info('tg-proxy', `TG proxy ${kind} from tray: ${bound.host}:${bound.port}.`)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err('tg-proxy', `Tray TG proxy ${kind} failed: ${msg.slice(0, 300)}`)
    dialog.showErrorBox('Zapret GUI', msg.slice(0, 500))
  } finally {
    serviceBusy = false
    notifyRenderer()
    await refreshTray()
  }
}

/**
 * Start the TG proxy with retries. Needed after admin handover: the old
 * non-admin instance quits with a delay, so the first bind attempt can hit
 * EADDRINUSE while the old listener is still releasing the port. Without
 * retries the proxy stays in "Ошибка" until the user presses Start manually.
 */
async function startTgProxyWithRetry(tag: string, maxAttempts = 6, delayMs = 1000): Promise<void> {
  const withSecret = ensureTgProxySecret()
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const bound = await startTgProxy(tgStartOptsFromSettings(withSecret.tgProxy))
      info('tg-proxy', `Autostarted on ${bound.host}:${bound.port} (${tag}).`)
      saveSettings({ tgProxy: { ...withSecret.tgProxy, enabled: true, port: bound.port } })
      notifyRenderer()
      void refreshTray()
      return
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300)
      if (attempt < maxAttempts) {
        warn('tg-proxy', `Autostart attempt ${attempt}/${maxAttempts} failed (${tag}): ${msg} — retrying.`)
        await new Promise((r) => setTimeout(r, delayMs))
      } else {
        err('tg-proxy', `Autostart failed (${tag}): ${msg}`)
        notifyRenderer()
        void refreshTray()
      }
    }
  }
}

function trayCallbacks() {
  return {
    onShow: () => {
      showMainWindow()
    },
    onToggleWindow: () => {
      toggleMainWindow()
    },
    onStart: () => {
      void serviceAction('start')
    },
    onStop: () => {
      void serviceAction('stop')
    },
    onRestart: () => {
      void serviceAction('restart')
    },
    onTgProxyStart: () => {
      void tgProxyAction('start')
    },
    onTgProxyStop: () => {
      void tgProxyAction('stop')
    },
    onTgProxyRestart: () => {
      void tgProxyAction('restart')
    },
    onNavigate: (page: TrayPage) => {
      navigateTo(page)
    },
    onPickStrategy: (id: string) => {
      void applyStrategyFromTray(id)
    },
    onGameFilter: (mode: GameFilterMode) => {
      try {
        setGameFilterMode(getDataDir(), mode)
        info('app', `Game filter → ${mode} (from tray). Restart zapret to apply.`)
      } catch (e) {
        dialog.showErrorBox('Zapret GUI', e instanceof Error ? e.message : String(e))
      } finally {
        notifyRenderer()
        void refreshTray()
      }
    },
    onIPSet: (mode: IPSetMode) => {
      try {
        setIPSetMode(getListsDir(), mode)
        info('app', `IPSet mode → ${mode} (from tray). Restart zapret to apply.`)
      } catch (e) {
        dialog.showErrorBox('Zapret GUI', e instanceof Error ? e.message : String(e))
      } finally {
        notifyRenderer()
        void refreshTray()
      }
    },
    onToggleSetting: (key: 'autoLaunch' | 'minimizeToTrayOnClose' | 'startMinimizedToTray' | 'showTrayIcon') => {
      try {
        const cur = loadSettings()
        saveSettings({ [key]: !cur[key] } as Partial<Parameters<typeof saveSettings>[0]>)
        info('app', `Setting ${key} → ${String(!cur[key])} (from tray).`)
      } catch (e) {
        dialog.showErrorBox('Zapret GUI', e instanceof Error ? e.message : String(e))
      } finally {
        notifyRenderer()
        void refreshTray()
      }
    },
    onRelaunchAdmin: () => {
      void (async () => {
        if (isLinux()) {
          // No relaunch on Linux: ask for root via the privilege helper and
          // hold it while the app keeps running as the user.
          try {
            await ensureRootPrivilege()
            info('app', 'Root privileges granted and held (app still runs as user).')
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            err('app', `Root request failed: ${msg.slice(0, 300)}`)
            dialog.showErrorBox('Zapret GUI', msg.slice(0, 500))
          } finally {
            notifyRenderer()
            await refreshTray()
          }
          return
        }
        // A second click while UAC is open must not spawn a duplicate
        // elevated copy (same guard as the IPC handler).
        if (trayRelaunchInFlight) return
        if (await currentElevation()) {
          showMainWindow()
          return
        }
        trayRelaunchInFlight = true
        try {
          // Same TG-proxy handover as the IPC handler: free the listen port
          // before the elevated copy starts, or it fails with EADDRINUSE.
          let tgHandover = false
          if (app.isPackaged) {
            try {
              if (getTgProxyStatus().status === 'running') {
                tgHandover = true
                info('tg-proxy', 'Stopping TG proxy listener for admin handover (elevated copy will restart it).')
                await stopTgProxy().catch(() => undefined)
              }
            } catch {
              /* best-effort */
            }
          }
          const args = [...process.argv.slice(1)]
          if (tgHandover && !args.includes(TG_PROXY_RESTART_ARG)) args.push(TG_PROXY_RESTART_ARG)
          if (!args.includes(ADMIN_RELAUNCH_ARG)) args.push(ADMIN_RELAUNCH_ARG)
          try {
            app.releaseSingleInstanceLock()
          } catch {
            /* best-effort */
          }
          const res = await relaunchAppAsAdmin(process.execPath, args)
          if (!res.ok) {
            const reason = res.output.slice(0, 300) || 'Failed to start the elevated copy.'
            warn('app', `Admin relaunch failed: ${reason}`)
            try {
              app.requestSingleInstanceLock()
            } catch {
              /* best-effort */
            }
            if (tgHandover) {
              try {
                const s = ensureTgProxySecret()
                const bound = await startTgProxy(tgStartOptsFromSettings(s.tgProxy))
                saveSettings({ tgProxy: { ...s.tgProxy, enabled: true, port: bound.port } })
                info('tg-proxy', `TG proxy restored locally on ${bound.host}:${bound.port} (admin relaunch cancelled).`)
              } catch (e) {
                err('tg-proxy', `TG proxy restore failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`)
              }
              notifyRenderer()
              void refreshTray()
            }
            return
          }
          if (app.isPackaged) {
            info('app', 'Restarting with administrator rights — closing this instance.')
            setTimeout(() => app.quit(), 1000).unref?.()
          }
        } finally {
          trayRelaunchInFlight = false
        }
      })()
    },
    onOpenData: () => {
      try {
        void shell.openPath(getDataDir()).catch(() => undefined)
      } catch {
        /* getDataDir failed — nothing to open */
      }
    },
    onExportLogs: () => {
      void (async () => {
        try {
          const locale = loadSettings().locale
          const res = await dialog.showSaveDialog(mainWindow ?? undefined as unknown as BrowserWindow, {
            title: translate(locale, 'dialog.exportTitle'),
            defaultPath: `zapret-gui-logs-${new Date().toISOString().slice(0, 10)}.log`,
            filters: [{ name: translate(locale, 'dialog.exportFilter'), extensions: ['log', 'txt'] }]
          })
          if (res.canceled || !res.filePath) return
          const text = getBufferedLogs()
            .map((l) => `[${l.ts}] [${l.source}/${l.level}] ${l.text}`)
            .join('\n')
          fs.writeFileSync(res.filePath, text, 'utf8')
          await shell.openPath(path.dirname(res.filePath))
        } catch (e) {
          err('app', `Export logs failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    },
    onQuit: () => {
      destroyTray()
      app.quit()
    }
  }
}

function createWindow(): void {
  const settings = loadSettings()
  mainWindow = new BrowserWindow({
    width: 1625,
    height: 935,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    title: 'Zapret GUI',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // Renderer hardening: the preload bridge (`contextBridge` +
      // `ipcRenderer` only) works fully sandboxed, so keep every
      // isolation layer on — a renderer compromise must not gain Node.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    // After "relaunch as admin" the window always shows: the user clicked a
    // button and expects to see the elevated app, even with startMinimizedToTray.
    // `--hidden` (written into the Linux XDG Autostart entry when
    // startMinimizedToTray is on) counts as a minimized start too. Without a
    // tray icon there is nowhere to minimize to — show the window then.
    const hiddenLaunch = shouldStartMinimized(process.argv, settings.startMinimizedToTray)
    if (hiddenLaunch && !process.argv.includes(ADMIN_RELAUNCH_ARG) && settings.showTrayIcon) {
      // Start hidden in tray; user opens via tray icon.
    } else {
      mainWindow?.show()
    }
    void refreshTray()
  })

  mainWindow.on('close', (e) => {
    const s = loadSettings()
    // Without a tray icon there is nowhere to minimize to — let it quit.
    if (s.minimizeToTrayOnClose && s.showTrayIcon && !isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Keep checkbox/menu state fresh when the window (and settings) reappears.
  mainWindow.on('show', () => {
    void refreshTray()
  })

  // External links (`target="_blank"` in the renderer) open in the user's
  // browser — the window itself never navigates away from the app. Only
  // `http(s)` may leave the app: any other scheme (`file:`, `javascript:`,
  // `data:`, custom handlers, …) is denied so renderer content cannot turn
  // this into an arbitrary-scheme launcher.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalUrl(details.url)) {
      void shell.openExternal(details.url).catch(() => undefined)
    } else {
      warn('app', `Blocked window.open for disallowed URL scheme: ${String(details.url).slice(0, 120)}`)
    }
    return { action: 'deny' }
  })

  // Belt-and-suspenders for the same threat: in-app navigation stays local
  // (file:// bundle, Vite dev server in dev). A top-level navigation to
  // http(s) or any other scheme is cancelled — external pages belong in
  // the browser, not in our privileged window.
  // SECURITY (M1): the dev-server origin is trusted only in dev. A packaged
  // build must never honor ELECTRON_RENDERER_URL here — otherwise a local env
  // var would whitelist an attacker-controlled origin inside this window.
  const trustedDevServerUrl = !app.isPackaged ? (process.env['ELECTRON_RENDERER_URL'] ?? '') : ''
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isAllowedNavigationTarget(navigationUrl, trustedDevServerUrl)) {
      event.preventDefault()
      warn('app', `Blocked navigation to: ${String(navigationUrl).slice(0, 160)}`)
    }
  })

  // No `<webview>` is used anywhere — refuse to attach one if renderer
  // content ever requests it.
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
    warn('app', 'Blocked webview attach (webviews are not used by the app).')
  })

  // Stream buffered + future logs to the renderer (subscribed once globally).
  armLogForwarding()

  // SECURITY (M1): a packaged build must never load renderer content from
  // ELECTRON_RENDERER_URL. That env var is trivially settable by any local
  // process, and the renderer owns the full privileged preload bridge
  // (~50 invoke handlers: install/start/applyHosts/relaunchAsAdmin/...), so
  // a remote URL here turns into local SYSTEM/admin code execution.
  // DevTools likewise open only for a validated local dev server, never
  // in packaged builds.
  const rawDevUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
  if (app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    warn('app', 'Ignoring ELECTRON_RENDERER_URL in packaged build (possible renderer-substitution attempt).')
  }
  const devUrl = isLocalDevServerUrl(rawDevUrl) ? (rawDevUrl as string) : undefined
  if (rawDevUrl && !devUrl) {
    warn('app', `Ignoring invalid ELECTRON_RENDERER_URL (expected local http dev server): ${String(rawDevUrl).slice(0, 120)}`)
  }
  if (devUrl) {
    // Vite may need a second to start; Electron otherwise shows a white
    // screen with ERR_CONNECTION_REFUSED and never retries.
    const loadWithRetry = (attempt = 0): void => {
      mainWindow
        ?.loadURL(devUrl)
        .catch(() => {
          if (attempt < 20) setTimeout(() => loadWithRetry(attempt + 1), 500)
        })
    }
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      err('app', `did-fail-load ${code} ${desc} ${url}`)
      if (url === devUrl) loadWithRetry()
    })
    loadWithRetry()
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/**
 * True for a local Vite dev-server URL (`http://127.0.0.1:5174`-like).
 * Module-private pure helper (kept next to its only call site).
 */
function isLocalDevServerUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1'
}



async function firstRunCheck(): Promise<void> {
  // Master-setup hint: no strategy ever installed + no settings choice yet.
  const settings = loadSettings()
  if (settings.activeStrategyId) return
  try {
    const st = await statusSnapshot(await currentElevation())
    if (st.activeStrategy || st.zapret !== 'NOT_INSTALLED') return
  } catch {
    return
  }
  const strategies = listStrategies()
  const names = strategies.slice(0, 5).map((s) => s.name).join(', ')
  const locale = settings.locale
  void dialog
    .showMessageBox({
      type: 'info',
      title: `Zapret GUI — ${translate(locale, 'wizard.title')}`,
      message: translate(locale, 'wizard.step1'),
      detail: `${translate(locale, 'wizard.step2')} ${translate(locale, 'wizard.available').replace('{names}', names)}`,
      buttons: ['OK']
    })
    .catch(() => undefined)
  saveSettings({})
}

// Dev mode: keep Chromium caches out of the installed app's userData dir.
// A dev instance and the installed app running side by side lock each
// other's disk caches ("Unable to create cache (0x5)"). Must run before ready.
if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
  app.setPath('userData', path.join(app.getPath('appData'), 'zapret-gui-dev'))
  // Reduce disk-cache locking on Windows (access denied 0x5 when a stale
  // Electron process still holds the Cache folder).
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
  app.commandLine.appendSwitch('disable-http-cache')
}

// Single instance: a second launch only focuses the running app instead of
// spawning a duplicate tray icon that would fight over the same service.
async function acquireSingleInstanceLock(): Promise<boolean> {
  try {
    if (app.requestSingleInstanceLock()) return true
  } catch {
    return false
  }
  // Elevated handover copy (`--admin-relaunch`): the old non-admin instance
  // releases the lock BEFORE Start-Process and quits with a delay AFTER it,
  // so the lock is usually free already — but on a slow start (or a late
  // UAC "Yes" answered after the old instance gave up and re-acquired) it
  // may still be held. Quitting instantly then looks exactly like the
  // reported "clicked Yes and nothing happened": wait for the old instance
  // to step aside instead.
  if (!isAdminHandoverArgv(process.argv)) return false
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      if (app.requestSingleInstanceLock()) return true
    } catch {
      /* lock holder still alive — keep waiting */
    }
  }
  return false
}

void acquireSingleInstanceLock().then((held) => {
  if (!held) {
    app.quit()
    return
  }
  app.on('second-instance', (_event, argv) => {
    // A late UAC "Yes" (answered after this instance already gave up waiting
    // and re-acquired the lock): the elevated copy is starting now and is
    // retrying the lock above. If WE are not elevated, step aside for it —
    // otherwise the new copy exhausts its retries and quits ("nothing").
    if (isAdminHandoverArgv(argv ?? [])) {
      void currentElevation()
        .then((admin) => {
          if (!admin) {
            try {
              info('app', 'Elevated copy detected (second-instance handover) — quitting this instance.')
            } catch {
              /* logging is best-effort */
            }
            app.quit()
          } else {
            showMainWindow()
          }
        })
        .catch(() => showMainWindow())
      return
    }
    showMainWindow()
  })

  app.whenReady().then(() => {
    // Linux guard: the app must NEVER run as root. Refuse early with a clear
    // message instead of silently running an X/Electron session as uid 0.
    if (isLinux() && isRootProcess()) {
      dialog.showErrorBox(
        'Zapret GUI',
        'Do not run Zapret GUI as root. Start it as a normal user and grant root access in the app — privileges are held via pkexec/sudo while the app stays unprivileged.'
      )
      app.quit()
      return
    }
    electronApp.setAppUserModelId('com.zapret.gui')
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    try {
      initLogger(getAppLogPath(), getTgProxyLogPath())
      try {
        setLogsEnabled(loadSettings().logsEnabled !== false)
      } catch {
        /* defaults to on */
      }
      ensureDataDirSeeded()
    } catch (e) {
      // A broken %APPDATA% / AV lock must not silently kill startup.
      console.error(`Startup seeding failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      info('app', `Zapret GUI starting. Data dir: ${getDataDir()}`)
    } catch {
      /* logging is best-effort */
    }

    registerIpcHandlers()
    createWindow()
    setupAutoUpdater()
    // Autostart the built-in TG proxy when enabled (best effort — a busy
    // port must never break app startup). After "relaunch as admin" the old
    // instance may still hold the port for ~1s, so start with retries.
    // With the handover marker the proxy restarts even if autoStart is off:
    // it was running before the relaunch and the old instance freed the port
    // specifically for us.
    try {
      const s = loadSettings()
      const handover = process.argv.includes(TG_PROXY_RESTART_ARG)
      if (handover || s.tgProxy.autoStart) {
        if (handover) info('tg-proxy', 'Admin handover detected — restarting TG proxy.')
        // The proxy dials Telegram by IP, which needs the IPSet list — load it
        // before the first DC connection, not after a timeout.
        void (async () => {
          await ensureIPSetForTelegram({
            listsDir: getListsDir(),
            onLog: (level, text) => (level === 'warn' ? warn : info)('tg-proxy', text)
          }).catch(() => undefined)
          await startTgProxyWithRetry(handover ? 'admin-handover' : 'autoStart')
        })()
      }
    } catch {
      /* best-effort */
    }
    void firstRunCheck().catch(() => undefined)
    void refreshTray()
    setInterval(() => {
      void refreshTray()
    }, 15000).unref?.()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((e) => {
    console.error(`app.whenReady failed: ${e instanceof Error ? e.message : String(e)}`)
  })
})

app.on('window-all-closed', () => {
  // Keep running in tray when the tray icon is enabled (Windows + Linux).
  try {
    if (loadSettings().showTrayIcon && process.platform !== 'darwin') return
  } catch {
    /* fall through to default */
  }
  if (process.platform !== 'darwin') app.quit()
})
