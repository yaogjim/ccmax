import type { DesktopUpdateDownloadEvent } from '../../src/lib/desktopHost/types'
import type { MacUpdateFileInfo } from './macUpdate'
import { existsSync } from 'node:fs'
import { clearAppManagedPortableEnv } from './appMode'

export type ElectronUpdateInfo = {
  version: string
  body?: string | null
  releaseNotes?: string | Array<{ note?: string | null }> | null
  files?: MacUpdateFileInfo[]
}

export type ElectronUpdateCheckResult = {
  updateInfo?: ElectronUpdateInfo
} | null

export type ElectronUpdateCheckOptions = {
  proxy?: string
}

export type ElectronUpdaterLike = {
  autoDownload: boolean
  disableDifferentialDownload?: boolean
  logger?: unknown
  checkForUpdates(): Promise<ElectronUpdateCheckResult>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', handler: (progress: { transferred?: number, total?: number }) => void): ElectronUpdaterLike
  off(event: 'download-progress', handler: (progress: { transferred?: number, total?: number }) => void): ElectronUpdaterLike
}

export type ElectronUpdateMetadata = {
  version: string
  body: string | null
}

export type ElectronUpdaterProxyController = {
  apply(proxy: string | null): Promise<void>
}

export type ElectronUpdaterRuntimeOptions = {
  updateConfigPath?: string
  // Squirrel.Mac refuses ad-hoc signed builds, so those releases install the
  // downloaded zip with a replacement script instead of the native updater.
  macUpdateBackend?: MacUpdateBackend | null
  resolveUpdateFiles?: () => MacUpdateFileInfo[]
}

export type MacUpdateBackend = {
  download(input: {
    files: MacUpdateFileInfo[]
    proxy?: string | null
    onProgress: (progress: { transferred: number, total: number | null }) => void
  }): Promise<{ path: string }>
  install(input: { path: string }): void
}

export type UpdaterSessionProxyConfig = {
  mode?: 'system'
  proxyRules?: string
  proxyBypassRules?: string
}

// electron-updater performs all update traffic (metadata + downloads) on its
// own session partition, so proxy settings must target that session. Passing
// an empty config would mean fixed_servers with no rules (= direct), so the
// system fallback has to be an explicit `mode: 'system'`.
export function updaterSessionProxyConfig(proxy: string | null): UpdaterSessionProxyConfig {
  return proxy
    ? { proxyRules: proxy, proxyBypassRules: '<local>' }
    : { mode: 'system' }
}

export function normalizeUpdateInfo(info: ElectronUpdateInfo | undefined): ElectronUpdateMetadata | null {
  if (!info?.version) return null
  const releaseNotes = Array.isArray(info.releaseNotes)
    ? info.releaseNotes.map(note => note.note).filter(Boolean).join('\n\n')
    : info.releaseNotes
  return {
    version: info.version,
    body: info.body ?? releaseNotes ?? null,
  }
}

function isMissingUpdateMetadataError(error: unknown): boolean {
  if (!error) return false
  const maybeError = typeof error === 'object'
    ? error as { code?: unknown, message?: unknown, path?: unknown }
    : {}
  const code = typeof maybeError.code === 'string' ? maybeError.code : ''
  const path = typeof maybeError.path === 'string' ? maybeError.path : ''
  const message = typeof maybeError.message === 'string' && maybeError.message
    ? maybeError.message
    : String(error)
  const referencesChannelMetadata = /latest(?:-[a-z0-9]+)?(?:-[a-z0-9]+)?\.ya?ml/i.test(message)
  if (code === 'ENOENT') {
    return path.endsWith('app-update.yml') || message.includes('app-update.yml')
  }
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
    return referencesChannelMetadata
  }
  return referencesChannelMetadata && /cannot find|not found|404/i.test(message)
}

export class ElectronUpdaterService {
  private readonly updater: ElectronUpdaterLike
  private readonly proxyController?: ElectronUpdaterProxyController
  private readonly updateConfigPath?: string
  private pendingUpdate: ElectronUpdateMetadata | null = null
  private pendingFiles: MacUpdateFileInfo[] = []
  private downloadedUpdatePath: string | null = null
  private readonly macUpdateBackend?: MacUpdateBackend | null
  private readonly resolveUpdateFiles?: () => MacUpdateFileInfo[]
  private downloaded = false
  private proxyKey: string | null = null
  private currentProxy: string | null = null

  constructor(
    updater: ElectronUpdaterLike,
    proxyController?: ElectronUpdaterProxyController,
    runtimeOptions: ElectronUpdaterRuntimeOptions = {},
  ) {
    this.updater = updater
    this.proxyController = proxyController
    this.updateConfigPath = runtimeOptions.updateConfigPath
    this.macUpdateBackend = runtimeOptions.macUpdateBackend ?? null
    this.resolveUpdateFiles = runtimeOptions.resolveUpdateFiles
    this.updater.autoDownload = false
    // Differential download issues many small sequential range requests and is
    // RTT-bound against the GitHub CDN, so it downloads far below line speed.
    this.updater.disableDifferentialDownload = true
    this.updater.logger = null
  }

