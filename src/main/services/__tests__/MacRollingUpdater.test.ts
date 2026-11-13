import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => '2.1.10'),
    getPath: vi.fn((name: string) => `/mock/${name}`),
    getAppPath: vi.fn(() => '/mock/app')
  },
  net: {
    fetch: vi.fn()
  }
}))

import {
  buildMacReplaceScript,
  cleanUpdaterCacheDirectories,
  downloadAssetWithProgress,
  evaluateRollingUpdate,
  extractCommitShaFromReleaseBody,
  findDuplicateAppBundles,
  MacRollingUpdater,
  parseLatestMacManifest,
  readMacRollingFeedConfig,
  resolveMacInstallTargetPath,
  selectMacArchiveAsset
} from '../updater/macRollingUpdater'

const execFileAsync = promisify(execFile)

describe('macRollingUpdater', () => {
  const tempRoots: string[] = []

  const makeTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mac-rolling-updater-test-'))
    tempRoots.push(dir)
    return dir
  }

  beforeEach(() => {
    vi.clearAllMocks()
    delete (globalThis as { __APP_BUILD_INFO__?: unknown }).__APP_BUILD_INFO__
  })

  afterEach(() => {
    delete (globalThis as { __APP_BUILD_INFO__?: unknown }).__APP_BUILD_INFO__
    for (const dir of tempRoots.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('extractCommitShaFromReleaseBody', () => {
    it('extracts full 40-char SHA from rolling release markdown', () => {
      const sha = 'cb03312bea9343ce5f3df44bd375db7d8c375152'
      const body = `## Cherry Studio — Antigravity ACP Build (\`cb03312\`)\n\nBuilt from branch \`feat/antigravity-acp-windows\` (\`${sha}\`)`
      expect(extractCommitShaFromReleaseBody(body)).toBe(sha)
    })

    it('falls back to short SHA when full SHA is absent', () => {
      expect(extractCommitShaFromReleaseBody('Build (`f3f8a12`)')).toBe('f3f8a12')
    })

    it('returns null when no commit hash is present', () => {
      expect(extractCommitShaFromReleaseBody('Regular release notes')).toBeNull()
      expect(extractCommitShaFromReleaseBody(null)).toBeNull()
    })
  })

  describe('evaluateRollingUpdate', () => {
    it('detects newer semver releases immediately', () => {
      expect(
        evaluateRollingUpdate({
          localVersion: '2.1.10',
          localBuild: {
            version: '2.1.10',
            commitSha: 'aaaaaaa111111111111111111111111111111111',
            shortSha: 'aaaaaaa',
            builtAt: '2026-11-13T10:00:00.000Z'
          },
          remoteVersion: '2.1.11',
          remoteCommitSha: 'aaaaaaa111111111111111111111111111111111',
          remoteBuiltAt: '2026-11-10T10:00:00.000Z'
        })
      ).toMatchObject({ isUpdateAvailable: true, isCurrent: false, reason: 'newer-version' })
    })

    it('treats matching commit SHA on same semver as already current', () => {
      expect(
        evaluateRollingUpdate({
          localVersion: '2.1.10',
          localBuild: {
            version: '2.1.10',
            commitSha: 'f3f8a12500000000000000000000000000000000',
            shortSha: 'f3f8a12',
            builtAt: '2026-11-13T10:00:00.000Z'
          },
          remoteVersion: '2.1.10',
          remoteCommitSha: 'f3f8a125',
          remoteBuiltAt: '2026-11-13T11:00:00.000Z'
        })
      ).toMatchObject({ isUpdateAvailable: false, isCurrent: true, reason: 'same-commit' })
    })

    it('offers rolling update on same semver when commit differs and remote build is newer', () => {
      expect(
        evaluateRollingUpdate({
          localVersion: '2.1.10',
          localBuild: {
            version: '2.1.10',
            commitSha: 'cb03312bea9343ce5f3df44bd375db7d8c375152',
            shortSha: 'cb03312',
            builtAt: '2026-11-09T10:00:00.000Z'
          },
          remoteVersion: '2.1.10',
          remoteCommitSha: 'f3f8a125aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          remoteBuiltAt: '2026-11-13T10:50:00.000Z'
        })
      ).toMatchObject({ isUpdateAvailable: true, isCurrent: false, reason: 'newer-build' })
    })

    it('does not offer a downgrade when local build is newer than remote rolling tag', () => {
      expect(
        evaluateRollingUpdate({
          localVersion: '2.1.10',
          localBuild: {
            version: '2.1.10',
            commitSha: 'f3f8a125aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            shortSha: 'f3f8a12',
            builtAt: '2026-11-13T11:00:00.000Z'
          },
          remoteVersion: '2.1.10',
          remoteCommitSha: 'cb03312bea9343ce5f3df44bd375db7d8c375152',
          remoteBuiltAt: '2026-11-09T10:18:36.000Z'
        })
      ).toMatchObject({ isUpdateAvailable: false, isCurrent: true, reason: 'local-build-not-older' })
    })
  })

  describe('manifest and asset resolution', () => {
    it('parses latest-mac.yml and selects matching macOS architecture archive', () => {
      const yaml = `
version: 2.1.10
files:
  - url: Cherry-Studio-2.1.10-mac-x64.zip
    sha512: x64hash
    size: 315983080
  - url: Cherry-Studio-2.1.10-mac-arm64.zip
    sha512: arm64hash
    size: 292312341
releaseDate: '2026-11-13T12:00:00.000Z'
commitSha: f3f8a125aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`
      const manifest = parseLatestMacManifest(yaml)
      expect(manifest).not.toBeNull()
      expect(manifest?.commitSha).toBe('f3f8a125aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

      const arm64Asset = selectMacArchiveAsset({
        arch: 'arm64',
        owner: 'Andy-Lin55',
        repo: 'cherry-studio',
        rollingTag: 'mac-acp-latest',
        manifest
      })
      expect(arm64Asset).toEqual({
        name: 'Cherry-Studio-2.1.10-mac-arm64.zip',
        url: 'https://github.com/Andy-Lin55/cherry-studio/releases/download/mac-acp-latest/Cherry-Studio-2.1.10-mac-arm64.zip',
        sha512: 'arm64hash',
        size: 292312341,
        updatedAt: undefined
      })
    })

    it('reads GitHub prerelease updater config only on macOS', () => {
      const dir = makeTempDir()
      const cfgPath = join(dir, 'app-update.yml')
      writeFileSync(
        cfgPath,
        'provider: github\nowner: Andy-Lin55\nrepo: cherry-studio\nreleaseType: prerelease\nupdaterCacheDirName: cherrystudio-updater\n',
        'utf8'
      )

      expect(readMacRollingFeedConfig({ platform: 'darwin', configPath: cfgPath })).toEqual({
        owner: 'Andy-Lin55',
        repo: 'cherry-studio',
        rollingTag: 'mac-acp-latest',
        updaterCacheDirName: 'cherrystudio-updater'
      })
      expect(readMacRollingFeedConfig({ platform: 'win32', configPath: cfgPath })).toBeNull()
    })
  })

  describe('bundle path and duplicate cleanup', () => {
    it('resolves running .app target and redirects DMG/translocated launches to /Applications', () => {
      expect(resolveMacInstallTargetPath('/Applications/Cherry Studio.app/Contents/MacOS/Cherry Studio')).toBe(
        '/Applications/Cherry Studio.app'
      )
      expect(
        resolveMacInstallTargetPath(
          '/Volumes/Cherry Studio 2.1.10-arm64/Cherry Studio.app/Contents/MacOS/Cherry Studio'
        )
      ).toBe('/Applications/Cherry Studio.app')
      expect(
        resolveMacInstallTargetPath(
          '/private/var/folders/xx/T/AppTranslocation/ABC/d/Cherry Studio.app/Contents/MacOS/Cherry Studio'
        )
      ).toBe('/Applications/Cherry Studio.app')
    })

    it('detects Finder-style duplicate Cherry Studio bundles without touching unrelated apps', () => {
      const root = makeTempDir()
      const sysApps = join(root, 'Applications')
      const userApps = join(root, 'UserApplications')
      mkdirSync(sysApps, { recursive: true })
      mkdirSync(userApps, { recursive: true })

      const target = join(sysApps, 'Cherry Studio.app')
      const dup2 = join(sysApps, 'Cherry Studio 2.app')
      const dupBak = join(sysApps, 'Cherry Studio.app.bak')
      const dupCopy = join(sysApps, 'Cherry Studio copy.app')
      const userDup = join(userApps, 'Cherry Studio (1).app')
      const unrelated = join(sysApps, 'Cherry Computer Use.app')

      for (const dir of [target, dup2, dupBak, dupCopy, userDup, unrelated]) {
        mkdirSync(dir, { recursive: true })
      }

      const found = findDuplicateAppBundles(target, [sysApps, userApps])
      expect(found.sort()).toEqual([dup2, dupBak, dupCopy, userDup].sort())
    })

    it('cleans legacy updater cache directories and generates valid POSIX replace script', async () => {
      const root = makeTempDir()
      const cacheDir = join(root, 'cherrystudio-updater')
      mkdirSync(join(cacheDir, 'pending'), { recursive: true })
      writeFileSync(join(cacheDir, 'update.zip'), 'stale', 'utf8')

      cleanUpdaterCacheDirectories([cacheDir])
      expect(existsSync(cacheDir)).toBe(false)

      const script = buildMacReplaceScript({
        parentPid: 99999,
        targetAppPath: '/Applications/Cherry Studio.app',
        stagedAppPath: join(root, 'extracted', 'Cherry Studio.app'),
        stagingRoot: root,
        duplicateBundlePaths: ['/Applications/Cherry Studio 2.app', '/Users/test/Applications/Cherry Studio.app'],
        cacheDirsToClean: [cacheDir],
        logPath: join(root, 'mac-updater.log'),
        requiresElevation: false
      })

      expect(script).toContain('mv "$TARGET_APP" "$ROLLBACK_APP"')
      expect(script).toContain('rm -rf "$ROLLBACK_DIR"')
      expect(script).toContain('lsregister')
      expect(script).toContain('Cherry Studio 2.app')
      expect(script).toContain('/usr/bin/open -n "$TARGET_APP"')

      const scriptPath = join(root, 'apply.sh')
      writeFileSync(scriptPath, script, 'utf8')
      await expect(execFileAsync('/bin/sh', ['-n', scriptPath])).resolves.toBeDefined()
    })
  })

  describe('downloadAssetWithProgress & MacRollingUpdater', () => {
    it('streams archive, emits progress, and validates SHA-512 checksum', async () => {
      const root = makeTempDir()
      const destPath = join(root, 'Cherry-Studio-2.1.10-mac-arm64.zip')
      const payload = Buffer.from('cherry-studio-archive-payload')
      const expectedSha512 = createHash('sha512').update(payload).digest('base64')
      const progressEvents: number[] = []

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload.subarray(0, 12))
          controller.enqueue(payload.subarray(12))
          controller.close()
        }
      })

      const fetchMock = vi.fn(async () => {
        return new Response(stream, {
          status: 200,
          headers: { 'content-length': String(payload.length) }
        })
      })

      const downloaded = await downloadAssetWithProgress({
        url: 'https://example.com/app.zip',
        destPath,
        expectedSha512,
        headers: {},
        fetchFn: fetchMock,
        onProgress: (p) => progressEvents.push(p.percent)
      })

      expect(downloaded).toBe(destPath)
      expect(readFileSync(destPath)).toEqual(payload)
      expect(progressEvents.at(-1)).toBe(100)
    })

    it('rejects and removes files when SHA-512 verification fails', async () => {
      const root = makeTempDir()
      const destPath = join(root, 'corrupt.zip')
      const payload = Buffer.from('corrupt-bytes')

      const fetchMock = vi.fn(async () => {
        return new Response(payload, {
          status: 200,
          headers: { 'content-length': String(payload.length) }
        })
      })

      await expect(
        downloadAssetWithProgress({
          url: 'https://example.com/corrupt.zip',
          destPath,
          expectedSha512: 'invalid-checksum',
          headers: {},
          fetchFn: fetchMock,
          onProgress: vi.fn()
        })
      ).rejects.toThrow('checksum verification failed')

      expect(existsSync(destPath)).toBe(false)
      expect(existsSync(`${destPath}.part`)).toBe(false)
    })

    it('emits available -> progress -> downloaded and skips re-download on repeat checks', async () => {
      const root = makeTempDir()
      const cachesDir = join(root, 'Library', 'Caches')
      const resourcesDir = join(root, 'resources')
      mkdirSync(cachesDir, { recursive: true })
      mkdirSync(resourcesDir, { recursive: true })

      writeFileSync(
        join(resourcesDir, 'app-update.yml'),
        'provider: github\nowner: Andy-Lin55\nrepo: cherry-studio\nreleaseType: prerelease\nupdaterCacheDirName: cherrystudio-updater\n',
        'utf8'
      )

      vi.mocked(app.getPath).mockImplementation((name: string) => (name === 'home' ? root : join(root, name)))
      ;(globalThis as { __APP_BUILD_INFO__?: unknown }).__APP_BUILD_INFO__ = {
        version: '2.1.10',
        commitSha: '1111111111111111111111111111111111111111',
        shortSha: '1111111',
        builtAt: '2026-11-09T10:00:00.000Z'
      }

      const payload = Buffer.from('fake-zip-bytes')
      const sha512 = createHash('sha512').update(payload).digest('base64')
      const remoteYaml = `
version: 2.1.10
files:
  - url: Cherry-Studio-2.1.10-mac-arm64.zip
    sha512: ${sha512}
    size: ${payload.length}
  - url: Cherry-Studio-2.1.10-mac-x64.zip
    sha512: ${sha512}
    size: ${payload.length}
releaseDate: '2026-11-13T12:00:00.000Z'
`
      const remoteMeta = {
        version: '2.1.10',
        commitSha: '2222222222222222222222222222222222222222',
        shortSha: '2222222',
        builtAt: '2026-11-13T12:00:00.000Z',
        releaseName: '2.1.10 (2222222)'
      }

      let archiveFetches = 0
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/latest-mac.yml')) return new Response(remoteYaml, { status: 200 })
        if (url.endsWith('/mac-build-meta.json')) return new Response(JSON.stringify(remoteMeta), { status: 200 })
        if (url.includes('api.github.com')) return new Response('{}', { status: 403 })
        if (url.endsWith('.zip')) {
          archiveFetches += 1
          return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } })
        }
        return new Response('', { status: 404 })
      })

      const callbacks = {
        onAvailable: vi.fn(),
        onNotAvailable: vi.fn(),
        onDownloadProgress: vi.fn(),
        onDownloaded: vi.fn(),
        onError: vi.fn()
      }
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      const updater = new MacRollingUpdater(logger, callbacks, fetchMock)
      vi.spyOn(updater, 'getConfig').mockReturnValue(
        readMacRollingFeedConfig({ platform: 'darwin', configPath: join(resourcesDir, 'app-update.yml') })
      )

      await updater.checkAndDownload()
      expect(archiveFetches).toBe(1)
      expect(callbacks.onAvailable).toHaveBeenCalledWith(
        expect.objectContaining({ version: '2.1.10', releaseName: '2.1.10 (2222222)' })
      )
      expect(callbacks.onDownloaded).toHaveBeenCalledTimes(1)
      expect(updater.hasDownloadedUpdate()).toBe(true)

      await updater.checkAndDownload()
      expect(archiveFetches).toBe(1)
      expect(callbacks.onDownloaded).toHaveBeenCalledTimes(2)
    })
  })
})
