import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { ProgressInfo, UpdateFileInfo, UpdateInfo } from 'builder-util-runtime'
import { app, net } from 'electron'
import { gt, lt, valid } from 'semver'
import { parse as parseYaml } from 'yaml'

import type { AppUpdaterNotAvailablePayload } from '@shared/ipc/schemas/app'
import { type AppBuildInfo, getEmbeddedAppBuildInfo } from '@shared/utils/buildInfo'

const execFileAsync = promisify(execFile)

export const DEFAULT_ROLLING_TAG = 'mac-acp-latest'
export const DEFAULT_UPDATER_CACHE_DIR = 'cherrystudio-updater'
const LSREGISTER_PATH =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const DUPLICATE_BUNDLE_PATTERN =
  /^Cherry Studio(?:\s+\d+|\s*\(\d+\)|\s+copy|\s+backup|\s*\(old\)|\s+old|\.bak)?\.app(?:\.bak|\.old)?$/i
const ROLLING_BUILD_TIME_SKEW_MS = 60_000
const PROGRESS_EMIT_INTERVAL_MS = 150

export type MacRollingFeedConfig = {
  owner: string
  repo: string
  rollingTag: string
  updaterCacheDirName: string
}

export type MacRollingManifest = {
  version: string
  files: UpdateFileInfo[]
  path?: string
  sha512?: string
  releaseDate?: string
  releaseName?: string | null
  releaseNotes?: string | null
  commitSha?: string | null
  builtAt?: string | null
}

export type MacBuildMeta = {
  version?: string
  commitSha?: string
  shortSha?: string
  builtAt?: string
  releaseName?: string
  releaseNotes?: string
}

export type GitHubReleaseAsset = {
  name: string
  browser_download_url: string
  size?: number
  updated_at?: string
}

export type GitHubReleaseResponse = {
  tag_name?: string
  name?: string | null
  body?: string | null
  target_commitish?: string | null
  published_at?: string | null
  prerelease?: boolean
  assets?: GitHubReleaseAsset[]
}

export type RollingUpdateComparison = {
  isUpdateAvailable: boolean
  isCurrent: boolean
  reason:
    | 'newer-version'
    | 'older-version'
    | 'same-commit'
    | 'newer-build'
    | 'local-build-not-older'
    | 'different-commit'
    | 'up-to-date'
}

export type SelectedMacAsset = {
  name: string
  url: string
  sha512?: string
  size?: number
  updatedAt?: string
}

export type ResolvedMacRelease = {
  updateInfo: UpdateInfo
  asset: SelectedMacAsset
  remoteCommitSha: string | null
  remoteBuiltAt: string | null
  signature: string
  comparison: RollingUpdateComparison
}

type FetchLike = typeof fetch

export type MacRollingLogger = {
  info: (message: string, ...args: any[]) => void

  warn: (message: string, ...args: any[]) => void

  error: (message: string, ...args: any[]) => void
}

export type MacRollingCallbacks = {
  onAvailable: (info: UpdateInfo) => void
  onNotAvailable: (payload: AppUpdaterNotAvailablePayload) => void
  onDownloadProgress: (progress: ProgressInfo) => void
  onDownloaded: (info: UpdateInfo) => void
  onError: (error: Error) => void
}

