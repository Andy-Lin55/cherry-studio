export type AppBuildInfo = {
  version: string
  commitSha: string | null
  shortSha: string | null
  builtAt: string | null
}

declare const __APP_BUILD_INFO__: AppBuildInfo | null | undefined

/**
 * Return build metadata embedded at bundle time by `electron.vite.config.ts`,
 * or `null` when executing outside Vite (e.g. direct unit tests).
 */
export function getEmbeddedAppBuildInfo(): AppBuildInfo | null {
  const embedded = typeof __APP_BUILD_INFO__ !== 'undefined' ? __APP_BUILD_INFO__ : null
  if (embedded && typeof embedded === 'object') {
    return embedded
  }
  const globalRecord = globalThis as { __APP_BUILD_INFO__?: AppBuildInfo | null }
  if (globalRecord.__APP_BUILD_INFO__ && typeof globalRecord.__APP_BUILD_INFO__ === 'object') {
    return globalRecord.__APP_BUILD_INFO__
  }
  return null
}

/**
 * Format update version for UI display, preserving build identifiers such as
 * `2.1.10 (cb03312)` on rolling releases without mutating `info.version`.
 */
export function formatUpdateVersionDisplay(info: { version: string; releaseName?: string | null }): string {
  const releaseName = info.releaseName?.trim()
  if (releaseName && releaseName !== info.version) {
    return releaseName
  }
  return info.version
}
