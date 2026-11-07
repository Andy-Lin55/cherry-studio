import { Check, CheckCircle2, CircleAlert, Copy, Download, LogIn, RefreshCw, TerminalSquare, X } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import type { LocalAgentCheckResult, LocalAgentConfiguration } from '@shared/ai/localAgent'

import { useCopyToClipboard } from '../hooks/useCopyToClipboard'
import { ProviderHelpLink } from '../primitives/ProviderSettingsPrimitives'

const EXTENSIONS_POLICY_URL = 'https://antigravity.google/docs/ide/extensions'
const LOGIN_COMMAND = 'agy acp --login'

const ANTIGRAVITY_LOCAL_CONFIG: LocalAgentConfiguration = {
  protocol: 'acp',
  presetId: 'antigravity-acp',
  enabled: true,
  args: [],
  env: {}
}

const logger = loggerService.withContext('AntigravitySettings')

interface AntigravitySettingsProps {
  providerId: string
}

const AntigravitySettings: FC<AntigravitySettingsProps> = ({ providerId }) => {
  const { t } = useTranslation()
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [checkResult, setCheckResult] = useState<LocalAgentCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [launching, setLaunching] = useState(false)
  const authRequestIdRef = useRef<string | null>(null)
  const [commandCopied, copyCommand] = useCopyToClipboard()

  const checkStatus = useCallback(async () => {
    setChecking(true)
    try {
      const [cliCheck, isSignedIn] = await Promise.all([
        ipcApi.request('ai.local_agents.check', ANTIGRAVITY_LOCAL_CONFIG).catch(() => null),
        ipcApi.request('oauth.check_external_login', { providerId }).catch(() => false)
      ])
      setCheckResult(cliCheck)
      setLoggedIn(isSignedIn)
    } catch (error) {
      logger.error('Failed to check Google Antigravity CLI status', error as Error)
      setLoggedIn(false)
    } finally {
      setChecking(false)
    }
  }, [providerId])

  useEffect(() => {
    void checkStatus()
    return () => {
      if (authRequestIdRef.current) {
        void ipcApi.request('ai.local_agents.cancel_auth', { requestId: authRequestIdRef.current }).catch(() => {})
      }
    }
  }, [checkStatus])

  const handleSignIn = useCallback(async () => {
    const requestId = crypto.randomUUID()
    authRequestIdRef.current = requestId
    setSigningIn(true)
    try {
      const methodId = checkResult?.protocolInfo?.authMethods?.[0]?.id ?? 'oauth-personal'
      await ipcApi.request('ai.local_agents.authenticate', {
        requestId,
        config: ANTIGRAVITY_LOCAL_CONFIG,
        methodId
      })
      await checkStatus()
    } catch (error) {
      logger.error('Failed to sign in to Google Antigravity CLI', error as Error)
      toast.error(t('settings.provider.antigravity.sign_in_failed'))
    } finally {
      if (authRequestIdRef.current === requestId) {
        authRequestIdRef.current = null
      }
      setSigningIn(false)
    }
  }, [checkResult?.protocolInfo?.authMethods, checkStatus, t])

  const handleCancelSignIn = useCallback(async () => {
    const requestId = authRequestIdRef.current
    if (!requestId) return
    await ipcApi.request('ai.local_agents.cancel_auth', { requestId }).catch(() => {})
  }, [])

  const handleInstallCli = useCallback(async () => {
    setInstalling(true)
    try {
      const result = await ipcApi.request('ai.local_agents.install', { presetId: 'antigravity-acp' })
      if (!result.ok) {
        toast.error(result.detail ?? t('settings.provider.antigravity.install_failed'))
      }
      await checkStatus()
    } catch (error) {
      logger.error('Failed to install Google Antigravity CLI', error as Error)
      toast.error(t('settings.provider.antigravity.install_failed'))
    } finally {
      setInstalling(false)
    }
  }, [checkStatus, t])

  const handleOpenTerminal = useCallback(async () => {
    setLaunching(true)
    try {
      const result = await ipcApi.request('ai.local_agents.open_terminal', {
        ...ANTIGRAVITY_LOCAL_CONFIG,
        login: true
      })
      if (!result.success) {
        logger.error('Failed to launch Antigravity login terminal', { message: result.message })
        toast.error(t('settings.provider.antigravity.launch_failed'))
      }
    } catch (error) {
      logger.error('Failed to launch Antigravity login terminal', error as Error)
      toast.error(t('settings.provider.antigravity.launch_failed'))
    } finally {
      setLaunching(false)
    }
  }, [t])

  if (loggedIn === null) {
    return (
      <div className="flex items-center gap-2 text-xs text-foreground-tertiary">
        <RefreshCw className="size-4 animate-spin" aria-hidden />
        {t('common.loading')}
      </div>
    )
  }

  const agentOnlyNote = (
    <div className="mt-1 text-xs">
      {t('settings.provider.antigravity.agent_only_note')}{' '}
      <ProviderHelpLink className="mx-0" href={EXTENSIONS_POLICY_URL} target="_blank" rel="noreferrer">
        {t('settings.provider.antigravity.policy_link')}
      </ProviderHelpLink>
    </div>
  )

  const cliNotInstalled = checkResult?.status === 'not-installed'

  return (
    <div className="flex flex-col gap-3">
      {loggedIn ? (
        <div className="flex items-center gap-3 rounded-lg border border-success-border bg-success-subtle p-3 text-success-subtle-foreground">
          <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-sm">{t('settings.provider.antigravity.logged_in')}</div>
            <div className="mt-1 text-xs">
              {t('settings.provider.antigravity.logged_in_detail')}
              {checkResult && 'version' in checkResult && checkResult.version ? ` (${checkResult.version})` : ''}
            </div>
            {agentOnlyNote}
          </div>
          <Button variant="secondary" size="sm" disabled={checking} onClick={() => void checkStatus()}>
            <RefreshCw className="size-4" />
            {t('settings.provider.antigravity.recheck')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-info-border bg-info-subtle p-3 text-info-subtle-foreground">
          <div className="flex gap-3">
            <CircleAlert className="mt-0.5 size-5 shrink-0 text-info" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-sm">{t('settings.provider.antigravity.description')}</div>
              <div className="mt-1 text-xs">{t('settings.provider.antigravity.description_detail')}</div>
              {agentOnlyNote}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {cliNotInstalled ? (
              <Button disabled={installing} onClick={() => void handleInstallCli()}>
                <Download className="size-4" />
                {t('settings.provider.antigravity.install_cli')}
              </Button>
            ) : signingIn ? (
              <>
                <Button disabled>
                  <RefreshCw className="size-4 animate-spin" />
                  {t('settings.provider.antigravity.signing_in')}
                </Button>
                <Button variant="secondary" onClick={() => void handleCancelSignIn()}>
                  <X className="size-4" />
                  {t('common.cancel')}
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => void handleSignIn()}>
                  <LogIn className="size-4" />
                  {t('settings.provider.antigravity.sign_in_button')}
                </Button>
                <Button variant="secondary" disabled={launching} onClick={() => void handleOpenTerminal()}>
                  <TerminalSquare className="size-4" />
                  {t('settings.provider.antigravity.open_terminal')}
                </Button>
                <Button variant="secondary" onClick={() => void copyCommand(LOGIN_COMMAND)}>
                  {commandCopied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                  <code className="font-mono">{LOGIN_COMMAND}</code>
                </Button>
              </>
            )}
            <Button variant="secondary" disabled={checking || signingIn} onClick={() => void checkStatus()}>
              <RefreshCw className="size-4" />
              {t('settings.provider.antigravity.recheck')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export default AntigravitySettings