function escapeShellDoubleQuoted(value: string): string {
  return value.replace(/(["\\$`])/g, '\\$1')
}

export function normalizeCommitSha(sha: string | null | undefined): string | null {
  if (!sha) return null
  const normalized = sha.trim().toLowerCase()
  return /^[a-f0-9]{7,40}$/.test(normalized) ? normalized : null
}

export function commitShasMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const shaA = normalizeCommitSha(a)
  const shaB = normalizeCommitSha(b)
  if (!shaA || !shaB) return false
  return shaA === shaB || shaA.startsWith(shaB) || shaB.startsWith(shaA)
}

export function extractCommitShaFromReleaseBody(body: string | null | undefined): string | null {
  if (!body) return null
  // Prefer full 40-char SHA, e.g. (`cb03312bea9343...`) or `Commit: cb03312bea...`
  const fullParenMatch = body.match(/\(`([a-f0-9]{40})`\)/i)
  if (fullParenMatch) return fullParenMatch[1].toLowerCase()

  const explicitFullMatch = body.match(/\b(?:commit|sha)\s*[:=]\s*`?([a-f0-9]{40})`?/i)
  if (explicitFullMatch) return explicitFullMatch[1].toLowerCase()

  const anyFullMatch = body.match(/\b([a-f0-9]{40})\b/i)
  if (anyFullMatch) return anyFullMatch[1].toLowerCase()

  const shortParenMatch = body.match(/\(`([a-f0-9]{7,12})`\)/i)
  if (shortParenMatch) return shortParenMatch[1].toLowerCase()

  return null
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Determine whether a rolling GitHub prerelease feed has a newer build than
 * what is currently running. Prevents infinite loops when semver stays constant
 * across commits and blocks downgrades when running a newer local build.
 */
export function evaluateRollingUpdate(params: {
  localVersion: string
  localBuild: AppBuildInfo | null
  localBundleMtimeMs?: number | null
  remoteVersion: string
  remoteCommitSha: string | null
  remoteBuiltAt: string | null
}): RollingUpdateComparison {
  const { localVersion, localBuild, localBundleMtimeMs, remoteVersion, remoteCommitSha, remoteBuiltAt } = params
  const validLocal = valid(localVersion)
  const validRemote = valid(remoteVersion)

  if (validLocal && validRemote) {
    if (gt(validRemote, validLocal)) {
      return { isUpdateAvailable: true, isCurrent: false, reason: 'newer-version' }
    }
    if (lt(validRemote, validLocal)) {
      return { isUpdateAvailable: false, isCurrent: true, reason: 'older-version' }
    }
  }

  if (localBuild?.commitSha && remoteCommitSha && commitShasMatch(localBuild.commitSha, remoteCommitSha)) {
    return { isUpdateAvailable: false, isCurrent: true, reason: 'same-commit' }
  }

  const remoteMs = parseTimestampMs(remoteBuiltAt)
  const localMs = parseTimestampMs(localBuild?.builtAt) ?? localBundleMtimeMs ?? null

  if (remoteMs !== null && localMs !== null) {
    if (remoteMs > localMs + ROLLING_BUILD_TIME_SKEW_MS) {
      return { isUpdateAvailable: true, isCurrent: false, reason: 'newer-build' }
    }
    return { isUpdateAvailable: false, isCurrent: true, reason: 'local-build-not-older' }
  }

  if (localBuild?.commitSha && remoteCommitSha && !commitShasMatch(localBuild.commitSha, remoteCommitSha)) {
    return { isUpdateAvailable: true, isCurrent: false, reason: 'different-commit' }
  }

  return { isUpdateAvailable: false, isCurrent: true, reason: 'up-to-date' }
}

/**
 * Read GitHub prerelease updater config from `app-update.yml` (packaged) or
 * an explicit config path. Returns `null` for non-macOS, upstream generic feeds,
 * or test environments without `app-update.yml`.
 */
export function readMacRollingFeedConfig(options?: {
  platform?: NodeJS.Platform
  isPackaged?: boolean
  resourcesPath?: string
  appPath?: string
  configPath?: string
  isVitest?: boolean
}): MacRollingFeedConfig | null {
  const platform = options?.platform ?? process.platform
  if (platform !== 'darwin') return null

  const isVitest = options?.isVitest ?? Boolean(process.env.VITEST)
  let resolvedPath = options?.configPath

  if (!resolvedPath) {
    const isPackaged = options?.isPackaged ?? app.isPackaged
    if (isPackaged) {
      const resPath = options?.resourcesPath ?? process.resourcesPath
      if (!resPath) return null
      resolvedPath = join(resPath, 'app-update.yml')
    } else {
      if (isVitest) return null
      const appPath = options?.appPath ?? app.getAppPath()
      resolvedPath = join(appPath, 'dev-app-update.yml')
    }
  }

  if (!resolvedPath || !existsSync(resolvedPath)) return null

  try {
    const parsed = parseYaml(readFileSync(resolvedPath, 'utf8')) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.provider !== 'github' || parsed.releaseType !== 'prerelease') return null
    const owner = typeof parsed.owner === 'string' ? parsed.owner.trim() : ''
    const repo = typeof parsed.repo === 'string' ? parsed.repo.trim() : ''
    if (!owner || !repo) return null

    const rollingTag = typeof parsed.tag === 'string' && parsed.tag.trim() ? parsed.tag.trim() : DEFAULT_ROLLING_TAG
    const updaterCacheDirName =
      typeof parsed.updaterCacheDirName === 'string' && parsed.updaterCacheDirName.trim()
        ? parsed.updaterCacheDirName.trim()
        : DEFAULT_UPDATER_CACHE_DIR

    return { owner, repo, rollingTag, updaterCacheDirName }
  } catch {
    return null
  }
}

export function parseLatestMacManifest(rawYaml: string): MacRollingManifest | null {
  try {
    const parsed = parseYaml(rawYaml) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return null
    const version = typeof parsed.version === 'string' ? parsed.version.trim() : ''
    if (!version) return null

    const rawFiles = Array.isArray(parsed.files) ? parsed.files : []
    const files: UpdateFileInfo[] = rawFiles
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
      .map((entry) => ({
        url: typeof entry.url === 'string' ? entry.url : '',
        sha512: typeof entry.sha512 === 'string' ? entry.sha512 : '',
        size: typeof entry.size === 'number' ? entry.size : undefined
      }))
      .filter((entry) => entry.url.length > 0)

    return {
      version,
      files,
      path: typeof parsed.path === 'string' ? parsed.path : undefined,
      sha512: typeof parsed.sha512 === 'string' ? parsed.sha512 : undefined,
      releaseDate: typeof parsed.releaseDate === 'string' ? parsed.releaseDate : undefined,
      releaseName: typeof parsed.releaseName === 'string' ? parsed.releaseName : null,
      releaseNotes: typeof parsed.releaseNotes === 'string' ? parsed.releaseNotes : null,
      commitSha: typeof parsed.commitSha === 'string' ? normalizeCommitSha(parsed.commitSha) : null,
      builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : null
    }
  } catch {
    return null
  }
}

export function selectMacArchiveAsset(params: {
  arch: NodeJS.Architecture | string
  owner: string
  repo: string
  rollingTag: string
  manifest: MacRollingManifest | null
  apiAssets?: GitHubReleaseAsset[]
}): SelectedMacAsset | null {
  const targetArch = params.arch === 'arm64' ? 'arm64' : 'x64'
  const baseDownload = `https://github.com/${params.owner}/${params.repo}/releases/download/${encodeURIComponent(params.rollingTag)}`
  const resolveUrl = (rawUrl: string) =>
    /^https?:\/\//i.test(rawUrl) ? rawUrl : `${baseDownload}/${encodeURIComponent(rawUrl)}`

  const apiByName = new Map((params.apiAssets ?? []).map((asset) => [asset.name.toLowerCase(), asset]))
  const manifestFiles = params.manifest?.files ?? []

  const patterns = [
    new RegExp(`-mac-${targetArch}\\.zip$`, 'i'),
    new RegExp(`-${targetArch}\\.zip$`, 'i'),
    new RegExp(`-mac-${targetArch}\\.dmg$`, 'i'),
    new RegExp(`-${targetArch}\\.dmg$`, 'i')
  ]

  for (const pattern of patterns) {
    const manifestMatch = manifestFiles.find((file) => pattern.test(basename(file.url)))
    if (manifestMatch) {
      const name = basename(manifestMatch.url)
      const apiMatch = apiByName.get(name.toLowerCase())
      return {
        name,
        url: apiMatch?.browser_download_url || resolveUrl(manifestMatch.url),
        sha512: manifestMatch.sha512 || undefined,
        size: manifestMatch.size ?? apiMatch?.size,
        updatedAt: apiMatch?.updated_at
      }
    }

    const apiMatch = (params.apiAssets ?? []).find((asset) => pattern.test(asset.name))
    if (apiMatch) {
      return {
        name: apiMatch.name,
        url: apiMatch.browser_download_url,
        size: apiMatch.size,
        updatedAt: apiMatch.updated_at
      }
    }
  }

  return null
}

/**
 * Resolve the `.app` bundle directory that owns the currently running binary,
 * redirecting read-only DMG mounts or AppTranslocation copies to `/Applications`.
 */
export function resolveMacInstallTargetPath(execPath: string): string {
  const defaultTarget = '/Applications/Cherry Studio.app'
  const normalized = resolve(execPath)
  if (normalized.startsWith('/Volumes/') || normalized.includes('/AppTranslocation/')) {
    return defaultTarget
  }

  let cursor = dirname(normalized)
  while (cursor && cursor !== '/' && cursor !== '.') {
    if (cursor.endsWith('.app')) {
      return cursor
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }

  return defaultTarget
}

/**
 * Find old or Finder-duplicated `Cherry Studio*.app` bundles inside Applications
 * directories so installing an update never leaves stale copies behind.
 */
export function findDuplicateAppBundles(
  targetAppPath: string,
  searchDirs: string[] = ['/Applications', join(homedir(), 'Applications')]
): string[] {
  const resolvedTarget = resolve(targetAppPath)
  const seen = new Set<string>()
  const duplicates: string[] = []

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = resolve(join(dir, entry))
      if (fullPath === resolvedTarget || seen.has(fullPath)) continue
      const isDuplicateNamed = DUPLICATE_BUNDLE_PATTERN.test(entry)
      const isOtherApplicationsCopy =
        entry.toLowerCase() === 'cherry studio.app' && resolvedTarget === '/Applications/Cherry Studio.app'
      if (!isDuplicateNamed && !isOtherApplicationsCopy) continue

      try {
        if (statSync(fullPath).isDirectory()) {
          seen.add(fullPath)
          duplicates.push(fullPath)
        }
      } catch {
        // Ignore broken symlinks or inaccessible entries
      }
    }
  }

  return duplicates
}

export function cleanUpdaterCacheDirectories(cacheDirs: string[]): void {
  for (const dir of cacheDirs) {
    if (!dir || !existsSync(dir)) continue
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  }
}

export function buildMacReplaceScript(params: {
  parentPid: number
  targetAppPath: string
  stagedAppPath: string
  stagingRoot: string
  duplicateBundlePaths: string[]
  cacheDirsToClean: string[]
  logPath: string
  requiresElevation?: boolean
}): string {
  const {
    parentPid,
    targetAppPath,
    stagedAppPath,
    stagingRoot,
    duplicateBundlePaths,
    cacheDirsToClean,
    logPath,
    requiresElevation = false
  } = params

  const duplicateCleanupCommands = duplicateBundlePaths
    .map((dupPath) => {
      const q = escapeShellDoubleQuoted(dupPath)
      return [`"$LSREGISTER" -u "${q}" >/dev/null 2>&1 || true`, `rm -rf "${q}"`].join('\n  ')
    })
    .join('\n  ')

  const cacheCleanupCommands = cacheDirsToClean
    .map((dir) => `rm -rf "${escapeShellDoubleQuoted(dir)}" >/dev/null 2>&1 || true`)
    .join('\n')

  const swapCommands = [
    `ROLLBACK_DIR="${escapeShellDoubleQuoted(join(stagingRoot, 'rollback'))}"`,
    `TARGET_APP="${escapeShellDoubleQuoted(targetAppPath)}"`,
    `STAGED_APP="${escapeShellDoubleQuoted(stagedAppPath)}"`,
    `LSREGISTER="${escapeShellDoubleQuoted(LSREGISTER_PATH)}"`,
    `mkdir -p "$(dirname "$TARGET_APP")" "$ROLLBACK_DIR"`,
    `ROLLBACK_APP="${'${ROLLBACK_DIR}'}/Cherry Studio.app"`,
    `if [ -e "$TARGET_APP" ]; then mv "$TARGET_APP" "$ROLLBACK_APP"; fi`,
    `if ! mv "$STAGED_APP" "$TARGET_APP"; then`,
    `  if [ -e "$ROLLBACK_APP" ] && [ ! -e "$TARGET_APP" ]; then mv "$ROLLBACK_APP" "$TARGET_APP" || true; fi`,
    `  exit 1`,
    `fi`,
    `if [ ! -f "$TARGET_APP/Contents/MacOS/Cherry Studio" ]; then`,
    `  rm -rf "$TARGET_APP"`,
    `  if [ -e "$ROLLBACK_APP" ]; then mv "$ROLLBACK_APP" "$TARGET_APP" || true; fi`,
    `  exit 1`,
    `fi`,
    `/usr/bin/xattr -cr "$TARGET_APP" >/dev/null 2>&1 || true`,
    `rm -rf "$ROLLBACK_DIR"`,
    duplicateCleanupCommands ? `  ${duplicateCleanupCommands}` : ''
  ]
    .filter(Boolean)
    .join('\n')

  const swapScriptPath = join(stagingRoot, 'elevated-swap.sh')
  const swapExecutionBlock = requiresElevation
    ? [
        `cat > "${escapeShellDoubleQuoted(swapScriptPath)}" <<'CHERRY_SWAP_EOF'`,
        '#!/bin/sh',
        'set -eu',
        swapCommands,
        'CHERRY_SWAP_EOF',
        `chmod +x "${escapeShellDoubleQuoted(swapScriptPath)}"`,
        `/usr/bin/osascript -e 'do shell script "'"${escapeShellDoubleQuoted(swapScriptPath)}"'" with administrator privileges'`
      ].join('\n')
    : swapCommands

  return [
    '#!/bin/sh',
    'set -u',
    `LOG_FILE="${escapeShellDoubleQuoted(logPath)}"`,
    'mkdir -p "$(dirname "$LOG_FILE")" >/dev/null 2>&1 || true',
    'log() { printf "[%s] %s\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG_FILE" 2>/dev/null || true; }',
    `PARENT_PID=${Math.max(1, Math.floor(parentPid))}`,
    `TARGET_APP="${escapeShellDoubleQuoted(targetAppPath)}"`,
    `STAGING_ROOT="${escapeShellDoubleQuoted(stagingRoot)}"`,
    `LSREGISTER="${escapeShellDoubleQuoted(LSREGISTER_PATH)}"`,
    'log "Waiting for Cherry Studio pid=$PARENT_PID to exit..."',
    'WAIT_COUNT=0',
    'while kill -0 "$PARENT_PID" >/dev/null 2>&1; do',
    '  WAIT_COUNT=$((WAIT_COUNT + 1))',
    '  if [ "$WAIT_COUNT" -ge 120 ]; then',
    '    log "Timed out waiting for pid=$PARENT_PID to exit"',
    '    exit 1',
    '  fi',
    '  sleep 0.25',
    'done',
    'sleep 0.5',
    'log "Replacing app bundle at $TARGET_APP"',
    swapExecutionBlock,
    'SWAP_STATUS=$?',
    'if [ "$SWAP_STATUS" -ne 0 ]; then',
    '  log "Failed to swap app bundle (status=$SWAP_STATUS)"',
    '  exit "$SWAP_STATUS"',
    'fi',
    '"$LSREGISTER" -f "$TARGET_APP" >/dev/null 2>&1 || true',
    cacheCleanupCommands,
    'log "Relaunching $TARGET_APP"',
    '/usr/bin/open -n "$TARGET_APP" >/dev/null 2>&1 || true',
    'rm -rf "$STAGING_ROOT" >/dev/null 2>&1 || true',
    'log "macOS rolling update completed successfully"',
    'exit 0'
  ].join('\n')
}

function getLocalBundleMtimeMs(execPath: string): number | null {
  try {
    const bundlePath = resolveMacInstallTargetPath(execPath)
    if (existsSync(bundlePath)) {
      return statSync(bundlePath).mtimeMs
    }
    if (existsSync(execPath)) {
      return statSync(execPath).mtimeMs
    }
  } catch {
    // Ignore stat errors
  }
  return null
}

function isWritableDirectly(targetAppPath: string): boolean {
  const parentDir = dirname(targetAppPath)
  try {
    accessSync(parentDir, constants.W_OK | constants.X_OK)
    if (existsSync(targetAppPath)) {
      accessSync(targetAppPath, constants.W_OK)
    }
    return true
  } catch {
    return false
  }
}

async function fetchJsonOptional<T>(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<T | null> {
  try {
    const response = await fetchFn(url, { headers, redirect: 'follow', cache: 'no-store', signal })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

async function fetchTextOptional(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const response = await fetchFn(url, { headers, redirect: 'follow', cache: 'no-store', signal })
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

function buildRollingReleaseNotes(params: {
  baseNotes: string | null | undefined
  localVersion: string
  remoteVersion: string
  remoteCommitSha: string | null
  remoteBuiltAt: string | null
}): string | null {
  const { baseNotes, localVersion, remoteVersion, remoteCommitSha, remoteBuiltAt } = params
  if (localVersion !== remoteVersion || !remoteCommitSha) {
    return baseNotes ?? null
  }

  const shortSha = remoteCommitSha.slice(0, 7)
  const dateLabel = remoteBuiltAt ? remoteBuiltAt.slice(0, 10) : ''
  const enBanner = dateLabel
    ? `**Antigravity ACP Rolling Update (\`${shortSha}\`, ${dateLabel})**`
    : `**Antigravity ACP Rolling Update (\`${shortSha}\`)**`
  const zhBanner = dateLabel
    ? `**Antigravity ACP 滚动更新 (\`${shortSha}\`, ${dateLabel})**`
    : `**Antigravity ACP 滚动更新 (\`${shortSha}\`)**`

  if (baseNotes && baseNotes.includes('<!--LANG:en-->') && baseNotes.includes('<!--LANG:zh-CN-->')) {
    return baseNotes
      .replace('<!--LANG:en-->', `<!--LANG:en-->\n${enBanner}\n`)
      .replace('<!--LANG:zh-CN-->', `<!--LANG:zh-CN-->\n${zhBanner}\n`)
  }

  const header = `<!--LANG:en-->\n${enBanner}\n<!--LANG:zh-CN-->\n${zhBanner}\n<!--LANG:END-->`
  return baseNotes ? `${header}\n\n${baseNotes}` : header
}

export async function downloadAssetWithProgress(params: {
  url: string
  destPath: string
  expectedSha512?: string
  expectedSize?: number
  headers: Record<string, string>
  fetchFn?: FetchLike
  onProgress: (progress: ProgressInfo) => void
  signal?: AbortSignal
}): Promise<string> {
  const { url, destPath, expectedSha512, expectedSize, headers, onProgress, signal } = params
  const fetchFn = params.fetchFn ?? ((input, init) => net.fetch(input as string, init))

  mkdirSync(dirname(destPath), { recursive: true })
  const partPath = `${destPath}.part`
  rmSync(partPath, { force: true })

  const response = await fetchFn(url, { headers, redirect: 'follow', cache: 'no-store', signal })
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download update asset (${response.status} ${response.statusText})`)
  }

  const contentLength = Number(response.headers.get('content-length') || 0)
  const total = contentLength > 0 ? contentLength : expectedSize || 0
  const hash = createHash('sha512')
  const writeStream = createWriteStream(partPath)
  const reader = response.body.getReader()

  const startedAt = Date.now()
  let lastEmitAt = 0
  let transferred = 0

  const emitProgress = (force: boolean) => {
    const now = Date.now()
    if (!force && now - lastEmitAt < PROGRESS_EMIT_INTERVAL_MS) return
    lastEmitAt = now
    const elapsedSec = Math.max((now - startedAt) / 1000, 0.1)
    const effectiveTotal = total > 0 ? total : Math.max(transferred, 1)
    const percent = total > 0 ? Math.min(100, (transferred / total) * 100) : 0
    onProgress({
      bytesPerSecond: Math.round(transferred / elapsedSec),
      delta: transferred,
      percent,
      total: effectiveTotal,
      transferred
    })
  }

  const streamError = new Promise<never>((_, reject) => {
    writeStream.once('error', reject)
  })

  try {
    emitProgress(true)
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        hash.update(value)
        transferred += value.byteLength
        const canContinue = writeStream.write(value)
        if (!canContinue) {
          await Promise.race([
            new Promise<void>((resolveDrain) => writeStream.once('drain', resolveDrain)),
            streamError
          ])
        }
        emitProgress(false)
      }
    }

    await Promise.race([new Promise<void>((resolveFinish) => writeStream.end(resolveFinish)), streamError])

    if (transferred === 0) {
      throw new Error('Downloaded update archive was empty')
    }

    if (expectedSha512) {
      const expected = expectedSha512.trim()
      const actual = /^[a-f0-9]{128}$/i.test(expected) ? hash.digest('hex') : hash.digest('base64')
      if (actual.toLowerCase() !== expected.toLowerCase() && actual !== expected) {
        throw new Error('Update archive checksum verification failed')
      }
    }

    renameSync(partPath, destPath)
    emitProgress(true)
    return destPath
  } catch (error) {
    writeStream.destroy()
    rmSync(partPath, { force: true })
    rmSync(destPath, { force: true })
    throw error
  }
}

export async function prepareMacAppStage(params: { archivePath: string; stagingRoot: string }): Promise<string> {
  const { archivePath, stagingRoot } = params
  const extractedDir = join(stagingRoot, 'extracted')
  rmSync(extractedDir, { recursive: true, force: true })
  mkdirSync(extractedDir, { recursive: true })

  const lower = archivePath.toLowerCase()
  if (lower.endsWith('.zip')) {
    await execFileAsync('/usr/bin/ditto', ['-xk', archivePath, extractedDir])
  } else if (lower.endsWith('.dmg')) {
    const mountDir = join(stagingRoot, 'dmg-mount')
    rmSync(mountDir, { recursive: true, force: true })
    mkdirSync(mountDir, { recursive: true })
    await execFileAsync('/usr/bin/hdiutil', ['attach', archivePath, '-nobrowse', '-readonly', '-mountpoint', mountDir])
    try {
      const mountEntries = readdirSync(mountDir)
      const appName =
        mountEntries.find((entry) => entry === 'Cherry Studio.app') ??
        mountEntries.find((entry) => entry.endsWith('.app'))
      if (!appName) {
        throw new Error('Failed to locate Cherry Studio.app inside update disk image')
      }
      await execFileAsync('/usr/bin/ditto', [join(mountDir, appName), join(extractedDir, 'Cherry Studio.app')])
    } finally {
      await execFileAsync('/usr/bin/hdiutil', ['detach', mountDir, '-force']).catch(() => undefined)
      rmSync(mountDir, { recursive: true, force: true })
    }
  } else {
    throw new Error(`Unsupported macOS update archive format: ${basename(archivePath)}`)
  }

  const entries = readdirSync(extractedDir)
  const bundleName =
    entries.find((entry) => entry === 'Cherry Studio.app') ?? entries.find((entry) => entry.endsWith('.app'))
  if (!bundleName) {
    throw new Error('Extracted update archive did not contain Cherry Studio.app')
  }

  const stagedAppPath = join(extractedDir, bundleName)
  const executablePath = join(stagedAppPath, 'Contents', 'MacOS', 'Cherry Studio')
  if (!existsSync(executablePath)) {
    throw new Error('Extracted Cherry Studio.app is missing its main executable')
  }

  await execFileAsync('/usr/bin/xattr', ['-cr', stagedAppPath]).catch(() => undefined)
  return stagedAppPath
}

export class MacRollingUpdater {
  private downloadedUpdate: {
    signature: string
    archivePath: string
    info: UpdateInfo
  } | null = null

  private activeDownloadPromise: Promise<void> | null = null
  private activeAbortController: AbortController | null = null

  constructor(
    private readonly logger: MacRollingLogger,
    private readonly callbacks: MacRollingCallbacks,
    private readonly fetchFn: FetchLike = (input, init) => net.fetch(input as string, init)
  ) {}

  public getConfig(): MacRollingFeedConfig | null {
    return readMacRollingFeedConfig()
  }

  public isEnabled(): boolean {
    return this.getConfig() !== null
  }

  public hasDownloadedUpdate(): boolean {
    return Boolean(this.downloadedUpdate && existsSync(this.downloadedUpdate.archivePath))
  }

  public abortActiveDownload(): void {
    this.activeAbortController?.abort()
    this.activeAbortController = null
  }

  private buildRequestHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      'Cache-Control': 'no-cache',
      'User-Agent': `CherryStudio/${app.getVersion()} (darwin-${process.arch})`,
      ...extraHeaders
    }
  }

  public async fetchLatestRelease(
    config: MacRollingFeedConfig,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<ResolvedMacRelease> {
    const headers = this.buildRequestHeaders(extraHeaders)
    const downloadBase = `https://github.com/${config.owner}/${config.repo}/releases/download/${encodeURIComponent(config.rollingTag)}`
    const manifestUrl = `${downloadBase}/latest-mac.yml`
    const metaUrl = `${downloadBase}/mac-build-meta.json`
    const apiReleaseUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/releases/tags/${encodeURIComponent(config.rollingTag)}`

    const [rawManifest, buildMeta, apiRelease] = await Promise.all([
      fetchTextOptional(this.fetchFn, manifestUrl, headers, signal),
      fetchJsonOptional<MacBuildMeta>(this.fetchFn, metaUrl, headers, signal),
      fetchJsonOptional<GitHubReleaseResponse>(this.fetchFn, apiReleaseUrl, headers, signal)
    ])

    const manifest = rawManifest ? parseLatestMacManifest(rawManifest) : null
    if (!manifest && !apiRelease) {
      throw new Error(`Unable to fetch macOS release metadata from ${config.owner}/${config.repo}@${config.rollingTag}`)
    }

    const remoteVersion = buildMeta?.version?.trim() || manifest?.version || app.getVersion()
    const remoteCommitSha =
      normalizeCommitSha(buildMeta?.commitSha) ||
      manifest?.commitSha ||
      extractCommitShaFromReleaseBody(apiRelease?.body) ||
      normalizeCommitSha(apiRelease?.target_commitish)

    const asset = selectMacArchiveAsset({
      arch: process.arch,
      owner: config.owner,
      repo: config.repo,
      rollingTag: config.rollingTag,
      manifest,
      apiAssets: apiRelease?.assets
    })

    if (!asset) {
      throw new Error(`No macOS-${process.arch} package found in ${config.rollingTag}`)
    }

    const remoteBuiltAt =
      buildMeta?.builtAt ||
      manifest?.builtAt ||
      asset.updatedAt ||
      manifest?.releaseDate ||
      apiRelease?.published_at ||
      null

    const localVersion = app.getVersion()
    const localBuild = getEmbeddedAppBuildInfo()
    const comparison = evaluateRollingUpdate({
      localVersion,
      localBuild,
      localBundleMtimeMs: getLocalBundleMtimeMs(process.execPath),
      remoteVersion,
      remoteCommitSha,
      remoteBuiltAt
    })

    const shortRemoteSha = remoteCommitSha ? remoteCommitSha.slice(0, 7) : null
    const releaseName =
      buildMeta?.releaseName?.trim() ||
      manifest?.releaseName?.trim() ||
      (shortRemoteSha && remoteVersion === localVersion ? `${remoteVersion} (${shortRemoteSha})` : remoteVersion)

    const releaseNotes = buildRollingReleaseNotes({
      baseNotes: buildMeta?.releaseNotes || manifest?.releaseNotes || apiRelease?.body,
      localVersion,
      remoteVersion,
      remoteCommitSha,
      remoteBuiltAt
    })

    const releaseDate = remoteBuiltAt || new Date().toISOString()
    const updateInfo: UpdateInfo = {
      version: remoteVersion,
      files: manifest?.files ?? [{ url: asset.url, sha512: asset.sha512 ?? '', size: asset.size }],
      path: asset.name,
      sha512: asset.sha512 ?? manifest?.sha512 ?? '',
      releaseName,
      releaseNotes,
      releaseDate
    }

    const signature = [remoteVersion, remoteCommitSha ?? '', asset.sha512 ?? '', asset.url].join('|')
    return {
      updateInfo,
      asset,
      remoteCommitSha,
      remoteBuiltAt,
      signature,
      comparison
    }
  }

  public async checkAndDownload(extraHeaders?: Record<string, string>): Promise<{
    currentVersion: string
    updateInfo: UpdateInfo | null
  }> {
    const config = this.getConfig()
    if (!config) {
      throw new Error('macOS rolling updater is not configured')
    }

    const currentVersion = app.getVersion()
    const resolved = await this.fetchLatestRelease(config, extraHeaders)

    if (!resolved.comparison.isUpdateAvailable) {
      this.downloadedUpdate = null
      this.logger.info('macOS rolling updater: already up to date', {
        reason: resolved.comparison.reason,
        currentVersion,
        remoteVersion: resolved.updateInfo.version,
        remoteCommitSha: resolved.remoteCommitSha
      })
      this.callbacks.onNotAvailable({ isCurrent: resolved.comparison.isCurrent })
      return { currentVersion, updateInfo: resolved.updateInfo }
    }

    if (
      this.downloadedUpdate &&
      this.downloadedUpdate.signature === resolved.signature &&
      existsSync(this.downloadedUpdate.archivePath)
    ) {
      this.logger.info('macOS rolling updater: reusing already downloaded package', {
        archivePath: this.downloadedUpdate.archivePath,
        version: resolved.updateInfo.releaseName ?? resolved.updateInfo.version
      })
      this.callbacks.onAvailable(resolved.updateInfo)
      this.callbacks.onDownloaded(resolved.updateInfo)
      return { currentVersion, updateInfo: resolved.updateInfo }
    }

    this.callbacks.onAvailable(resolved.updateInfo)

    if (!this.activeDownloadPromise) {
      this.activeAbortController = new AbortController()
      const signal = this.activeAbortController.signal
      this.activeDownloadPromise = this.downloadResolvedUpdate(config, resolved, extraHeaders, signal).finally(() => {
        this.activeDownloadPromise = null
        this.activeAbortController = null
      })
    }

    await this.activeDownloadPromise
    return { currentVersion, updateInfo: resolved.updateInfo }
  }

  private getMacCachesDir(): string {
    try {
      const home = app.getPath('home')
      if (home) return join(home, 'Library', 'Caches')
    } catch {
      // Fallback to os.homedir()
    }
    return join(homedir(), 'Library', 'Caches')
  }

  private async downloadResolvedUpdate(
    config: MacRollingFeedConfig,
    resolved: ResolvedMacRelease,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<void> {
    const cacheBase = join(this.getMacCachesDir(), config.updaterCacheDirName)
    const rollingStageDir = join(cacheBase, 'mac-rolling')
    // Clean legacy Squirrel caches + prior rolling downloads before fetching the new archive.
    cleanUpdaterCacheDirectories([
      rollingStageDir,
      join(cacheBase, 'pending'),
      join(cacheBase, 'update.zip'),
      join(cacheBase, 'current.blockmap')
    ])

    const destPath = join(rollingStageDir, basename(resolved.asset.name))
    this.logger.info('macOS rolling updater: downloading update archive', {
      url: resolved.asset.url,
      destPath,
      releaseName: resolved.updateInfo.releaseName
    })

    await downloadAssetWithProgress({
      url: resolved.asset.url,
      destPath,
      expectedSha512: resolved.asset.sha512,
      expectedSize: resolved.asset.size,
      headers: this.buildRequestHeaders(extraHeaders),
      fetchFn: this.fetchFn,
      onProgress: (progress) => this.callbacks.onDownloadProgress(progress),
      signal
    })

    this.downloadedUpdate = {
      signature: resolved.signature,
      archivePath: destPath,
      info: resolved.updateInfo
    }
    this.callbacks.onDownloaded(resolved.updateInfo)
  }

  public async prepareAndSpawnInstaller(onBeforeQuit: () => void): Promise<void> {
    if (!this.downloadedUpdate || !existsSync(this.downloadedUpdate.archivePath)) {
      throw new Error('No downloaded macOS update package is ready to install')
    }
    const config = this.getConfig()
    if (!config) {
      throw new Error('macOS rolling updater configuration missing')
    }

    const stagingRoot = mkdtempSync(join(tmpdir(), 'cherry-studio-update-'))
    try {
      const stagedAppPath = await prepareMacAppStage({
        archivePath: this.downloadedUpdate.archivePath,
        stagingRoot
      })
      const targetAppPath = resolveMacInstallTargetPath(process.execPath)
      const duplicateBundlePaths = findDuplicateAppBundles(targetAppPath)
      const cachesDir = this.getMacCachesDir()
      const cacheDirsToClean = [
        join(cachesDir, config.updaterCacheDirName),
        join(cachesDir, 'com.kangfenmao.CherryStudio.ShipIt')
      ]
      const logPath = join(app.getPath('logs'), 'mac-updater.log')
      const requiresElevation = !isWritableDirectly(targetAppPath)

      const scriptContent = buildMacReplaceScript({
        parentPid: process.pid,
        targetAppPath,
        stagedAppPath,
        stagingRoot,
        duplicateBundlePaths,
        cacheDirsToClean,
        logPath,
        requiresElevation
      })
      const scriptPath = join(stagingRoot, 'apply-update.sh')
      writeFileSync(scriptPath, scriptContent, 'utf8')
      chmodSync(scriptPath, 0o700)

      this.logger.info('macOS rolling updater: launching detached atomic installer', {
        targetAppPath,
        duplicateBundlePaths,
        requiresElevation,
        scriptPath
      })

      const child = spawn('/bin/sh', [scriptPath], {
        detached: true,
        stdio: 'ignore'
      })
      child.unref()

      onBeforeQuit()
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true })
      throw error
    }
  }
}
