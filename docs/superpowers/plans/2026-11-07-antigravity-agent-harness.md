# Google Antigravity Provider & Agent Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Google Antigravity (`google-antigravity`) as a built-in `external-cli` Model Provider and full Cherry Studio Agent Harness runtime (`AntigravityHarnessConnection` over official `agy acp`) with Model Selection, Reasoning Effort, Skills staging, MCP loopback-stdio bridging, System Prompt injection, standalone Local Agent model config, and macOS CI packaging fix.

**Architecture:** Register `google-antigravity` in `@cherrystudio/provider-registry` (`authMethods: ['external-cli']`, `modelListSource: 'registry'`) with its 5 canonical models (`claude-opus-5-5`, `claude-sonnet-5-5`, `gemini-4-argon`, `gemini-3-8-flash`, `gpt-oss-120b`), expose a live `AntigravitySettings` login/status panel in Provider Settings, and route any managed Agent session (`claude-code`, `pi`, `pi-durable`) whose target model belongs to `google-antigravity` to `AntigravityHarnessConnection` (extending `AcpConnection` over `agy acp` stdio) with a loopback TCP + stdio MCP bridge for `buildAgentMcpServers`, directory junctions for enabled Cherry Skills, and `_meta.antigravity.systemPrompt.append` for `buildAgentRuntimePrompt`.

**Tech Stack:** TypeScript 6, Electron 45, `@agentclientprotocol/sdk`, `@modelcontextprotocol/server` (`StdioServerTransport`), `@cherrystudio/provider-registry`, React 19, Vitest 5.

## Global Constraints

- Strictly communicate only with the official `agy` CLI (`agy acp` over JSON-RPC 2.0 stdio, `agy --version`, `agy acp --login`); never read, copy, or proxy `~/.gemini/antigravity-cli/antigravity-oauth-token` or send raw HTTP requests to `cloudcode-pa.googleapis.com`.
- Provider ID must be `'google-antigravity'` with `authMethods: ['external-cli']` and `modelListSource: 'registry'`.
- Resume tokens emitted by `AntigravityHarnessConnection` must be namespaced with `'agy-acp:'` so cross-provider switching (e.g., `openai-codex` ↔ `google-antigravity`) never passes foreign session IDs to `agy acp`.
- Use directory junctions (`'junction'`) on `win32` and `'dir'` symlinks on POSIX when staging enabled Cherry Skills so Windows Home works without Administrator privileges.
- Run commands on Windows via `C:\Users\andyl\.cherrystudio\bin\mise.exe exec node@24 pnpm@12.6.0 -- <cmd>`.

---

### Task 1: Shared Antigravity Preset, Provider Registry Catalog & Agent Model Compatibility

**Files:**
- Create: `src/shared/data/presets/antigravity.ts`
- Create: `packages/provider-registry/src/providers/google-antigravity.ts`
- Modify: `packages/provider-registry/src/providers/index.ts`
- Modify: `packages/provider-registry/data/providers.json` (generated)
- Modify: `packages/provider-registry/data/provider-models.json` (generated)
- Modify: `packages/provider-registry/data/models.json` (generated)
- Modify: `src/shared/ai/piModelCompatibility.ts`
- Test: `src/shared/ai/__tests__/antigravityPreset.test.ts`

**Interfaces:**
- Produces:
  - `ANTIGRAVITY_PROVIDER_ID = 'google-antigravity'`
  - `isAntigravityProviderId(providerId: string): boolean`
  - `isAntigravityModelId(modelId: string | null | undefined): boolean`
  - `resolveAntigravityAcpModel(modelId: string): string` (maps `gemini-3-8-flash` → `'gemini-3.8-flash'`, `gpt-oss-120b` → `'gpt-oss-120b-medium'`, and passes `claude-opus-5-5`, `claude-sonnet-5-5`, `gemini-4-argon` verbatim)
  - `mapReasoningEffortToAntigravityThoughtLevel(effort?: string): 'low' | 'medium' | 'high'`

