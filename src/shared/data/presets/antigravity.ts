/**
 * The "Google Antigravity" provider lets Cherry Studio Agents run against the
 * user's official Google Antigravity CLI (`agy`) login (Google AI Pro / Ultra /
 * One subscription) via the official Agent Client Protocol (`agy acp` over
 * JSON-RPC 2.0 stdio).
 *
 * Like `claude-code`, it uses `authMethods: ['external-cli']` and
 * `modelListSource: 'registry'`, carrying no API key and delegating all OAuth
 * credentials and upstream traffic strictly to the official `agy` binary.
 */
export const ANTIGRAVITY_PROVIDER_ID = 'google-antigravity' as const

export type AntigravityThoughtLevel = 'low' | 'medium' | 'high'

export interface ResolvedAntigravityAcpModel {
  model: string
  thoughtLevel?: AntigravityThoughtLevel
}

const CANONICAL_TO_ACP_MODEL: Record<string, string> = {
  'claude-opus-5-5': 'claude-opus-5-5',
  'claude-sonnet-5-5': 'claude-sonnet-5-5',
  'gemini-4-argon': 'gemini-4-argon',
  'gemini-3-8-flash': 'gemini-3.8-flash',
  'gemini-3.8-flash': 'gemini-3.8-flash',
  'gpt-oss-120b': 'gpt-oss-120b-medium',
  'gpt-oss-120b-medium': 'gpt-oss-120b-medium'
}

/** True for the canonical, login-based Google Antigravity CLI provider. */
export function isAntigravityProviderId(providerId: string | null | undefined): boolean {
  return providerId === ANTIGRAVITY_PROVIDER_ID
}

/** True when a unique model ID (`providerId::modelId`) targets Google Antigravity. */
export function isAntigravityModelId(modelId: string | null | undefined): boolean {
  if (!modelId) return false
  return modelId.startsWith(`${ANTIGRAVITY_PROVIDER_ID}::`)
}

/**
 * Normalize either a Cherry unique model ID (`google-antigravity::gemini-3-8-flash`),
 * a canonical model ID (`gpt-oss-120b`), or a legacy effort-suffixed ACP model ID
 * (`claude-opus-5-5-high`) into `agy acp`'s `configOptions` `model` + optional `thought_level`.
 */
export function resolveAntigravityAcpModel(modelId: string): ResolvedAntigravityAcpModel {
  const separatorIndex = modelId.indexOf('::')
  const raw = (separatorIndex >= 0 ? modelId.slice(separatorIndex + 2) : modelId).trim()

  if (raw in CANONICAL_TO_ACP_MODEL) {
    return { model: CANONICAL_TO_ACP_MODEL[raw] }
  }

  const effortMatch = /^(.*)-(low|medium|high)$/.exec(raw)
  if (effortMatch) {
    const [, baseCandidate, effort] = effortMatch
    const mappedBase = CANONICAL_TO_ACP_MODEL[baseCandidate] ?? baseCandidate
    return {
      model: mappedBase,
      thoughtLevel: effort as AntigravityThoughtLevel
    }
  }

  return { model: raw }
}

/** Map Cherry Studio reasoning effort values to `agy acp` `thought_level` (`low` | `medium` | `high`). */
export function mapReasoningEffortToAntigravityThoughtLevel(effort?: string | null): AntigravityThoughtLevel {
  switch (effort) {
    case 'minimal':
    case 'low':
      return 'low'
    case 'high':
    case 'xhigh':
    case 'max':
    case 'ultra':
      return 'high'
    case 'medium':
    case 'auto':
    case 'none':
    default:
      return 'medium'
  }
}
