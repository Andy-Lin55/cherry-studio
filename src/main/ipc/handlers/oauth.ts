import { application } from '@application'
import { listLocalAgentModels } from '@main/ai/runtime/localAgent/LocalRuntimeDriver'
import { authorizeTokenDanceApiKey } from '@main/services/tokenDanceOAuth'
import { isAntigravityProviderId } from '@shared/data/presets/antigravity'
import { isClaudeCodeProviderId } from '@shared/data/presets/claudeCode'
import type { oauthRequestSchemas } from '@shared/ipc/schemas/oauth'
import type { IpcHandlersFor } from '@shared/ipc/types'

import { mapOAuthSignInCancellation, runOAuthSignIn } from './oauthSignIn'

const runtime = () => application.get('OAuthRuntimeService')

export const oauthHandlers: IpcHandlersFor<typeof oauthRequestSchemas> = {
  'oauth.sign_in': async ({ providerId, requestId }, ctx) => {
    const { accountId } = await runOAuthSignIn(ctx.senderId, providerId, requestId)
    return { accountId }
  },
  'oauth.sign_in.attach': ({ providerId, requestId }, ctx) =>
    mapOAuthSignInCancellation(runtime().joinActiveSignIn(ctx.senderId, providerId, requestId)),
  'oauth.cancel_sign_in': ({ providerId, requestId }, ctx) =>
    runtime().cancelSignIn(ctx.senderId, providerId, requestId),
  'oauth.has_token': ({ providerId }) => runtime().hasToken(providerId),
  'oauth.get_account': ({ providerId }) => runtime().getAccount(providerId),
  'oauth.logout': ({ providerId }) => runtime().logout(providerId),
  'oauth.tokendance.authorize_api_key': () => authorizeTokenDanceApiKey(),
  // External-CLI login probes (`claude-code` and `google-antigravity`).
  // Reject anything else rather than silently returning another CLI's probe.
  'oauth.check_external_login': ({ providerId }) => {
    if (isClaudeCodeProviderId(providerId)) {
      return application.get('CodeCliService').checkClaudeLogin()
    }
    if (isAntigravityProviderId(providerId)) {
      return listLocalAgentModels({
        protocol: 'acp',
        presetId: 'antigravity-acp',
        enabled: true,
        args: [],
        env: {}
      }).then(
        (catalog) => Boolean(catalog.models && catalog.models.length > 0),
        () => false
      )
    }
    throw new Error(`Unsupported external-cli provider: ${providerId}`)
  }
}