- [ ] **Step 1: Write failing tests in `src/shared/ai/__tests__/antigravityPreset.test.ts`** verifying `isAntigravityProviderId`, `isAntigravityModelId`, `resolveAntigravityAcpModel`, `mapReasoningEffortToAntigravityThoughtLevel`, `isPiCompatibleModel` acceptance of `google-antigravity` models, and presence of `google-antigravity` + all 5 models in `@cherrystudio/provider-registry`.
- [ ] **Step 2: Run Vitest on `src/shared/ai/__tests__/antigravityPreset.test.ts` and verify RED.**
- [ ] **Step 3: Implement `src/shared/data/presets/antigravity.ts`, `packages/provider-registry/src/providers/google-antigravity.ts`, register in `packages/provider-registry/src/providers/index.ts`, update `src/shared/ai/piModelCompatibility.ts`, and run `pnpm --filter @cherrystudio/provider-registry generate`.**
- [ ] **Step 4: Run Vitest on `src/shared/ai/__tests__/antigravityPreset.test.ts` + `packages/provider-registry` tests and verify GREEN.**
- [ ] **Step 5: Commit Task 1.**

---

### Task 2: Standalone Local Agent Model Config (`antigravity-acp`) & macOS CI Workflow Fix

**Files:**
- Modify: `src/shared/ai/localAgentModel.ts`
- Modify: `src/main/ai/runtime/localAgent/nativeModelConfig.ts`
- Modify: `src/renderer/hooks/agent/useLocalAgentModelSelection.ts`
- Modify: `src/main/ai/runtime/localAgent/AcpConnection.ts`
- Modify: `.github/workflows/mac-local-upgrade.yml`
- Test: `src/main/ai/runtime/localAgent/__tests__/nativeModelConfig.test.ts`

**Interfaces:**
- Produces:
  - `LOCAL_AGENT_MODEL_CONFIG['antigravity-acp'] = { tool: CodeCli.ANTIGRAVITY_CLI, target: 'antigravity-settings', nativeOnly: true }`
  - `updateNativeModelConfig('antigravity-settings', content, model)` & `readNativeModelConfig('antigravity-settings', content)`
  - Effort-suffixed ACP model ID normalization in `AcpConnection` (if `defaultModel` is `claude-opus-5-5-high` while `configOptions.model` expects `claude-opus-5-5`, splits into base model + `thought_level: 'high'`).

- [ ] **Step 1: Add failing tests in `src/main/ai/runtime/localAgent/__tests__/nativeModelConfig.test.ts` for `antigravity-settings` read/write preserving existing JSON keys (`allowNonWorkspaceAccess`, `permissions`, `trustedWorkspaces`).**
- [ ] **Step 2: Run Vitest on `nativeModelConfig.test.ts` and verify RED.**
- [ ] **Step 3: Implement `LOCAL_AGENT_MODEL_CONFIG['antigravity-acp']`, `nativeModelConfig.ts` `'antigravity-settings'` handling, `useLocalAgentModelSelection.ts` `nativeOnly` handling, `AcpConnection.ts` effort-suffix model resolution, and `.github/workflows/mac-local-upgrade.yml` empty `CSC_LINK` unset fix.**
- [ ] **Step 4: Run Vitest on `nativeModelConfig.test.ts` and `selectModel.test.ts` and verify GREEN.**
- [ ] **Step 5: Commit Task 2.**

---

### Task 3: Provider Settings UI (`AntigravitySettings.tsx`) & `oauth.check_external_login`

**Files:**
- Modify: `src/main/ipc/handlers/oauth.ts`
- Create: `src/renderer/pages/settings/ProviderSettings/ProviderSpecific/AntigravitySettings.tsx`
- Modify: `src/renderer/pages/settings/ProviderSettings/ProviderSpecific/providerSpecificSettingsRegistry.tsx`
- Modify: `src/renderer/i18n/locales/en-us.json` (or corresponding locale module) & `zh-cn.json`
- Test: `src/main/ipc/handlers/__tests__/oauth.test.ts`

