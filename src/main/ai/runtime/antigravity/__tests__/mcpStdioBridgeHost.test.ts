import net from 'node:net'

import { Client } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import type { AgentMcpServer } from '@main/ai/runtime/agentMcpServers'

import { startMcpStdioBridgeHost } from '../mcpStdioBridgeHost'

function createMathAgentServer(): AgentMcpServer {
  return {
    name: 'math',
    connect: async (transport) =>
      serveStdio(() => {
        const server = new McpServer({ name: 'math', version: '1.0.0' }, { capabilities: { tools: {} } })
        server.registerTool(
          'add_numbers',
          {
            description: 'Add two numbers',
            inputSchema: { a: z.number(), b: z.number() }
          },
          async ({ a, b }) => ({
            content: [{ type: 'text', text: String(a + b) }]
          })
        )
        return server
      }, { transport })
  }
}

describe('startMcpStdioBridgeHost', () => {
  it('bridges an in-memory AgentMcpServer over real stdio child process + loopback TCP', async () => {
    const bridge = await startMcpStdioBridgeHost({ math: createMathAgentServer() })
    try {
      expect(bridge.mcpServers).toHaveLength(1)
      const [descriptor] = bridge.mcpServers
      expect(descriptor.name).toBe('math')
      expect(descriptor.command).toBe(process.execPath)

      const envRecord = {
        ...getDefaultEnvironment(),
        ...Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value]))
      }
      const transport = new StdioClientTransport({
        command: descriptor.command,
        args: descriptor.args,
        env: envRecord,
        stderr: 'pipe'
      })
      const client = new Client({ name: 'bridge-test-client', version: '1.0.0' })
      await client.connect(transport)
      try {
        const tools = await client.listTools()
        expect(tools.tools.map((tool) => tool.name)).toEqual(['add_numbers'])

        const result = await client.callTool({ name: 'add_numbers', arguments: { a: 19, b: 23 } })
        expect(result.content).toEqual([{ type: 'text', text: '42' }])
      } finally {
        await client.close()
      }
    } finally {
      await bridge.close()
    }
  })

  it('rejects unauthenticated loopback TCP connections', async () => {
    const bridge = await startMcpStdioBridgeHost({ math: createMathAgentServer() })
    try {
      const portEntry = bridge.mcpServers[0].env.find((entry) => entry.name === 'CHERRY_MCP_BRIDGE_PORT')
      expect(portEntry).toBeDefined()
      const port = Number(portEntry!.value)

      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
          socket.write(`${JSON.stringify({ token: 'wrong-token', server: 'math' })}\n`)
        })
        socket.on('close', () => resolve())
        socket.on('error', () => resolve())
        setTimeout(() => {
          socket.destroy()
          reject(new Error('Expected socket to be closed by bridge on invalid token'))
        }, 3000)
      })
    } finally {
      await bridge.close()
    }
  })

  it('returns an empty server list without opening a TCP listener when no servers are passed', async () => {
    const bridge = await startMcpStdioBridgeHost({})
    expect(bridge.mcpServers).toEqual([])
    await expect(bridge.close()).resolves.toBeUndefined()
  })
})
