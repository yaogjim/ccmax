import { app, session } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  createSha512Inspector,
  isAdhocSignedCodesignOutput,
  renderMacUpdateScript,
  selectMacUpdateZip,
  type MacUpdateArch,
} from './macUpdate'
import { updaterSessionProxyConfig, type MacUpdateBackend } from './updater'

export type MacReplaceBackendOptions = {
  bundlePath: string
  arch: MacUpdateArch
  cacheDir: string
  logPath: string
}

/**
 * Ad-hoc signatures carry no team identifier, so Squirrel.Mac rejects the
 * update after the download. Signed builds stay on the native path.
 */
export function isAdhocSignedBundle(bundlePath: string): boolean {
  const result = spawnSync('codesign', ['-dv', '--verbose=2', bundlePath], { encoding: 'utf8' })
  if (result.error) return false
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return isAdhocSignedCodesignOutput(output)
}

export function createMacReplaceBackend(options: MacReplaceBackendOptions): MacUpdateBackend {
  return {
    async download({ files, proxy, onProgress }) {
      const asset = selectMacUpdateZip(files, options.arch)
      if (!asset) {
        throw new Error(`The release provides no macOS zip for ${options.arch}`)
      }

      if (!asset.sha512) throw new Error('Update metadata is missing sha512')
      mkdirSync(options.cacheDir, { recursive: true })
      const fileName = basename(asset.url.split('?')[0] ?? 'update.zip')
      const destination = join(options.cacheDir, fileName)
      const updateSession = session.fromPartition('persist:ccmax-update-download')
      await updateSession.setProxy(updaterSessionProxyConfig(proxy ?? null))

      const response = await updateSession.fetch(asset.url)
      if (!response.ok || !response.body) {
        throw new Error(`Update download failed with HTTP ${response.status}`)
      }

      const headerLength = Number(response.headers.get('content-length'))
      const total = Number.isFinite(headerLength) && headerLength > 0 ? headerLength : asset.size ?? null
      const inspector = createSha512Inspector()
      let transferred = 0
      const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      source.on('data', (chunk: Buffer) => {
        inspector.update(chunk)
        transferred += chunk.length
        onProgress({ transferred, total })
      })

      try {
        await pipeline(source, createWriteStream(destination))
      } catch (error) {
        rmSync(destination, { force: true })
        throw error
      }

      if (asset.sha512 && inspector.digestBase64() !== asset.sha512) {
        rmSync(destination, { force: true })
        throw new Error('Downloaded update failed its sha512 check')
      }
      return { path: destination }
    },

    install({ path }) {
      mkdirSync(options.cacheDir, { recursive: true })
      const scriptPath = join(options.cacheDir, 'install-update.sh')
      writeFileSync(scriptPath, renderMacUpdateScript({
        appPath: options.bundlePath,
        zipPath: path,
        backupPath: join(options.cacheDir, 'ccmax.app.previous'),
        logPath: options.logPath,
      }), { mode: 0o755 })

      const child = spawn('/bin/bash', [scriptPath, String(process.pid)], { detached: true, stdio: 'ignore' })
      child.unref()
      app.quit()
    },
  }
}
