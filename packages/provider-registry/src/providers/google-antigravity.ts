import type { ReasoningEffort } from '../schemas/enums'
import type { ProviderModelOverride } from '../schemas/provider-models'
import { defineProvider } from './types'

function antigravityReasoning(
  values: readonly ReasoningEffort[],
  defaultEffort: ReasoningEffort
): ProviderModelOverride['reasoningContracts'] {
  return {
    'openai-chat-completions': {
      support: { controls: [{ kind: 'effort', values: [...values], default: defaultEffort }], defaultEffort }
    }
  }
}

/**
 * Agent-only login provider that delegates execution to the official Google
 * Antigravity CLI (`agy acp` over JSON-RPC 2.0 stdio, `authMethods: ['external-cli']`).
 * Carries no API key; model list is served from this registry (`modelListSource: 'registry'`).
 * Runtime harness lives in `src/main/ai/runtime/antigravity/`.
 */
export default defineProvider({
  id: 'google-antigravity',
  name: 'Google Antigravity',
  availableInEditions: ['global'],
  defaultChatEndpoint: 'openai-chat-completions',
  modelListSource: 'registry',
  authMethods: ['external-cli'],
  endpointConfigs: {
    'openai-chat-completions': {
      adapterFamily: 'openai-compatible',
      baseUrl: 'https://antigravity.google'
    }
  },
  metadata: {
    website: {
      official: 'https://antigravity.google',
      docs: 'https://antigravity.google/docs/ide/extensions'
    }
  },
  overrides: [
    {
      modelId: 'claude-opus-5-5',
      apiModelId: 'claude-opus-5-5',
      reasoningContracts: antigravityReasoning(['low', 'medium', 'high'], 'medium')
    },
    {
      modelId: 'claude-sonnet-5-5',
      apiModelId: 'claude-sonnet-5-5',
      reasoningContracts: antigravityReasoning(['low', 'medium', 'high'], 'medium')
    },
    {
      modelId: 'gemini-4-argon',
      apiModelId: 'gemini-4-argon',
      reasoningContracts: antigravityReasoning(['low', 'medium', 'high'], 'medium')
    },
    {
      modelId: 'gemini-3-8-flash',
      apiModelId: 'gemini-3.8-flash',
      reasoningContracts: antigravityReasoning(['low', 'medium', 'high'], 'medium')
    },
    {
      modelId: 'gpt-oss-120b',
      apiModelId: 'gpt-oss-120b-medium',
      reasoningContracts: antigravityReasoning(['medium'], 'medium')
    }
  ]
})
