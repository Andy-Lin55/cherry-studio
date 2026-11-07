import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const wireLog = process.env.MOCK_AGY_WIRE_LOG
const record = (entry) => {
  if (wireLog) appendFileSync(wireLog, `${JSON.stringify(entry)}\n`, 'utf8')
}

const emit = (payload) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`)
}

let currentModel = 'gemini-4-argon'
let currentThought = 'medium'
let currentMode = 'default'
let sessionCounter = 0
const pendingClientRequests = new Map()
let nextClientReqId = 1

function requestClient(method, params) {
  return new Promise((resolve) => {
    const id = `agy-client-req-${nextClientReqId++}`
    pendingClientRequests.set(id, resolve)
    emit({ id, method, params })
  })
}

function buildConfigOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: currentModel,
      options: [
        { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
        { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
        { value: 'gemini-3-8-flash', name: 'Gemini 3.8 Flash' },
        { value: 'gpt-oss-120b', name: 'GPT-OSS 120B' }
      ]
    },
    {
      id: 'thought_level',
      name: 'Thinking Level',
      category: 'thought_level',
      type: 'select',
      currentValue: currentThought,
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' }
      ]
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: currentMode,
      options: [
        { value: 'default', name: 'Default' },
        { value: 'accept-edits', name: 'Accept Edits' },
        { value: 'plan', name: 'Plan' }
      ]
    }
  ]
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', async (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  record(msg)

  if (msg.id && !msg.method && pendingClientRequests.has(msg.id)) {
    const resolve = pendingClientRequests.get(msg.id)
    pendingClientRequests.delete(msg.id)
    resolve(msg.result)
    return
  }

  const { id, method, params } = msg
  if (method === 'initialize') {
    emit({
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'antigravity-cli', title: 'Antigravity', version: '1.5.1' },
        authMethods: [{ id: 'google-login', name: 'Sign in with Google' }],
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { resume: {}, close: {} }
        }
      }
    })
    return
  }

  if (method === 'session/new') {
    const sessionId = `native-agy-${++sessionCounter}`
    emit({
      id,
      result: {
        sessionId,
        configOptions: buildConfigOptions()
      }
    })
    return
  }

  if (method === 'session/resume') {
    emit({
      id,
      result: {
        sessionId: params.sessionId,
        configOptions: buildConfigOptions()
      }
    })
    return
  }

  if (method === 'session/set_config_option') {
    if (params.configId === 'model') currentModel = params.value
    if (params.configId === 'thought_level') currentThought = params.value
    if (params.configId === 'mode') currentMode = params.value
    emit({
      id,
      result: {
        configOptions: buildConfigOptions()
      }
    })
    return
  }

  if (method === 'session/close') {
    emit({ id, result: {} })
    return
  }

  if (method === 'session/prompt') {
    const fullText = (params.prompt ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

    if (fullText.includes('[trigger-edit-permission]')) {
      const perm = await requestClient('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'edit-call-1',
          title: 'Edit file.ts',
          kind: 'edit'
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
        ]
      })
      record({ clientPermissionOutcome: perm, kind: 'edit' })
    }

    if (fullText.includes('[trigger-bash-permission]')) {
      const perm = await requestClient('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'bash-call-1',
          title: 'Run shell command',
          kind: 'execute'
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
        ]
      })
      record({ clientPermissionOutcome: perm, kind: 'execute' })
    }

    emit({
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `msg-${Date.now()}`,
          content: {
            type: 'text',
            text: `Reply from ${currentModel} (${currentThought}, ${currentMode})`
          }
        }
      }
    })

    emit({
      id,
      result: {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 42,
          outputTokens: 18,
          thoughtTokens: 10,
          totalTokens: 70
        }
      }
    })
  }
})
