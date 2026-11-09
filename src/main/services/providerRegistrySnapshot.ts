import { rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { application } from '@application'
import {
  ModelListSchema,
  ProviderModelListSchema,
  REMOTE_REGISTRY_FILES,
  type RemoteRegistryFileName
} from '@cherrystudio/provider-registry/node'
import { providerRegistryService } from '@main/data/services/ProviderRegistryService'
import { OVERRIDE_MANIFEST } from '@main/data/services/utils/registryDataPaths'
import { atomicWriteFile } from '@main/utils/file'
import { AbsoluteFilePathSchema } from '@shared/types/file'

// Keep this in sync with catalog generation so manifest hashes remain content hashes.
import { stampAndSerialize } from '../../../packages/provider-registry/scripts/catalogSerialization.mjs'

/** The upstream snapshot is a base; provider IDs absent upstream stay owned by this build. */
const BUNDLED_ONLY_PROVIDER_IDS = new Set(['google-antigravity'])

export async function mergeBundledOnlyCatalogEntries(
  files: Record<RemoteRegistryFileName, string>
): Promise<{ files: Record<RemoteRegistryFileName, string>; versions: Record<RemoteRegistryFileName, string> }> {
  const merged = {} as Record<RemoteRegistryFileName, string>
  const versions = {} as Record<RemoteRegistryFileName, string>
  const bundledProviderModels = JSON.parse(
    await readFile(application.getPath('feature.provider_registry.data', 'provider-models.json'), 'utf-8')
  ) as { overrides: Array<{ providerId: string; modelId: string }> }
  const bundledOnlyModelIds = new Set(
    bundledProviderModels.overrides
      .filter((entry) => BUNDLED_ONLY_PROVIDER_IDS.has(entry.providerId))
      .map((entry) => entry.modelId)
  )

  for (const file of REMOTE_REGISTRY_FILES) {
    type CatalogDocument = {
      version?: string
      models?: Array<Record<string, unknown>>
      overrides?: Array<Record<string, unknown>>
    }
    const collection = file === 'models.json' ? 'models' : 'overrides'
    const remote = JSON.parse(files[file]) as CatalogDocument
    const bundled = JSON.parse(
      await readFile(application.getPath('feature.provider_registry.data', file), 'utf-8')
    ) as CatalogDocument
    const key = (entry: Record<string, unknown>) =>
      file === 'models.json' ? String(entry.id) : `${entry.providerId}:${entry.modelId}`
    const entries = new Map((remote[collection] ?? []).map((entry) => [key(entry), entry]))
    for (const entry of bundled[collection] ?? []) {
      const isBundledOnly =
        file === 'models.json'
          ? bundledOnlyModelIds.has(String(entry.id))
          : BUNDLED_ONLY_PROVIDER_IDS.has(String(entry.providerId))
      if (isBundledOnly && !entries.has(key(entry))) entries.set(key(entry), entry)
    }

    const body: CatalogDocument = { ...remote, [collection]: [...entries.values()] }
    delete body.version
    const serialized = stampAndSerialize(body)
    // Stamp only after the merge; the updater's remote-only manifest hash no longer applies.
    const document = (file === 'models.json' ? ModelListSchema : ProviderModelListSchema).parse(JSON.parse(serialized))
    merged[file] = serialized
    versions[file] = document.version
  }

  return { files: merged, versions }
}

/** Persist one complete remote-safe model snapshot and activate it atomically. */
export async function writeProviderRegistrySnapshot(
  files: Record<RemoteRegistryFileName, string>,
  manifestBody: string
): Promise<void> {
  const directory = 'feature.provider_registry.override' as const

  rmSync(application.getPath(directory, OVERRIDE_MANIFEST), { force: true })
  providerRegistryService.clearCache()

  const merged = await mergeBundledOnlyCatalogEntries(files)
  const manifest = JSON.parse(manifestBody) as { files?: Record<string, string> }
  for (const [name, version] of Object.entries(merged.versions)) {
    if (manifest.files) manifest.files[name] = version
  }
  for (const [name, body] of Object.entries(merged.files)) {
    await atomicWriteFile(AbsoluteFilePathSchema.parse(application.getPath(directory, name)), body)
  }
  await atomicWriteFile(
    AbsoluteFilePathSchema.parse(application.getPath(directory, OVERRIDE_MANIFEST)),
    JSON.stringify(manifest)
  )
  providerRegistryService.clearCache()
}