**Interfaces:**
- Consumes: `isAntigravityProviderId` from `@shared/data/presets/antigravity`, `getLocalAgentAuthStatus` from `@main/ai/runtime/localAgent/authStatus`.
- Produces: `'oauth.check_external_login'` returning `boolean` for `'google-antigravity'`, and `AntigravitySettings` component rendered in `Settings -> Model Provider -> Google Antigravity`.

- [ ] **Step 1: Add failing test in `src/main/ipc/handlers/__tests__/oauth.test.ts` verifying `'oauth.check_external_login'` dispatches `'google-antigravity'` to `getLocalAgentAuthStatus` and still rejects unknown provider IDs.**
- [ ] **Step 2: Run Vitest on `oauth.test.ts` and verify RED.**
- [ ] **Step 3: Update `src/main/ipc/handlers/oauth.ts`, create `AntigravitySettings.tsx` (with live status check, 1-click Google login via `ai.local_agents.authenticate`, CLI install fallback, and terminal login fallback), register in `providerSpecificSettingsRegistry.tsx`, and add i18n strings.**
- [ ] **Step 4: Run Vitest on `oauth.test.ts` and verify GREEN.**
- [ ] **Step 5: Commit Task 3.**

---

### Task 4: Loopback MCP Stdio Bridge (`mcpStdioBridgeHost.ts`) & Skills Junction Staging (`stageAntigravitySkills.ts`)

**Files:**
- Create: `src/main/ai/runtime/antigravity/mcpStdioBridgeHost.ts`
- Create: `src/main/ai/runtime/antigravity/stageAntigravitySkills.ts`
- Test: `src/main/ai/runtime/antigravity/__tests__/mcpStdioBridgeHost.test.ts`
- Test: `src/main/ai/runtime/antigravity/__tests__/stageAntigravitySkills.test.ts`

**Interfaces:**
- Consumes: `AgentMcpServer` from `@main/ai/runtime/agentMcpServers`, `StdioServerTransport` from `@modelcontextprotocol/server/stdio`, `McpServerStdio` from `@agentclientprotocol/sdk`.
- Produces:
  - `startMcpStdioBridgeHost(servers: Record<string, AgentMcpServer>): Promise<{ mcpServers: McpServerStdio[]; close(): Promise<void> }>`
  - `stageAntigravitySkills(params: { agentDataPath: string; sessionId: string; skills: ReadonlyArray<{ folderName: string; isEnabled: boolean }>; getSkillDirectory: (folderName: string) => string }): Promise<{ additionalDirectories: string[]; cleanup(): Promise<void> }>`

- [ ] **Step 1: Write failing tests in `mcpStdioBridgeHost.test.ts` (spawning a real `@modelcontextprotocol/client` `StdioClientTransport` using the returned `McpServerStdio` command/args/env and calling `listTools` + `callTool` against an in-memory `McpServer`) and `stageAntigravitySkills.test.ts` (verifying `.agents/skills/<folder>` junctions/symlinks for enabled skills only).**
- [ ] **Step 2: Run Vitest on both test files and verify RED.**
- [ ] **Step 3: Implement `mcpStdioBridgeHost.ts` (loopback `127.0.0.1:0` TCP server authenticating random 256-bit token on first line, then binding `new StdioServerTransport(socket, socket)` to `server.connect(transport)`, paired with inline Node `-e` stdio relay) and `stageAntigravitySkills.ts`.**
- [ ] **Step 4: Run Vitest on both test files and verify GREEN.**
- [ ] **Step 5: Commit Task 4.**

---

### Task 5: `AntigravityHarnessConnection` & Agent Runtime Driver Dispatch

