import { agentService } from '@data/services/AgentService'
import { PI_TOOL_RECALL_TOOL_NAME } from '@shared/ai/piBuiltinTools'
import { isAntigravityModelId } from '@shared/data/presets/antigravity'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'

import {
  connectAntigravityAgentSession,
  validateAntigravityAgentSession
} from '../antigravity'
import { prepareAgentSessionWorkspaceDirectory } from '../agentSessionWorkspace'
import { listPiAvailableTools } from '../pi/PiRuntimeDriver'
import type { AgentRuntimeConnectInput, AgentSessionRuntimeDriver } from '../types'
import { PiDurableRuntimeConnection } from './PiDurableRuntimeConnection'

export class PiDurableRuntimeDriver implements AgentSessionRuntimeDriver {
  readonly type = 'pi-durable'
  readonly capabilities = ['agent-session'] as const

  async validateSession(session: AgentSessionEntity): Promise<void> {
    const agent = session.agentId ? agentService.getAgent(session.agentId) : undefined
    if (agent?.model && isAntigravityModelId(agent.model)) {
      await validateAntigravityAgentSession(session)
      return
    }
    if (!session.agentId || !session.workspace.path || !agent?.model)
      throw new Error('Pi Durable requires an agent, workspace and model')
    await prepareAgentSessionWorkspaceDirectory(session)
  }

  async listAvailableTools(mcpIds: string[]) {
    return (await listPiAvailableTools(mcpIds)).filter((tool) => tool.id !== PI_TOOL_RECALL_TOOL_NAME)
  }

  connect(input: AgentRuntimeConnectInput) {
    if (isAntigravityModelId(input.modelId)) {
      return connectAntigravityAgentSession(input)
    }
    return new PiDurableRuntimeConnection(input).start()
  }
}
