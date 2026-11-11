import { isAntigravityResumeToken } from '@shared/data/presets/antigravity'

/**
 * Returns true if a resume token is compatible with Claude Code CLI.
 * Tokens from foreign runtimes (such as Google Antigravity ACP) cannot be resumed
 * by Claude Code and must trigger a fresh session.
 */
export function isCompatibleClaudeCodeResumeToken(token?: string | null): token is string {
  if (!token || typeof token !== 'string') return false
  if (isAntigravityResumeToken(token)) return false
  if (token.includes(':')) return false
  return true
}
