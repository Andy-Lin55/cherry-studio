import { createHash } from 'node:crypto'

import { application } from '@application'
import { agentService } from '@data/services/AgentService'
import { agentSessionMessageService } from '@data/services/AgentSessionMessageService'
import { agentSessionService } from '@data/services/AgentSessionService'
import { readAgentSessionPath } from '@data/services/agentSessionMessageTree'
import { modelService } from '@data/services/ModelService'
import { providerService } from '@data/services/ProviderService'
import { loggerService } from '@logger'
import { ensureAgentDataDirectory } from '@main/ai/agents/agentDataDirectory'
import { resolveAutomationAccess, resolveMountedMcpServers } from '@main/ai/agents/builtin/builtinAgentCapabilities'
import {
  buildAgentMcpServers,
  resolveAgentNotificationContext,
  resolveLinkedNotifyChannel
} from '@main/ai/runtime/agentMcpServers'
import { buildAgentRuntimePrompt } from '@main/ai/runtime/agentPrompt'
import { prepareAgentSessionWorkspaceDirectory } from '@main/ai/runtime/agentSessionWorkspace'
import { buildAgentUserContent } from '@main/ai/runtime/agentUserContent'
import { buildCitationsGuidance } from '@main/ai/runtime/citationsGuidance'
import { resolveLocalAgentLaunch } from '@main/ai/runtime/localAgent/launch'
import { AcpConnection } from '@main/ai/runtime/localAgent/AcpConnection'
import type {
  AgentRuntimeConnectInput,
  AgentRuntimeConnection,
  AgentRuntimeReconcileResult,
  AgentRuntimeUserInput,
  AgentSessionUsageCapture
} from '@main/ai/runtime/types'
import { isAutomationSkillAvailable } from '@main/ai/skills/automationSkills'
import { skillService } from '@main/ai/skills/SkillService'
import type { DispatchDecision } from '@main/ai/toolApproval/ToolApprovalRegistry'
import { getEffectiveAgentLanguage } from '@main/ai/utils/agentLanguage'
import { resolveKnowledgeBaseScope } from '@main/ai/utils/knowledgeScope'
import type { AgentPermissionMode } from '@shared/data/api/schemas/agents'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import {
  ANTIGRAVITY_PROVIDER_ID,
  isAntigravityModelId,
  mapReasoningEffortToAntigravityThoughtLevel,
  resolveAntigravityAcpModel
} from '@shared/data/presets/antigravity'
import type { LocalAgentConfiguration } from '@shared/ai/localAgent'
import type { ReasoningEffortOption } from '@shared/types/aiSdk'
import { parseUniqueModelId, type UniqueModelId } from '@shared/data/types/model'

import { startMcpStdioBridgeHost, type McpStdioBridgeHost } from './mcpStdioBridgeHost'
import { stageAntigravitySkills, type StagedAntigravitySkills } from './stageAntigravitySkills'

const logger = loggerService.withContext('AntigravityHarnessConnection')

export const ANTIGRAVITY_RESUME_TOKEN_PREFIX = 'agy-acp:'

function mapPermissionModeToAgyMode(mode: AgentPermissionMode): string {
  switch (mode) {
    case 'acceptEdits':
    case 'auto':
    case 'bypassPermissions':
      return 'accept-edits'
    case 'plan':
      return 'plan'
    default:
      return 'default'
  }
}

interface AntigravityRebuildSignatureInput {
  workspacePath: string
  skillsFingerprint: string
  mcpFingerprint: string
  systemPromptAppend: string
}

