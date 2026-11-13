import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { clearCacheMock, rmSyncMock, atomicWriteFileMock, applicationGetPathMock } = vi.hoisted(() => ({
  clearCacheMock: vi.fn(),
  rmSyncMock: vi.fn(),
  atomicWriteFileMock: vi.fn(),
  applicationGetPathMock: vi.fn()
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('node:fs')
  return {
    ...actual,
    rmSync: rmSyncMock
  }
})
vi.mock('@main/utils/file', () => ({ atomicWriteFile: atomicWriteFileMock }))
vi.mock('@application', () => ({
  application: { getPath: applicationGetPathMock }
}))
vi.mock('@main/data/services/ProviderRegistryService', () => ({
  providerRegistryService: { clearCache: clearCacheMock }
}))

import { resolve } from 'node:path'

import { ModelListSchema, ProviderModelListSchema } from '@cherrystudio/provider-registry/node'

import { writeProviderRegistrySnapshot } from '../providerRegistrySnapshot'

const bundledDirectory = resolve('packages/provider-registry/data')
const antigravityOverrides = ProviderModelListSchema.parse(
  JSON.parse(readFileSync(resolve(bundledDirectory, 'provider-models.json'), 'utf-8'))
).overrides.filter((entry) => entry.providerId === 'google-antigravity')
const antigravityModelIds = new Set(antigravityOverrides.map((entry) => entry.modelId))

function bundledModel(id: string) {
  return ModelListSchema.parse(JSON.parse(readFileSync(resolve(bundledDirectory, 'models.json'), 'utf-8'))).models.find(
    (model) => model.id === id
  )
}

describe('writeProviderRegistrySnapshot', () => {
  beforeEach(() => {
    clearCacheMock.mockReset()
    rmSyncMock.mockReset()
    atomicWriteFileMock.mockReset()
    applicationGetPathMock.mockReset()
    applicationGetPathMock.mockImplementation((key: string, filename?: string) =>
      key === 'feature.provider_registry.data' ? resolve(bundledDirectory, filename ?? '') : `/mock/${key}/${filename}`
    )
  })

  it('invalidates the manifest first, writes only remote-safe files, and commits the manifest last', async () => {
    const order: string[] = []
    rmSyncMock.mockImplementation((pathname: string) => order.push(`rm:${basename(pathname)}`))
    atomicWriteFileMock.mockImplementation(async (pathname: string) => order.push(`write:${basename(pathname)}`))

    await writeProviderRegistrySnapshot(
      {
        'models.json': '{"version":"a"}',
        'provider-models.json': '{"version":"b"}'
      },
      '{"revision":2}'
    )

    expect(order).toEqual([
      'rm:manifest.json',
      'write:models.json',
      'write:provider-models.json',
      'write:manifest.json'
    ])
    expect(order).not.toContain('write:providers.json')
    expect(clearCacheMock).toHaveBeenCalledTimes(2)
  })

  it('retains bundled-only Antigravity entries and keeps manifest hashes bound to merged content', async () => {
    const writes = new Map<string, string>()
    atomicWriteFileMock.mockImplementation(async (pathname: string, body: string) => {
      writes.set(basename(pathname), body)
    })

    await writeProviderRegistrySnapshot(
      {
        'models.json': '{"version":"a","models":[]}',
        'provider-models.json': '{"version":"b","overrides":[]}'
      },
      JSON.stringify({ revision: 2, files: { 'models.json': 'a', 'provider-models.json': 'b' } })
    )

    const models = JSON.parse(writes.get('models.json')!).models
    const overrides = JSON.parse(writes.get('provider-models.json')!).overrides
    const manifest = JSON.parse(writes.get('manifest.json')!)
    const bundledModels = ModelListSchema.parse(
      JSON.parse(readFileSync(resolve(bundledDirectory, 'models.json'), 'utf-8'))
    ).models.filter((model) => antigravityModelIds.has(model.id))
    expect(models.map((model: { id: string }) => model.id).sort()).toEqual(
      bundledModels.map((entry) => entry.id).sort()
    )
    expect(models).toHaveLength(antigravityModelIds.size)
    expect(overrides.filter((entry: { providerId: string }) => entry.providerId === 'google-antigravity')).toHaveLength(
      antigravityModelIds.size
    )
    expect(manifest.files['models.json']).toBe(JSON.parse(writes.get('models.json')!).version)
    expect(manifest.files['provider-models.json']).toBe(JSON.parse(writes.get('provider-models.json')!).version)
  })

  it('lets upstream win shared entries and never duplicates bundled-only entries', async () => {
    const writes = new Map<string, string>()
    atomicWriteFileMock.mockImplementation(async (pathname: string, body: string) => {
      writes.set(basename(pathname), body)
    })
    const upstreamModel = { ...bundledModel('claude-opus-5-5'), name: 'Upstream Opus' }
    const upstreamOverride = { ...antigravityOverrides[0], disabled: true }

    await writeProviderRegistrySnapshot(
      {
        'models.json': JSON.stringify({ version: 'a', models: [upstreamModel] }),
        'provider-models.json': JSON.stringify({ version: 'b', overrides: upstreamOverride ? [upstreamOverride] : [] })
      },
      JSON.stringify({ revision: 2, files: {} })
    )

    const models = JSON.parse(writes.get('models.json')!).models
    const overrides = JSON.parse(writes.get('provider-models.json')!).overrides
    expect(models.filter((model: { id: string }) => model.id === 'claude-opus-5-5')).toEqual([
      expect.objectContaining({ name: 'Upstream Opus' })
    ])
    expect(models).toHaveLength(antigravityModelIds.size)
    expect(overrides.filter((entry: { modelId: string }) => entry.modelId === 'claude-opus-5-5')).toEqual([
      expect.objectContaining({ disabled: true })
    ])
    expect(overrides.filter((entry: { providerId: string }) => entry.providerId === 'google-antigravity')).toHaveLength(
      antigravityModelIds.size
    )
  })
})
