import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { McpServer } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSessionById: vi.fn(),
  getAgent: vi.fn(),
  ensureAgentDataDirectory: vi.fn(),
  prepareWorkspace: vi.fn(),
  skillList: vi.fn(),
  skillLocalPaths: vi.fn(),
  buildAgentMcpServers: vi.fn(),
  buildAgentRuntimePrompt: vi.fn(),
  resolveLocalAgentLaunch: vi.fn(),
  readAgentSessionPath: vi.fn(),
  ensureClaudeExecutable: vi.fn(),
  getProviderById: vi.fn(),
  getModelByKey: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '2.0.0-test' }
}))

vi.mock('@application', () => ({
  application: {
    getPath: vi.fn(() => os.tmpdir()),
    get: vi.fn((service: string) => {
      if (service === 'PreferenceService') {
        return { get: vi.fn(() => false) }
      }
      if (service === 'McpCatalogService') {
        return { listTools: vi.fn(() => []) }
      }
      if (service === 'DbService') {
        return { getDb: vi.fn(() => ({})) }
      }
      if (service === 'ClaudeCodeBinaryService') {
        return {
          ensureExecutable: mocks.ensureClaudeExecutable,
          getStatus: () => ({ phase: 'missing' })
        }
      }
      if (service === 'ClaudeCodeWarmQueryManager') {
        return { prewarmAgentSession: vi.fn() }
      }
      return {}
    })
  }
}))

vi.mock('@data/services/AgentSessionService', () => ({
  agentSessionService: { getById: mocks.getSessionById }
}))

vi.mock('@data/services/AgentService', () => ({
  agentService: { getAgent: mocks.getAgent }
}))

vi.mock('@data/services/McpServerService', () => ({
  mcpServerService: { findByIdOrName: vi.fn(() => undefined) }
}))

vi.mock('@data/services/ProviderService', () => ({
  providerService: {
    getByProviderId: mocks.getProviderById,
    getApiKeys: vi.fn(() => [])
  }
}))

vi.mock('@data/services/ModelService', () => ({
  modelService: { getByKey: mocks.getModelByKey }
}))

vi.mock('@data/services/agentSessionMessageTree', () => ({
  readAgentSessionPath: mocks.readAgentSessionPath
}))

vi.mock('@main/ai/agents/agentDataDirectory', () => ({
  ensureAgentDataDirectory: mocks.ensureAgentDataDirectory
}))

vi.mock('@main/ai/runtime/agentSessionWorkspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/ai/runtime/agentSessionWorkspace')>()),
  prepareAgentSessionWorkspaceDirectory: mocks.prepareWorkspace
}))

vi.mock('@main/ai/skills/SkillService', () => ({
  skillService: {
    list: mocks.skillList,
    listLocalSkillPaths: mocks.skillLocalPaths
  }
}))

vi.mock('@main/ai/runtime/agentMcpServers', () => ({
  buildAgentMcpServers: mocks.buildAgentMcpServers,
  resolveLinkedNotifyChannel: vi.fn(() => null),
  resolveAgentNotificationContext: vi.fn(() => ({
    sourceChannel: null,
    channels: [],
    allowAnyOwnedChannel: false
  }))
}))

vi.mock('@main/ai/runtime/agentPrompt', () => ({
  buildAgentRuntimePrompt: mocks.buildAgentRuntimePrompt
}))

vi.mock('@main/ai/runtime/citationsGuidance', () => ({
  buildCitationsGuidance: vi.fn(async () => undefined)
}))

vi.mock('@main/ai/mcp/serverInstructions', () => ({
  buildMcpInstructionsContext: vi.fn(() => undefined)
}))

vi.mock('@main/ai/utils/agentLanguage', () => ({
  getEffectiveAgentLanguage: vi.fn(() => 'zh-CN')
}))

vi.mock('@main/ai/runtime/localAgent/launch', () => ({
  resolveLocalAgentLaunch: mocks.resolveLocalAgentLaunch
}))

import { toolApprovalRegistry } from '@main/ai/toolApproval/ToolApprovalRegistry'
import { ClaudeCodeRuntimeDriver } from '@main/ai/runtime/claudeCode/ClaudeCodeRuntimeDriver'
import type { AgentRuntimeEvent, AgentRuntimeUserInput } from '@main/ai/runtime/types'

import {
  ANTIGRAVITY_RESUME_TOKEN_PREFIX,
  connectAntigravityAgentSession
} from '../AntigravityHarnessConnection'