function computeRebuildSignature(input: AntigravityRebuildSignatureInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

export async function validateAntigravityAgentSession(session: AgentSessionEntity): Promise<void> {
  const cwd = session.workspace?.path
  if (!cwd) {
    throw new Error(`Antigravity agent session ${session.id} has no workspace configured`)
  }
  if (!session.agentId) {
    throw new Error(`Antigravity agent session ${session.id} has no agent`)
  }
  await prepareAgentSessionWorkspaceDirectory(session)
  const config: LocalAgentConfiguration = {
    protocol: 'acp',
    presetId: 'antigravity-acp',
    enabled: true,
    args: [],
    env: {}
  }
  await resolveLocalAgentLaunch(config, new AbortController().signal, false)
}

export class AntigravityHarnessConnection extends AcpConnection implements AgentRuntimeConnection {
  private mcpBridge?: McpStdioBridgeHost
  private stagedSkills?: StagedAntigravitySkills
  private rebuildSignature: string
  private permissionMode: AgentPermissionMode = 'default'
  private currentRawModelId: string
  private currentReasoningEffort: ReasoningEffortOption = 'default'
  private conversationHistorySeeded = false
  private pendingHistoryPreamble?: string
  private _usageCapture?: AgentSessionUsageCapture
  private systemPromptAppend?: string

  constructor(
    sessionId: string,
    agentId: string,
    config: LocalAgentConfiguration,
    rawModelId: string,
    reasoningEffort: ReasoningEffortOption,
    rebuildSignature: string,
    permissionMode: AgentPermissionMode,
    pendingHistoryPreamble?: string,
    systemPromptAppend?: string
  ) {
    super(sessionId, agentId, config)
    this.currentRawModelId = rawModelId
    this.currentReasoningEffort = reasoningEffort
    this.rebuildSignature = rebuildSignature
    this.permissionMode = permissionMode
    this.pendingHistoryPreamble = pendingHistoryPreamble
    this.systemPromptAppend = systemPromptAppend
  }

  setBridgeResources(
    mcpBridge: McpStdioBridgeHost,
    stagedSkills: StagedAntigravitySkills,
    usageCapture: AgentSessionUsageCapture
  ): void {
    this.mcpBridge = mcpBridge
    this.stagedSkills = stagedSkills
    this._usageCapture = usageCapture
  }

  get usageCapture(): AgentSessionUsageCapture | undefined {
    return this._usageCapture
  }

  protected override getSessionNewParams(cwd: string): Record<string, unknown> {
    const additionalDirectories = this.stagedSkills?.additionalDirectories ?? []
    return {
      cwd,
      mcpServers: this.mcpBridge?.mcpServers ?? [],
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
      ...(this.systemPromptAppend
        ? {
            _meta: {
              antigravity: {
                systemPrompt: {
                  append: this.systemPromptAppend
                }
              }
            }
          }
        : {})
    }
  }

  protected override getSessionResumeParams(cwd: string, sessionId: string): Record<string, unknown> {
    const additionalDirectories = this.stagedSkills?.additionalDirectories ?? []
    return {
      cwd,
      sessionId,
      mcpServers: this.mcpBridge?.mcpServers ?? [],
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
      ...(this.systemPromptAppend
        ? {
            _meta: {
              antigravity: {
                systemPrompt: {
                  append: this.systemPromptAppend
                }
              }
            }
          }
        : {})
    }
  }

  protected override formatResumeToken(nativeId: string): string {
    return `${ANTIGRAVITY_RESUME_TOKEN_PREFIX}${nativeId}`
  }

  protected override async afterSessionInitialized(): Promise<void> {
    const resolved = resolveAntigravityAcpModel(this.currentRawModelId)
    const targetModel = resolved.model
    const targetThought =
      resolved.thoughtLevel ?? mapReasoningEffortToAntigravityThoughtLevel(this.currentReasoningEffort)
    const targetMode = mapPermissionModeToAgyMode(this.permissionMode)

    const modelOption = this.localSessionInfo.configOptions?.find(
      (opt) => opt.category === 'model' && opt.type === 'select'
    )
    if (modelOption && modelOption.currentValue !== targetModel) {
      await this.setSessionConfigDirect(modelOption.id, targetModel).catch((error) => {
        logger.warn('Failed to set initial Antigravity model', { targetModel, error })
      })
    }

    const thoughtOption = this.localSessionInfo.configOptions?.find(
      (opt) => opt.category === 'thought_level' && opt.type === 'select'
    )
    if (thoughtOption && targetThought && thoughtOption.currentValue !== targetThought) {
      await this.setSessionConfigDirect(thoughtOption.id, targetThought).catch((error) => {
        logger.warn('Failed to set initial Antigravity thought level', { targetThought, error })
      })
    }

    const modeOption = this.localSessionInfo.configOptions?.find(
      (opt) => opt.category === 'mode' && opt.type === 'select'
    )
    if (modeOption && modeOption.currentValue !== targetMode) {
      await this.setSessionConfigDirect(modeOption.id, targetMode).catch((error) => {
        logger.warn('Failed to set initial Antigravity mode', { targetMode, error })
      })
    }
  }

  protected override async approve(
    id: string,
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<DispatchDecision> {
    if (name === 'AskUserQuestion') {
      return super.approve(id, name, input, signal)
    }

    const mode = this.permissionMode
    if (mode === 'bypassPermissions' || mode === 'auto') {
      const toolCall = input.localAcpTool as { title?: string; kind?: string } | undefined
      const options = input.localPermissionOptions as Array<{ optionId: string; kind: string }> | undefined
      const allowOption =
        options?.find((o) => o.kind === 'allow_always') ?? options?.find((o) => o.kind === 'allow_once')
      return {
        approved: true,
        updatedInput: allowOption ? { localPermissionOption: allowOption.optionId } : undefined
      }
    }

    if (mode === 'acceptEdits') {
      const toolCall = input.localAcpTool as { title?: string; kind?: string } | undefined
      const isEdit =
        name === 'ACP: Write' ||
        toolCall?.kind === 'edit' ||
        (toolCall?.title && /edit|write|patch|update/i.test(toolCall.title))
      if (isEdit) {
        const options = input.localPermissionOptions as Array<{ optionId: string; kind: string }> | undefined
        const allowOption =
          options?.find((o) => o.kind === 'allow_once') ?? options?.find((o) => o.kind === 'allow_always')
        return {
          approved: true,
          updatedInput: allowOption ? { localPermissionOption: allowOption.optionId } : undefined
        }
      }
    }

    return super.approve(id, name, input, signal)
  }

  override async send(input: AgentRuntimeUserInput): Promise<void> {
    let effectiveInput = input
    if (this.pendingHistoryPreamble && !this.conversationHistorySeeded) {
      this.conversationHistorySeeded = true
      const preamble = this.pendingHistoryPreamble
      const originalParts = input.message.data?.parts ?? []
      const textPartIndex = originalParts.findIndex((p) => p.type === 'text')
      let newParts: typeof originalParts
      if (textPartIndex >= 0) {
        const originalText = (originalParts[textPartIndex] as { text: string }).text
        newParts = originalParts.map((p, idx) =>
          idx === textPartIndex ? { ...p, text: `${preamble}\n\n${originalText}` } : p
        )
      } else {
        newParts = [{ type: 'text', text: preamble } as never, ...originalParts]
      }
      effectiveInput = {
        ...input,
        message: {
          ...input.message,
          data: {
            ...input.message.data,
            parts: newParts
          }
        }
      }
    }
    return super.send(effectiveInput)
  }

  override async reconcile(input: {
    modelId: string
    reasoningEffort?: ReasoningEffortOption
    knowledgeBaseIds?: readonly string[]
    fastMode?: boolean
  }): Promise<AgentRuntimeReconcileResult> {
    if (this.closed) return 'rebuild'
    if (!isAntigravityModelId(input.modelId)) return 'rebuild'

    const agent = agentService.getAgent(this.agentId)
    const session = agentSessionService.getById(this.sessionId)
    if (!agent || !session) return 'invalid'

    const [skills, workspaceSkillPaths] = await Promise.all([
      skillService.list({ agentId: agent.id }),
      skillService.listLocalSkillPaths(session.workspace.path)
    ])
    const linkedChannel = resolveLinkedNotifyChannel(this.sessionId, agent.id)
    const access = resolveAutomationAccess(agent, {
      channelLinked: linkedChannel !== null,
      browserEnabled: application.get('PreferenceService').get('app.browser.agent_control.enabled'),
      computerUseEnabled: application.get('PreferenceService').get('app.computer_use.agent_control.enabled')
    })
    const enabledSkills = skills.filter((skill) => skill.isEnabled && isAutomationSkillAvailable(skill, access))
    const mountedServers = resolveMountedMcpServers(agent, {
      browserEnabled: application.get('PreferenceService').get('app.browser.agent_control.enabled'),
      computerUseEnabled: application.get('PreferenceService').get('app.computer_use.agent_control.enabled'),
      channelLinked: linkedChannel !== null
    })

    const agentDataPath = await ensureAgentDataDirectory(application.getPath('feature.agents.data'), agent.id)
    const citationsGuidance = buildCitationsGuidance({
      web: mountedServers.has('cherry-tools'),
      kb: resolveKnowledgeBaseScope(agent.knowledgeBaseIds, input.knowledgeBaseIds).length > 0
    })
    const effectiveLanguage = getEffectiveAgentLanguage(agent)
    const prompt = await buildAgentRuntimePrompt({
      workspacePath: session.workspace.path,
      agentDataPath,
      agent,
      citationsGuidance,
      effectiveLanguage
    })

    const freshSignature = computeRebuildSignature({
      workspacePath: session.workspace.path,
      skillsFingerprint: JSON.stringify(enabledSkills.map((s) => ({ id: s.id, path: s.dirPath }))),
      mcpFingerprint: JSON.stringify([...(agent.mcps ?? []), ...mountedServers].sort()),
      systemPromptAppend: prompt.append
    })

    if (freshSignature !== this.rebuildSignature) {
      return 'rebuild'
    }

    let patched = false
    const targetReasoning = input.reasoningEffort ?? agent.configuration?.reasoning_effort ?? 'default'
    const targetPermissionMode = (agent.configuration?.permission_mode ?? 'default') as AgentPermissionMode

    if (this.permissionMode !== targetPermissionMode) {
      this.permissionMode = targetPermissionMode
      const targetMode = mapPermissionModeToAgyMode(targetPermissionMode)
      const modeOption = this.localSessionInfo.configOptions?.find(
        (opt) => opt.category === 'mode' && opt.type === 'select'
      )
      if (modeOption && modeOption.currentValue !== targetMode) {
        await this.setSessionConfigDirect(modeOption.id, targetMode).catch((error) => {
          logger.warn('Failed to patch Antigravity mode', { targetMode, error })
        })
      }
      patched = true
    }

    const resolved = resolveAntigravityAcpModel(input.modelId)
    const targetModel = resolved.model
    const targetThought = resolved.thoughtLevel ?? mapReasoningEffortToAntigravityThoughtLevel(targetReasoning)

    const modelOption = this.localSessionInfo.configOptions?.find(
      (opt) => opt.category === 'model' && opt.type === 'select'
    )
    if (modelOption && modelOption.currentValue !== targetModel) {
      await this.setSessionConfigDirect(modelOption.id, targetModel)
      this.currentRawModelId = input.modelId
      patched = true
    }

    const thoughtOption = this.localSessionInfo.configOptions?.find(
      (opt) => opt.category === 'thought_level' && opt.type === 'select'
    )
    if (thoughtOption && targetThought && thoughtOption.currentValue !== targetThought) {
      await this.setSessionConfigDirect(thoughtOption.id, targetThought)
      this.currentReasoningEffort = targetReasoning
      patched = true
    }

    return patched ? 'patched' : 'current'
  }

  protected override async stop(): Promise<void> {
    try {
      await super.stop()
    } finally {
      await this.mcpBridge?.close().catch((err) => logger.warn('Error closing MCP bridge', { err }))
      await this.stagedSkills?.cleanup().catch((err) => logger.warn('Error cleaning up staged skills', { err }))
    }
  }
}

export async function connectAntigravityAgentSession(
  input: AgentRuntimeConnectInput
): Promise<AntigravityHarnessConnection> {
  const session = agentSessionService.getById(input.sessionId)
  if (!session?.agentId || session.agentId !== input.agentId) {
    throw new Error(`Invalid session or agent: ${input.sessionId}`)
  }
  const agent = agentService.getAgent(input.agentId)
  if (!agent) {
    throw new Error(`Agent not found: ${input.agentId}`)
  }

  const workspacePath = session.workspace.path
  if (!workspacePath) {
    throw new Error(`Session ${session.id} has no workspace path`)
  }
  await prepareAgentSessionWorkspaceDirectory(session)

  const agentDataPath = await ensureAgentDataDirectory(application.getPath('feature.agents.data'), agent.id)

  const [skills, workspaceSkillPaths] = await Promise.all([
    skillService.list({ agentId: agent.id }),
    skillService.listLocalSkillPaths(workspacePath)
  ])

  const linkedChannel = resolveLinkedNotifyChannel(session.id, agent.id)
  const access = resolveAutomationAccess(agent, {
    channelLinked: linkedChannel !== null,
    browserEnabled: application.get('PreferenceService').get('app.browser.agent_control.enabled'),
    computerUseEnabled: application.get('PreferenceService').get('app.computer_use.agent_control.enabled')
  })
  const enabledSkills = skills.filter((skill) => skill.isEnabled && isAutomationSkillAvailable(skill, access))

  const mountedServers = resolveMountedMcpServers(agent, {
    browserEnabled: application.get('PreferenceService').get('app.browser.agent_control.enabled'),
    computerUseEnabled: application.get('PreferenceService').get('app.computer_use.agent_control.enabled'),
    channelLinked: linkedChannel !== null
  })

  const mcpServers = buildAgentMcpServers(
    session,
    agent,
    mountedServers,
    undefined,
    linkedChannel,
    agentDataPath,
    input.knowledgeBaseIds
  )

  const citationsGuidance = buildCitationsGuidance({
    web: mountedServers.has('cherry-tools'),
    kb: resolveKnowledgeBaseScope(agent.knowledgeBaseIds, input.knowledgeBaseIds).length > 0
  })

  const effectiveLanguage = getEffectiveAgentLanguage(agent)
  const prompt = await buildAgentRuntimePrompt({
    workspacePath,
    agentDataPath,
    agent,
    citationsGuidance,
    effectiveLanguage
  })

  const rebuildSignature = computeRebuildSignature({
    workspacePath,
    skillsFingerprint: JSON.stringify(enabledSkills.map((s) => ({ id: s.id, path: s.dirPath }))),
    mcpFingerprint: JSON.stringify([...(agent.mcps ?? []), ...mountedServers].sort()),
    systemPromptAppend: prompt.append
  })

  const stagedSkills = await stageAntigravitySkills({
    agentDataPath,
    sessionId: session.id,
    skills: enabledSkills,
    getSkillDirectory: (name) => {
      const match = enabledSkills.find((s) => s.folderName === name)
      return (match as { dirPath?: string })?.dirPath ?? skillService.getSkillDirectory(name)
    }
  })

  let mcpBridge: McpStdioBridgeHost | undefined
  try {
    mcpBridge = await startMcpStdioBridgeHost(mcpServers)
  } catch (err) {
    await stagedSkills.cleanup()
    throw err
  }

  // Cross-provider resume check & conversation history seeding
  const isAgyResumeToken = input.resumeToken?.startsWith(ANTIGRAVITY_RESUME_TOKEN_PREFIX)
  const nativeResumeId = isAgyResumeToken ? input.resumeToken!.slice(ANTIGRAVITY_RESUME_TOKEN_PREFIX.length) : undefined

  let pendingHistoryPreamble: string | undefined
  if (!isAgyResumeToken) {
    const db = application.get('DbService').getDb()
    const priorRows = readAgentSessionPath(db, session.id, input.branchHead)
    const validPriorMessages = priorRows.filter((r) => r.role === 'user' || r.role === 'assistant')
    if (validPriorMessages.length > 0) {
      const historyLines: string[] = []
      for (const row of validPriorMessages) {
        const text = buildAgentUserContent(row as never).trim()
        if (text) {
          historyLines.push(`${row.role === 'user' ? 'User' : 'Assistant'}: ${text}`)
        }
      }
      if (historyLines.length > 0) {
        pendingHistoryPreamble = [
          '<conversation_history>',
          'The conversation so far before switching to Google Antigravity:',
          ...historyLines,
          '</conversation_history>'
        ].join('\n')
      }
    }
  }

  const rawModelId = input.modelId
  const reasoningEffort = input.reasoningEffort ?? agent.configuration?.reasoning_effort ?? 'default'
  const permissionMode = (agent.configuration?.permission_mode ?? 'default') as AgentPermissionMode

  const config: LocalAgentConfiguration = {
    protocol: 'acp',
    presetId: 'antigravity-acp',
    enabled: true,
    args: [],
    env: {}
  }

  const conn = new AntigravityHarnessConnection(
    session.id,
    agent.id,
    config,
    rawModelId,
    reasoningEffort,
    rebuildSignature,
    permissionMode,
    pendingHistoryPreamble,
    prompt.append
  )

  const resolved = resolveAntigravityAcpModel(rawModelId)
  const usageCapture: AgentSessionUsageCapture = {
    owner: 'agent-sdk',
    credentialReceipt: { attribution: 'auth', method: 'external-cli' },
    providerId: ANTIGRAVITY_PROVIDER_ID,
    providerName: 'Google Antigravity',
    source: null,
    frozenModels: [
      {
        modelId: rawModelId,
        apiModelId: resolved.model,
        modelName: agent.modelName ?? resolved.model,
        aliases: [],
        pricingSnapshot: null
      }
    ]
  }

  conn.setBridgeResources(mcpBridge, stagedSkills, usageCapture)

  try {
    await conn.start(workspacePath, nativeResumeId)
    return conn
  } catch (err) {
    await conn.close().catch(() => {})
    throw err
  }
}
