import { randomBytes, timingSafeEqual } from 'node:crypto'
import net from 'node:net'
import { PassThrough } from 'node:stream'

import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

import { loggerService } from '@logger'
import type { AgentMcpServer } from '@main/ai/runtime/agentMcpServers'

const logger = loggerService.withContext('AntigravityMcpBridge')

const MAX_HANDSHAKE_BYTES = 4096
const HANDSHAKE_TIMEOUT_MS = 5000

const STDIO_TCP_RELAY_SCRIPT = [
  "const net = require('node:net');",
  "const port = Number(process.env.CHERRY_MCP_BRIDGE_PORT);",
  "const token = process.env.CHERRY_MCP_BRIDGE_TOKEN || '';",
  "const server = process.env.CHERRY_MCP_BRIDGE_SERVER || '';",
  "const socket = net.connect({ host: '127.0.0.1', port }, () => {",
  "  socket.write(JSON.stringify({ token, server }) + '\\n');",
  '  process.stdin.pipe(socket);',
  '});',
  'socket.pipe(process.stdout);',
  'socket.on("error", () => process.exit(1));',
  'socket.on("close", () => process.exit(0));',
  'process.stdin.on("end", () => socket.end());'
].join('\n')

export interface McpStdioBridgeHandle {
  mcpServers: McpServerStdio[]
  close(): Promise<void>
}

function tokensMatch(expectedHex: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate.length !== expectedHex.length) {
    return false
  }
  return timingSafeEqual(Buffer.from(expectedHex, 'utf8'), Buffer.from(candidate, 'utf8'))
}

/**
 * Expose Cherry Studio's in-process `AgentMcpServer` instances (user MCPs,
 * `cherry-tools`, `skills`, `agent-memory`, `automation`, etc.) as ACP
 * `McpServerStdio` entries backed by an authenticated `127.0.0.1` loopback listener.
 */
export async function startMcpStdioBridgeHost(
  servers: Record<string, AgentMcpServer>
): Promise<McpStdioBridgeHandle> {
  const entries = Object.entries(servers)
  if (entries.length === 0) {
    return {
      mcpServers: [],
      close: async () => {}
    }
  }

  const secretToken = randomBytes(32).toString('hex')
  const sockets = new Set<net.Socket>()
  const transports = new Set<StdioServerTransport>()
  let closing = false

  const tcpServer = net.createServer((socket) => {
    if (closing) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))

    let handshakeDone = false
    let headerBuffer = Buffer.alloc(0)
    const handshakeTimer = setTimeout(() => {
      if (!handshakeDone) socket.destroy()
    }, HANDSHAKE_TIMEOUT_MS)

    const onHandshakeData = (chunk: Buffer) => {
      headerBuffer = Buffer.concat([headerBuffer, chunk])
      const newlineIndex = headerBuffer.indexOf(0x0a)
      if (newlineIndex < 0) {
        if (headerBuffer.length > MAX_HANDSHAKE_BYTES) {
          clearTimeout(handshakeTimer)
          socket.destroy()
        }
        return
      }

      handshakeDone = true
      clearTimeout(handshakeTimer)
      socket.off('data', onHandshakeData)

      const headerLine = headerBuffer.subarray(0, newlineIndex).toString('utf8').trim()
      const remainder = headerBuffer.subarray(newlineIndex + 1)
      headerBuffer = Buffer.alloc(0)

      let parsed: { token?: unknown; server?: unknown }
      try {
        parsed = JSON.parse(headerLine)
      } catch {
        socket.destroy()
        return
      }

      if (
        !tokensMatch(secretToken, parsed.token) ||
        typeof parsed.server !== 'string' ||
        !Object.hasOwn(servers, parsed.server)
      ) {
        socket.destroy()
        return
      }

      const target = servers[parsed.server]
      const readable = new PassThrough()
      if (remainder.length > 0) {
        readable.write(remainder)
      }
      socket.pipe(readable)
      socket.once('error', () => readable.destroy())
      socket.once('close', () => readable.end())

      const transport = new StdioServerTransport(readable, socket)
      transports.add(transport)
      socket.once('close', () => transports.delete(transport))

      void target.connect(transport).catch((error) => {
        logger.warn(`Failed to attach bridged MCP server ${parsed.server}`, { error })
        socket.destroy()
      })
    }

    socket.on('data', onHandshakeData)
    socket.on('error', () => {
      clearTimeout(handshakeTimer)
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    tcpServer.once('error', reject)
    tcpServer.listen(0, '127.0.0.1', () => {
      tcpServer.off('error', reject)
      const address = tcpServer.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve loopback MCP bridge port'))
        return
      }
      resolve(address.port)
    })
  })

  const mcpServers: McpServerStdio[] = entries.map(([serverKey, server]) => ({
    name: server.name || serverKey,
    command: process.execPath,
    args: ['-e', STDIO_TCP_RELAY_SCRIPT],
    env: [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      { name: 'CHERRY_MCP_BRIDGE_PORT', value: String(port) },
      { name: 'CHERRY_MCP_BRIDGE_TOKEN', value: secretToken },
      { name: 'CHERRY_MCP_BRIDGE_SERVER', value: serverKey }
    ]
  }))

  return {
    mcpServers,
    close: async () => {
      if (closing) return
      closing = true
      await Promise.allSettled([...transports].map((transport) => transport.close()))
      transports.clear()
      for (const socket of sockets) {
        socket.destroy()
      }
      sockets.clear()
      await new Promise<void>((resolve) => {
        tcpServer.close(() => resolve())
      })
    }
  }
}