const fixturePath = fileURLToPath(new URL('./fixtures/mockAgyAcp.mjs', import.meta.url))

function makeUserInput(id: string, text: string, extraParts: Array<Record<string, unknown>> = []): AgentRuntimeUserInput {
  return {
    message: {
      id,
      sessionId: 'sess-1',
      role: 'user',
      status: 'success',
      data: {
        parts: [{ type: 'text', text }, ...extraParts] as never
      },
      delivery: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  }
}

async function readWireLog(wireLogPath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(wireLogPath, 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function drainTurnEvents(
  iterator: AsyncIterator<AgentRuntimeEvent>,
  onEvent?: (event: AgentRuntimeEvent) => void
): Promise<AgentRuntimeEvent[]> {
  const collected: AgentRuntimeEvent[] = []
  while (true) {
    const next = await iterator.next()
    if (next.done) break
    collected.push(next.value)
    onEvent?.(next.value)
    if (next.value.type === 'turn-complete' || next.value.type === 'error') break
  }
  return collected
}

describe('AntigravityHarnessConnection', () => {
  let tempRoot: string
  let workspaceDir: string
  let agentDataDir: string
  let skillDir: string
  let wireLogPath: string

  beforeEach(async () => {
    vi.clearAllMocks()
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-harness-conn-'))
    workspaceDir = path.join(tempRoot, 'workspace')
    agentDataDir = path.join(tempRoot, 'agent-data')
    skillDir = path.join(tempRoot, 'skills', 'japan-finance')
    wireLogPath = path.join(tempRoot, 'wire.jsonl')
    await fs.mkdir(workspaceDir, { recursive: true })
    await fs.mkdir(agentDataDir, { recursive: true })
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Japan Finance\n', 'utf8')

    mocks.ensureAgentDataDirectory.mockResolvedValue(agentDataDir)
    mocks.prepareWorkspace.mockResolvedValue(workspaceDir)
    mocks.getSessionById.mockReturnValue({
      id: 'sess-1',
      agentId: 'agent-1',
      name: 'Test Session',
      isNameManuallyEdited: false,
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', name: 'Workspace', path: workspaceDir, type: 'user' },
      orderKey: 'a0',
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    mocks.getAgent.mockReturnValue({
      id: 'agent-1',
      name: 'Cherry 投研小助手',
      type: 'claude-code',
      model: 'google-antigravity::claude-opus-5-5',
      modelName: 'Claude Opus 5.5',
      instructions: 'You are an equity research specialist.',
      mcps: ['fxbaogao'],
      knowledgeBaseIds: [],
      configuration: {
        permission_mode: 'acceptEdits',
        reasoning_effort: 'high'
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    mocks.getProviderById.mockReturnValue({
      id: 'google-antigravity',
      name: 'Google Antigravity',
      type: 'openai',
      apiHost: '',
      apiKey: '',
      isSystem: true,
      isEnabled: true,
      authMethods: ['external-cli']
    })
    mocks.getModelByKey.mockReturnValue({
      id: 'google-antigravity::claude-opus-5-5',
      apiModelId: 'claude-opus-5-5',
      providerId: 'google-antigravity',
      name: 'Claude Opus 5.5',
      capabilities: ['reasoning', 'function_call']
    })
    mocks.skillList.mockResolvedValue([
      {
        id: 'skill-1',
        name: 'japan-finance',
        folderName: 'japan-finance',
        dirPath: skillDir,
        isEnabled: true
      }
    ])
    mocks.skillLocalPaths.mockResolvedValue([])
    mocks.buildAgentMcpServers.mockReturnValue({
      'cherry-tools': {
        name: 'cherry-tools',
        connect: async (transport: Parameters<McpServer['connect']>[0]) => {
          const srv = new McpServer({ name: 'cherry-tools', version: '1.0.0' })
          await srv.connect(transport)
        }
      }
    })
    mocks.buildAgentRuntimePrompt.mockImplementation(async ({ agent }) => ({
      base: { kind: 'default' },
      append: `## Agent Instructions\n${agent.instructions}`
    }))
    mocks.readAgentSessionPath.mockReturnValue([])
    mocks.resolveLocalAgentLaunch.mockResolvedValue({
      executable: process.execPath,
      args: [fixturePath],
      env: { ...process.env, MOCK_AGY_WIRE_LOG: wireLogPath }
    })
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('launches agy acp with bridged MCP servers, staged skills, systemPrompt.append, model, thought_level, and mode', async () => {
    const conn = await connectAntigravityAgentSession({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      modelId: 'google-antigravity::claude-opus-5-5',
      reasoningEffort: 'high'
    })

    try {
      const iter = conn.events[Symbol.asyncIterator]()
      await conn.send(
        makeUserInput('u-1', 'Analyze Acom', [{ type: 'data-knowledge-scope', data: { knowledgeBaseIds: ['kb-1'] } }])
      )
      const events = await drainTurnEvents(iter)

      const resumeEvent = events.find((e) => e.type === 'resume-token')
      expect(resumeEvent).toEqual({
        type: 'resume-token',
        token: `${ANTIGRAVITY_RESUME_TOKEN_PREFIX}native-agy-1`
      })

      const textDeltas = events
        .filter((e): e is Extract<AgentRuntimeEvent, { type: 'chunk' }> => e.type === 'chunk')
        .filter((e) => e.chunk.type === 'text-delta')
        .map((e) => e.chunk.delta)
        .join('')
      expect(textDeltas).toContain('Reply from claude-opus-5-5 (high, accept-edits)')

      const wire = await readWireLog(wireLogPath)
      const sessionNew = wire.find((m) => m.method === 'session/new')
      expect(sessionNew).toBeDefined()
      const params = sessionNew!.params as Record<string, unknown>
      expect(params.cwd).toBe(workspaceDir)
      expect(Array.isArray(params.mcpServers)).toBe(true)
      expect((params.mcpServers as Array<{ name: string }>)[0]?.name).toBe('cherry-tools')
      expect(Array.isArray(params.additionalDirectories)).toBe(true)
      expect((params.additionalDirectories as string[]).length).toBe(1)
      expect(params._meta).toEqual({
        antigravity: {
          systemPrompt: {
            append: '## Agent Instructions\nYou are an equity research specialist.'
          }
        }
      })
    } finally {
      await conn.close()
    }
  })

  it('resumes native agy-acp:<id> tokens and seeds prior transcript history when switching from another provider', async () => {
    // 1. Native agy-acp:<id> token -> session/resume
    const resumed = await connectAntigravityAgentSession({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      modelId: 'google-antigravity::claude-sonnet-5-5',
      reasoningEffort: 'medium',
      resumeToken: `${ANTIGRAVITY_RESUME_TOKEN_PREFIX}existing-session-42`
    })
    await resumed.close()

    let wire = await readWireLog(wireLogPath)
    const resumeMsg = wire.find((m) => m.method === 'session/resume')
    expect(resumeMsg).toBeDefined()
    expect((resumeMsg!.params as { sessionId: string }).sessionId).toBe('existing-session-42')

    // 2. Foreign token (e.g. from OpenAI Codex / Pi) -> session/new + seed prior conversation history once
    await fs.writeFile(wireLogPath, '', 'utf8')
    mocks.readAgentSessionPath.mockReturnValue([
      {
        id: 'u-prev',
        sessionId: 'sess-1',
        role: 'user',
        status: 'success',
        data: { parts: [{ type: 'text', text: 'What is BoJ policy rate?' }] }
      },
      {
        id: 'a-prev',
        sessionId: 'sess-1',
        role: 'assistant',
        status: 'success',
        data: { parts: [{ type: 'text', text: 'The BoJ policy rate is 0.50%.' }] }
      },
      {
        id: 'u-now',
        sessionId: 'sess-1',
        role: 'user',
        status: 'success',
        data: { parts: [{ type: 'text', text: 'Compare that to Acom funding cost.' }] }
      }
    ])

    const switched = await connectAntigravityAgentSession({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      modelId: 'google-antigravity::gemini-4-argon',
      resumeToken: 'pi-codex-foreign-token-99',
      branchHead: 'a-prev'
    })

    try {
      const iter = switched.events[Symbol.asyncIterator]()
      await switched.send(makeUserInput('u-now', 'Compare that to Acom funding cost.'))
      await drainTurnEvents(iter)

      await switched.send(makeUserInput('u-second', 'Follow-up turn'))
      await drainTurnEvents(iter)

      wire = await readWireLog(wireLogPath)
      expect(wire.some((m) => m.method === 'session/resume')).toBe(false)
      const prompts = wire.filter((m) => m.method === 'session/prompt')
      expect(prompts).toHaveLength(2)
      const firstPromptText = ((prompts[0].params as { prompt: Array<{ text?: string }> }).prompt ?? [])
        .map((p) => p.text ?? '')
        .join('\n')
      expect(firstPromptText).toContain('<conversation_history>')
      expect(firstPromptText).toContain('What is BoJ policy rate?')
      expect(firstPromptText).toContain('The BoJ policy rate is 0.50%.')
      expect(firstPromptText).toContain('Compare that to Acom funding cost.')

      const secondPromptText = ((prompts[1].params as { prompt: Array<{ text?: string }> }).prompt ?? [])
        .map((p) => p.text ?? '')
        .join('\n')
      expect(secondPromptText).not.toContain('<conversation_history>')
      expect(secondPromptText).toBe('Follow-up turn')
    } finally {
      await switched.close()
    }
  })

  it('live-patches model and thought_level in reconcile() and requests rebuild when provider or skills change', async () => {
    const conn = await connectAntigravityAgentSession({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      modelId: 'google-antigravity::claude-opus-5-5',
      reasoningEffort: 'high'
    })

    try {
      // Unchanged -> 'current'
      expect(
        await conn.reconcile({
          modelId: 'google-antigravity::claude-opus-5-5',
          reasoningEffort: 'high'
        })
      ).toBe('current')

      // Live change model + reasoningEffort -> 'patched'
      expect(
        await conn.reconcile({
          modelId: 'google-antigravity::gemini-3-8-flash',
          reasoningEffort: 'low'
        })
      ).toBe('patched')

      // Switching away from Google Antigravity -> 'rebuild'
      expect(
        await conn.reconcile({
          modelId: 'openai-codex::gpt-6.1-sol',
          reasoningEffort: 'medium'
        })
      ).toBe('rebuild')

      // Changing agent instructions -> 'rebuild'
      mocks.getAgent.mockReturnValue({
        ...mocks.getAgent(),
        instructions: 'Updated instructions requiring fresh _meta.antigravity.systemPrompt.append'
      })
      expect(
        await conn.reconcile({
          modelId: 'google-antigravity::gemini-3-8-flash',
          reasoningEffort: 'low'
        })
      ).toBe('rebuild')
    } finally {
      await conn.close()
    }
  })

  it('auto-approves edits in acceptEdits mode while prompting for shell execution, and auto-approves all in auto mode', async () => {
    const conn = await connectAntigravityAgentSession({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      modelId: 'google-antigravity::claude-opus-5-5',
      reasoningEffort: 'high'
    })

    try {
      const iter = conn.events[Symbol.asyncIterator]()
      const approvalRequests: string[] = []

      // 1. acceptEdits mode: edit is auto-approved, bash prompts toolApprovalRegistry
      const sendPromise = conn.send(
        makeUserInput('u-perm', 'Run [trigger-edit-permission] and [trigger-bash-permission]')
      )
      await drainTurnEvents(iter, (event) => {
        if (event.type === 'tool-approval-request') {
          approvalRequests.push(event.request.toolName)
          toolApprovalRegistry.dispatch(event.request.approvalId, { approved: true })
        }
      })
      await sendPromise

      expect(approvalRequests).toEqual(['ACP: Run shell command'])

      // 2. Switch agent to permission_mode: 'auto' and reconcile -> bash is also auto-approved!
      mocks.getAgent.mockReturnValue({
        ...mocks.getAgent(),
        configuration: {
          permission_mode: 'auto',
          reasoning_effort: 'high'
        }
      })
      expect(
        await conn.reconcile({
          modelId: 'google-antigravity::claude-opus-5-5',
          reasoningEffort: 'high'
        })
      ).toBe('patched')

      approvalRequests.length = 0
      await conn.send(makeUserInput('u-auto', 'Run [trigger-bash-permission]'))
      await drainTurnEvents(iter, (event) => {
        if (event.type === 'tool-approval-request') {
          approvalRequests.push(event.request.toolName)
        }
      })
      expect(approvalRequests).toEqual([])
    } finally {
      await conn.close()
    }
  })

  it('routes ClaudeCodeRuntimeDriver.validateSession and connect to Antigravity without requiring Claude binary', async () => {
    const driver = new ClaudeCodeRuntimeDriver()
    const session = mocks.getSessionById()

    await driver.validateSession(session)
    expect(mocks.ensureClaudeExecutable).not.toHaveBeenCalled()

    const conn = await driver.connect({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      modelId: 'google-antigravity::claude-opus-5-5',
      reasoningEffort: 'high'
    })
    await conn.close()
    expect(mocks.ensureClaudeExecutable).not.toHaveBeenCalled()
  })
})