  private async applyProxy(options?: ElectronUpdateCheckOptions) {
    const proxy = options?.proxy?.trim() || null
    this.currentProxy = proxy
    if (!this.proxyController) return

    const nextProxyKey = proxy ? `manual:${proxy}` : 'system'
    if (this.proxyKey === nextProxyKey) return

    await this.proxyController.apply(proxy)
    this.proxyKey = nextProxyKey
  }

  async checkForUpdates(options?: ElectronUpdateCheckOptions): Promise<ElectronUpdateMetadata | null> {
    let result: ElectronUpdateCheckResult
    try {
      await this.applyProxy(options)
      if (this.updateConfigPath && !existsSync(this.updateConfigPath)) {
        result = null
      } else {
        result = await this.updater.checkForUpdates()
      }
    } catch (error) {
      if (!isMissingUpdateMetadataError(error)) throw error
      result = null
    }
    this.pendingUpdate = normalizeUpdateInfo(result?.updateInfo)
    this.pendingFiles = result?.updateInfo?.files ?? []
    this.downloadedUpdatePath = null
    this.downloaded = false
    return this.pendingUpdate
  }

  async downloadUpdate(emit: (event: DesktopUpdateDownloadEvent) => void): Promise<void> {
    if (!this.pendingUpdate) {
      throw new Error('No Electron update is available to download')
    }
    if (this.downloaded) {
      emit({ event: 'Finished' })
      return
    }

    if (this.macUpdateBackend) {
      const files = this.resolveUpdateFiles?.() ?? this.pendingFiles
      if (files.length === 0) throw new Error('Update metadata has no macOS payload files')
      const backend = this.macUpdateBackend
      let stagedTransferred = 0
      let stagedStarted = false
      const { path } = await backend.download({
        files,
        proxy: this.currentProxy,
        onProgress: (progress) => {
          if (!stagedStarted) {
            stagedStarted = true
            emit({ event: 'Started', data: { contentLength: progress.total } })
          }
          const chunkLength = Math.max(0, progress.transferred - stagedTransferred)
          stagedTransferred = progress.transferred
          if (chunkLength > 0) {
            emit({ event: 'Progress', data: { chunkLength } })
          }
        },
      })
      if (!stagedStarted) {
        emit({ event: 'Started', data: { contentLength: null } })
      }
      emit({ event: 'Finished' })
      this.downloadedUpdatePath = path
      this.downloaded = true
      return
    }

    let lastTransferred = 0
    let started = false
    const onProgress = (progress: { transferred?: number, total?: number }) => {
      const transferred = Math.max(0, progress.transferred ?? 0)
      if (!started) {
        started = true
        emit({ event: 'Started', data: { contentLength: progress.total ?? null } })
      }
      const chunkLength = Math.max(0, transferred - lastTransferred)
      lastTransferred = transferred
      if (chunkLength > 0) {
        emit({ event: 'Progress', data: { chunkLength } })
      }
    }

    this.updater.on('download-progress', onProgress)
    try {
      await this.updater.downloadUpdate()
      if (!started) {
        emit({ event: 'Started', data: { contentLength: null } })
      }
      emit({ event: 'Finished' })
      this.downloaded = true
    } finally {
      this.updater.off('download-progress', onProgress)
    }
  }

  cancelInstall() {
    this.pendingUpdate = null
    this.pendingFiles = []
    this.downloadedUpdatePath = null
    this.downloaded = false
  }

  stageDownloadedUpdate() {
    if (!this.pendingUpdate) {
      throw new Error('No Electron update is ready to install')
    }
    if (!this.downloaded) {
      throw new Error('Electron update has not finished downloading')
    }
  }

  hasDownloadedUpdate(): boolean {
    return !!this.pendingUpdate && this.downloaded
  }

  quitAndInstallDownloadedUpdate(env: NodeJS.ProcessEnv = process.env) {
    this.stageDownloadedUpdate()
    if (this.macUpdateBackend && this.downloadedUpdatePath) {
      this.macUpdateBackend.install({ path: this.downloadedUpdatePath })
      return
    }
    // The NSIS installer spawned here inherits this process's environment.
    // Hand it the same clean environment a manually launched setup gets, so
    // its legacy-data checks read the persisted app-mode.json instead of a
    // process-local snapshot that may disagree with it (#1160).
    clearAppManagedPortableEnv(env)
    this.updater.quitAndInstall(false, true)
  }
}
