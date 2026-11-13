import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { isPiCompatibleModel } from '@shared/ai/piModelCompatibility'
import {
  ANTIGRAVITY_PROVIDER_ID,
  isAntigravityModelId,
  isAntigravityProviderId,
  mapReasoningEffortToAntigravityThoughtLevel,
  resolveAntigravityAcpModel
} from '@shared/data/presets/antigravity'
import type { Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'

describe('antigravity preset & registry', () => {
  it('identifies Google Antigravity provider and model IDs', () => {
    expect(ANTIGRAVITY_PROVIDER_ID).toBe('google-antigravity')
    expect(isAntigravityProviderId('google-antigravity')).toBe(true)
    expect(isAntigravityProviderId('claude-code')).toBe(false)
    expect(isAntigravityModelId('google-antigravity::claude-opus-5-5')).toBe(true)
    expect(isAntigravityModelId('openai-codex::gpt-6.1-sol')).toBe(false)
    expect(isAntigravityModelId(null)).toBe(false)
    expect(isAntigravityModelId(undefined)).toBe(false)
  })

  it('maps canonical model IDs and effort suffixes to official agy acp configOptions', () => {
    expect(resolveAntigravityAcpModel('google-antigravity::claude-opus-5-5')).toEqual({
      model: 'claude-opus-5-5'
    })
    expect(resolveAntigravityAcpModel('google-antigravity::gemini-4-hydrogen')).toEqual({
      model: 'gemini-4-hydrogen'
    })
    expect(resolveAntigravityAcpModel('google-antigravity::gemini-pro-orchestrator-g1-pro')).toEqual({
      model: 'gemini-pro-orchestrator-g1-pro'
    })
    expect(resolveAntigravityAcpModel('google-antigravity::gemini-3-8-flash')).toEqual({
      model: 'gemini-3.8-flash'
    })
    expect(resolveAntigravityAcpModel('google-antigravity::gpt-oss-120b')).toEqual({
      model: 'gpt-oss-120b-medium'
    })
    expect(resolveAntigravityAcpModel('claude-opus-5-5-high')).toEqual({
      model: 'claude-opus-5-5',
      thoughtLevel: 'high'
    })
    expect(resolveAntigravityAcpModel('gemini-4-hydrogen-xhigh')).toEqual({
      model: 'gemini-4-hydrogen',
      thoughtLevel: 'xhigh'
    })
    expect(resolveAntigravityAcpModel('gemini-3.8-flash-low')).toEqual({
      model: 'gemini-3.8-flash',
      thoughtLevel: 'low'
    })
  })

  it('maps Cherry Studio reasoning effort options to agy thought_level', () => {
    expect(mapReasoningEffortToAntigravityThoughtLevel('minimal')).toBe('low')
    expect(mapReasoningEffortToAntigravityThoughtLevel('low')).toBe('low')
    expect(mapReasoningEffortToAntigravityThoughtLevel('medium')).toBe('medium')
    expect(mapReasoningEffortToAntigravityThoughtLevel('auto')).toBe('medium')
    expect(mapReasoningEffortToAntigravityThoughtLevel(undefined)).toBe('medium')
    expect(mapReasoningEffortToAntigravityThoughtLevel('high')).toBe('high')
    expect(mapReasoningEffortToAntigravityThoughtLevel('xhigh')).toBe('xhigh')
    expect(mapReasoningEffortToAntigravityThoughtLevel('max')).toBe('xhigh')
  })

  it('registers google-antigravity as an external-cli provider with all models in provider-registry', () => {
    const dataDir = resolve(process.cwd(), 'packages/provider-registry/data')
    const bundledProviders = JSON.parse(readFileSync(resolve(dataDir, 'providers.json'), 'utf-8')) as {
      providers: Array<Record<string, unknown>>
    }
    const bundledProviderModels = JSON.parse(readFileSync(resolve(dataDir, 'provider-models.json'), 'utf-8')) as {
      overrides: Array<Record<string, unknown>>
    }

    const provider = bundledProviders.providers.find((entry) => entry.id === 'google-antigravity')
    expect(provider).toBeDefined()
    expect(provider?.authMethods).toEqual(['external-cli'])
    expect(provider?.modelListSource).toBe('registry')

    const models = bundledProviderModels.overrides.filter((entry) => entry.providerId === 'google-antigravity')
    expect(models.map((entry) => entry.modelId)).toEqual(
      expect.arrayContaining([
        'claude-opus-5-5',
        'claude-sonnet-5-5',
        'gemini-4-argon',
        'gemini-4-hydrogen',
        'gemini-pro-orchestrator-g1-pro',
        'gemini-3-8-flash',
        'gpt-oss-120b'
      ])
    )
  })

  it('allows google-antigravity models in Pi and Pi Durable model pickers while keeping claude-code excluded', () => {
    const agyProvider = {
      id: 'google-antigravity',
      name: 'Google Antigravity',
      authMethods: ['external-cli']
    } as Provider
    const agyModel = {
      id: 'google-antigravity::claude-opus-5-5',
      providerId: 'google-antigravity',
      name: 'Claude Opus 5.5',
      capabilities: [],
      supportsStreaming: true,
      isEnabled: true,
      isHidden: false
    } as Model
    expect(isPiCompatibleModel(agyProvider, agyModel)).toBe(true)
  })
})