**Files:**
- Modify: `src/main/ai/runtime/localAgent/AcpConnection.ts`
- Create: `src/main/ai/runtime/antigravity/AntigravityHarnessConnection.ts`
- Create: `src/main/ai/runtime/antigravity/index.ts`
- Modify: `src/main/ai/runtime/claudeCode/ClaudeCodeRuntimeDriver.ts`
- Modify: `src/main/ai/runtime/pi/PiRuntimeDriver.ts`
- Modify: `src/main/ai/runtime/piDurable/PiDurableRuntimeDriver.ts`
- Modify: `src/main/ai/agentSession/AgentSessionRuntimeService.ts`
- Test: `src/main/ai/runtime/antigravity/__tests__/AntigravityHarnessConnection.test.ts`

**Interfaces:**
- Consumes: `AcpConnection`, `startMcpStdioBridgeHost`, `stageAntigravitySkills`, `buildAgentMcpServers`, `buildAgentRuntimePrompt`, `buildCitationsGuidance`, `isAntigravityModelId`, `resolveAntigravityAcpModel`, `mapReasoningEffortToAntigravityThoughtLevel`.
- Produces:
  - `connectAntigravityAgentSession(input: AgentRuntimeConnectInput): Promise<AgentRuntimeConnection>`
  - `validateAntigravityAgentSession(session: AgentSessionEntity): Promise<void>`

- [ ] **Step 1: Write failing tests in `AntigravityHarnessConnection.test.ts` using a mock ACP stdio fixture script verifying: (a) `mcpServers`, `additionalDirectories`, and `_meta.antigravity.systemPrompt.append` passed to `session/new`, (b) `model`, `thought_level`, and `mode` set via `session/set_config_option`, (c) `agy-acp:<id>` resume token emission and restoration, (d) live `reconcile()` returning `'patched'` when switching Antigravity models/effort and `'rebuild'` when switching away to `openai-codex`, and (e) mid-session switch history seeding when prior messages exist without an `agy-acp:` resume token.**
- [ ] **Step 2: Run Vitest on `AntigravityHarnessConnection.test.ts` and verify RED.**
- [ ] **Step 3: Add minimal `protected` session customization hooks to `AcpConnection.ts`, implement `AntigravityHarnessConnection.ts` + `index.ts`, and wire `isAntigravityModelId` dispatch in `ClaudeCodeRuntimeDriver.ts`, `PiRuntimeDriver.ts`, `PiDurableRuntimeDriver.ts`, and `AgentSessionRuntimeService.ts` (`primeConnection`).**
- [ ] **Step 4: Run Vitest on `AntigravityHarnessConnection.test.ts` and existing runtime driver tests (`connections.test.ts`, `ClaudeCodeRuntimeDriver.test.ts`, `PiRuntimeDriver.test.ts`, `registerDrivers.test.ts`) and verify GREEN.**
- [ ] **Step 5: Commit Task 5.**

---

### Task 6: Full Verification, Live `agy.exe acp` Harness Probe, Windows Build & MacBook Release Push

**Files:**
- Verify all modified/created files across Tasks 1–5.

- [ ] **Step 1: Run `pnpm run typecheck:node` and `pnpm run typecheck:web` and confirm exit code `0`.**
- [ ] **Step 2: Run full Vitest suite across all touched packages/modules and confirm `0` failures.**
- [ ] **Step 3: Run a live end-to-end probe against `agy.exe acp` with `startMcpStdioBridgeHost` + `stageAntigravitySkills` + `claude-opus-5-5` (`high` effort) to verify real `agy.exe` connects to the MCP bridge and accepts all session parameters.**
- [ ] **Step 4: Build production bundles (`CHERRY_EDITION=global NODE_ENV=production electron-vite build` + `pnpm run build:utility-process`), package `dist\win-unpacked\Cherry Studio.exe`, revert temporary `before-pack.js` bypass if used, and run native Electron smoke test.**
- [ ] **Step 5: Push `feat/antigravity-acp-windows` to `origin` (`Andy-Lin55/cherry-studio`) and verify the `MacBook Build & Local Upgrade Release` GitHub Actions workflow starts cleanly.**
