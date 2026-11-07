# Google Antigravity Provider & Cherry Studio Agent Harness Integration — Design Spec

**Date:** 2026-11-07  
**Branch:** `feat/antigravity-acp-windows` (`Andy-Lin55/cherry-studio`)  
**Status:** Draft for User Review

---

## 1. Goal & User Experience

Deliver the exact same workflow in Cherry Studio that **OpenAI Codex** and **Claude Code** provide today, while strictly complying with Google Antigravity's official third-party IDE policy (`https://antigravity.google/docs/ide/extensions`):

1. **Settings → Model Provider (`Google Antigravity`):**
   - Built-in login-based provider (`id: 'google-antigravity'`, `authMethods: ['external-cli']`, `modelListSource: 'registry'`).
   - Shows live `agy` CLI installation & login status, subscription tier (e.g., `Google AI Pro`), a one-click **Log in with Google** button (via official `agy acp` `authenticate` / `agy acp --login`), and a **Recheck** button.
   - Surfaces all 5 Antigravity model families in the provider model list with Cherry Studio's model icons, vision badges, and reasoning-effort controls (`Low` / `Medium` / `High`):
     - `Claude Opus 5.5` (`modelId: 'claude-opus-5-5'`, `apiModelId: 'claude-opus-5-5'`)
     - `Claude Sonnet 5.5` (`modelId: 'claude-sonnet-5-5'`, `apiModelId: 'claude-sonnet-5-5'`)
     - `Gemini 4 Argon` (`modelId: 'gemini-4-argon'`, `apiModelId: 'gemini-4-argon'`)
     - `Gemini 3.8 Flash` (`modelId: 'gemini-3-8-flash'`, `apiModelId: 'gemini-3.8-flash'`)
     - `GPT-OSS 120B` (`modelId: 'gpt-oss-120b'`, `apiModelId: 'gpt-oss-120b-medium'`)

2. **Agents Module Full Harness Integration (`claude-code`, `pi`, `pi-durable`):**
   - Inside **any** Cherry Studio Agent (including existing Agents like `Cherry 投研小助手` and `Cherry Claw`, or newly created Agents), the user can select any `Google Antigravity` model from the Agent Model Selector (in `AgentEditDialog` and in-chat `AgentComposer`) and adjust **Reasoning Effort** (`Low` / `Medium` / `High`) and **Permission Mode** (`default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`).
   - Selecting a `google-antigravity::<modelId>` model routes the Agent session through a compliant **`AntigravityHarnessConnection`** backed by Google's official `agy acp` JSON-RPC stdio server — **never** extracting `~/.gemini/antigravity-cli/antigravity-oauth-token` and **never** calling `cloudcode-pa.googleapis.com` over raw HTTP.
   - Mounts Cherry Studio's **entire Agent Harness** onto the `agy acp` session:
     - **Skills (`Skills` tab & Composer toolbar):** Mounts the Agent's enabled Cherry Studio Skills (`agent_global_skill` + per-agent `agent_skill` from `SkillService.list({ agentId })`) into an isolated session customization root passed via ACP `additionalDirectories` (`.agents/skills/<folderName>` directory junctions/symlinks) AND mounts Cherry Studio's `skills` MCP server (`search_skills`, `install_skill`).
     - **MCP Servers & Built-in Harness Tools:** Bridges `buildAgentMcpServers` (user-selected MCPs such as `fxbaogao`, `boj-jstat`, `stockprice`, plus Cherry's `cherry-tools` Knowledge Bases / Web tools, `agent-memory`, and `automation`) into `agy acp`'s `session/new` and `session/resume` `mcpServers` list via a loopback HTTP + Node stdio MCP relay.
     - **Instructions, Persona, Memory & Language:** Injects Cherry Studio's assembled system prompt (`buildAgentRuntimePrompt` + `buildCitationsGuidance` + language guidance) via `agy acp`'s official `_meta.antigravity.systemPrompt.append` capability.

3. **Standalone Local Agent Model Selection Fix + macOS CI Packaging Fix:**
   - Registers `'antigravity-acp'` in `LOCAL_AGENT_MODEL_CONFIG` and `nativeModelConfig.ts` (`antigravity-settings`) so model picking also works if the user opens the standalone `Google Antigravity` Local Agent card.
   - Fixes `.github/workflows/mac-local-upgrade.yml` by removing empty `CSC_LINK: ""` (which caused `electron-builder` on `macos-latest` to treat `$PWD` as a certificate path) while keeping `CSC_IDENTITY_AUTO_DISCOVERY: "false"` and `-c.mac.identity=-`.

---

## 2. Strict Compliance Boundary

- **Sanctioned Transport Only:** All model inference, authentication, and session lifecycle operations go exclusively through the official `agy` CLI (`agy acp` over JSON-RPC 2.0 stdio, `agy --version`, `agy acp --login`).
- **Zero Credential Extraction:** Cherry Studio never reads, copies, decrypts, or refreshes `~/.gemini/antigravity-cli/antigravity-oauth-token` or impersonates Antigravity's OAuth client ID over HTTP.
- **Agent-Only External-CLI Isolation:** Because `google-antigravity` declares `authMethods: ['external-cli']`, Cherry Studio's existing `isExternalCliProvider` / `isAgentOnlyProvider` guards automatically hide it from raw HTTP Chat/Topic-naming/API-Gateway endpoints while exposing it to Agent model pickers.

---

## 3. Architecture & Component Design

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Cherry Studio Renderer                                                     │
│  1. Settings -> Model Provider -> Google Antigravity                       │
│     (AntigravitySettings.tsx: status + tier + "Log in with Google")        │
│  2. Agents Module (Cherry 投研小助手 / Cherry Claw / Any Agent)            │
│     - ModelSelector -> google-antigravity::claude-opus-5-5 (etc.)          │
│     - ModelSpeedControl -> Reasoning Effort (low / medium / high)          │
│     - AgentEditDialog & AgentComposer -> Skills, MCPs, KB, Instructions    │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ AgentSessionRuntimeService.connect(input)
                                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Runtime Dispatch Layer (src/main/ai/runtime/)                              │
│  When parseUniqueModelId(input.modelId).providerId === 'google-antigravity'│
│  (in ClaudeCodeRuntimeDriver, PiRuntimeDriver, PiDurableRuntimeDriver)     │
│  ──► connectAntigravityAgentSession(input)                                 │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ AntigravityHarnessConnection (src/main/ai/runtime/antigravity/)            │
│  - Workspace prep: prepareAgentSessionWorkspaceDirectory(session)          │
│  - Skills staging: <agentDataPath>/.agy-harness/<sessionId>/.agents/skills │
│    (junctions/symlinks to enabled SkillService.list({ agentId }) folders)  │
│  - System prompt: buildAgentRuntimePrompt(...) -> _meta.antigravity        │
│  - MCP Loopback Hub + Stdio Relay: serves buildAgentMcpServers(...)        │
│    (user mcps + cherry-tools + skills + agent-memory + automation)         │
│    as ACP McpServerStdio entries using process.execPath (RUN_AS_NODE=1)    │
│  - AcpConnection over official `agy acp`:                                  │
│    * session/new or session/resume (resumeToken = "agy-acp:<nativeId>")    │
│    * session/set_config_option("model", apiModelId)                        │
│    * session/set_config_option("thought_level", low|medium|high)           │
│    * session/set_config_option("mode", default|accept-edits|plan)          │
└────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Provider Registry & Shared Presets

1. **`src/shared/data/presets/antigravity.ts`:**
   - Exports `ANTIGRAVITY_PROVIDER_ID = 'google-antigravity'`, `isAntigravityProviderId(providerId: string): boolean`, and `isAntigravityModelId(modelId: string | null | undefined): boolean` (`parseUniqueModelId` check).
2. **`packages/provider-registry/src/providers/google-antigravity.ts` & `index.ts`:**
   - Defines `google-antigravity` via `defineProvider`:
     - `id: 'google-antigravity'`, `name: 'Google Antigravity'`, `availableInEditions: ['global']`
     - `authMethods: ['external-cli']`, `modelListSource: 'registry'`
     - `defaultChatEndpoint: 'openai-chat-completions'` with placeholder `endpointConfigs` (required by registry schema; never called directly because `authMethods: ['external-cli']` marks it agent-only).
     - `overrides`:
       1. `{ modelId: 'claude-opus-5-5', apiModelId: 'claude-opus-5-5', name: 'Claude Opus 5.5' }`
       2. `{ modelId: 'claude-sonnet-5-5', apiModelId: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }`
       3. `{ modelId: 'gemini-4-argon', apiModelId: 'gemini-4-argon', name: 'Gemini 4 Argon' }`
       4. `{ modelId: 'gemini-3-8-flash', apiModelId: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }`
       5. `{ modelId: 'gpt-oss-120b', apiModelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }`
   - Regenerate `packages/provider-registry/data/{models,provider-models,providers}.json` via `pnpm --filter @cherrystudio/provider-registry generate` so all catalog invariant & source-sync tests pass.
3. **Agent Model Compatibility (`src/shared/ai/piModelCompatibility.ts`):**
   - Allow `isAntigravityProviderId(provider.id)` in `isPiCompatibleModel` (alongside `claude-code`'s `isGatewayRoutableModel`, which already allows `google-antigravity`!). That way **all three** managed Agent runtimes (`claude-code`, `pi`, `pi-durable`) can select `Google Antigravity` models!

### 3.2 Provider Settings UI & Official `agy` Login Check

1. **`src/main/ipc/handlers/oauth.ts`:**
   - Extend `'oauth.check_external_login'` to support `isAntigravityProviderId(providerId)` by calling `getLocalAgentAuthStatus` for the `antigravity-acp` preset (`authenticated === true`).
2. **`src/renderer/pages/settings/ProviderSettings/ProviderSpecific/AntigravitySettings.tsx` & `providerSpecificSettingsRegistry.tsx`:**
   - Mirrors `ClaudeCodeSettings.tsx` + `LocalAgentAuthService`:
     - Probes `oauth.check_external_login` and `ai.local_agents.auth_status` (`presetId: 'antigravity-acp'`).
     - When signed in: displays green connected banner, active tier badge if reported (e.g., `Google AI Pro`), compliance link (`https://antigravity.google/docs/ide/extensions`), and **Recheck** button.
     - When not signed in (or `agy` not yet installed): offers **Install CLI** (if missing, via `ai.local_agents.install`), **Log in with Google** (via `ai.local_agents.authenticate` with `methodId: 'oauth-personal'`, falling back to `ai.local_agents.open_terminal` `login: true`), and **Recheck**.

### 3.3 `AntigravityHarnessConnection` & MCP/Skills Bridge (`src/main/ai/runtime/antigravity/`)

Focused, isolated modules under `src/main/ai/runtime/antigravity/`:

1. **`mcpStdioBridgeHost.ts` + `mcpStdioRelayEntry.ts`:**
   - Because `agy acp` connects to session MCP servers via standard `McpServerStdio` (`{ name, command, args, env }`), `McpStdioBridgeHost` starts an ephemeral `127.0.0.1:0` HTTP listener bound with a random per-connection bearer token in the Electron main process, backed by `WebStandardStreamableHTTPServerTransport` connected to each `AgentMcpServer` from `buildAgentMcpServers(...)`.
   - Each server entry in `mcpServers` spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1` running a tiny bundled `mcpStdioRelay` script that bridges `stdin`/`stdout` JSON-RPC lines to `http://127.0.0.1:<port>/mcp/<serverKey>` with the bearer token.
   - Closing the `AntigravityHarnessConnection` closes the loopback HTTP server and all `AgentMcpServer` transports cleanly.

2. **`stageAntigravitySkills.ts`:**
   - Queries `skillService.list({ agentId: agent.id })` for enabled skills (`isEnabled === true`).
   - Creates `<agentDataPath>/.antigravity-harness/<sessionId>/.agents/skills/` and populates directory junctions (`'junction'` on Windows — requires zero admin privileges — and `'dir'` symlinks on macOS/Linux) pointing to `skillService.getSkillDirectory(skill.folderName)`.
   - Returns `[<agentDataPath>/.antigravity-harness/<sessionId>]` to pass in ACP `session/new` & `session/resume` `additionalDirectories`, so `agy` natively discovers only the Agent's enabled Cherry Skills via progressive disclosure without touching the user's project git working tree.

3. **`AntigravityHarnessConnection.ts`:**
   - Implements `AgentRuntimeConnection` by extending/delegating to `AcpConnection` with session-harness options:
     - **Model & Effort Mapping (`connect` & `reconcile`):** Resolves `apiModelId` (`claude-opus-5-5`, `claude-sonnet-5-5`, `gemini-4-argon`, `gemini-3.8-flash`, `gpt-oss-120b-medium`) from `input.modelId`, and maps `input.reasoningEffort` (`minimal`/`low` → `'low'`, `medium`/`auto`/undefined → `'medium'`, `high`/`xhigh`/`max` → `'high'`). Applies both via `session/set_config_option` (`model` and `thought_level`) on connect. On `reconcile(next)`:
       - If `next.modelId` remains on `google-antigravity` and workspace/MCP/skills signature is unchanged, updates `model` and `thought_level` live via `session/set_config_option` and returns `{ action: 'reused' }`.
       - If `next.modelId` switches to another provider (e.g., `openai-codex::gpt-6.1-sol`) or workspace/MCP/skills changed, returns `{ action: 'rebuild' }` so `AgentSessionRuntimeService` reconnects cleanly.
     - **Permission Mode Mapping:** Reads `agent.configuration?.permission_mode`:
       - `'plan'` → ACP mode `'plan'`
       - `'acceptEdits'` → ACP mode `'accept-edits'`
       - `'bypassPermissions'` / `'auto'` → ACP mode `'accept-edits'` + auto-approves ACP `session/request_permission` (`allow_always` / `allow_once`) without blocking headless/autonomous runs (such as Heartbeat or `Cherry 投研小助手`).
       - `'default'` → ACP mode `'default'` + interactive Cherry Studio tool approval UI.
     - **System Prompt Injection:** Builds Cherry Studio's full runtime prompt via `buildAgentRuntimePrompt` + `buildCitationsGuidance` and passes `_meta: { antigravity: { systemPrompt: { append: systemPrompt } } }` in `session/new` / `session/resume`.
     - **Cross-Runtime Resume & Mid-Session Model Switch Safety:**
       - Prefixes emitted resume tokens as `agy-acp:<nativeSessionId>`.
       - If `input.resumeToken` starts with `agy-acp:`, strips the prefix and resumes the native `agy acp` session (`session/resume`).
       - If `input.resumeToken` is absent or belongs to another runtime (e.g., user started a conversation on `openai-codex::gpt-6.1-sol` and switched mid-conversation to `google-antigravity::claude-opus-5-5`!), starts a fresh `agy acp` session (`session/new`) and prepends a compact transcript summary of existing `agentSessionMessageService` messages to the first user turn so conversation continuity is preserved seamlessly!

4. **Driver Dispatch Hook (`ClaudeCodeRuntimeDriver.ts`, `PiRuntimeDriver.ts`, `PiDurableRuntimeDriver.ts`, `AgentSessionRuntimeService.ts`):**
   - In `AgentSessionRuntimeService.primeConnection` (skip `ClaudeCodeBinaryService` gate when `isAntigravityModelId(executionId)`) and in `ClaudeCodeRuntimeDriver.connect` / `PiRuntimeDriver.connect` / `PiDurableRuntimeDriver.connect`, when `isAntigravityModelId(input.modelId)` is true, delegate directly to `connectAntigravityAgentSession(input)`.

### 3.4 Standalone Local Agent Model Config (`antigravity-acp`)

- Add `CodeCli.ANTIGRAVITY_CLI` to `MODEL_CONFIGURED_CLI_TOOL_IDS` (`src/shared/utils/cliConfig.ts`), add `'antigravity-acp': { tool: CodeCli.ANTIGRAVITY_CLI, target: 'antigravity-settings' }` to `LOCAL_AGENT_MODEL_CONFIG` (`src/shared/ai/localAgentModel.ts`), and handle `'antigravity-settings'` JSON `{ "model": ... }` in `nativeModelConfig.ts` + `codeCliConfig.ts` (native model selection; gateway disabled for `antigravity-acp` since Antigravity strictly uses Google login).
- Ensure `AcpConnection.readConfigOptions` & model selection cleanly reconcile base config model IDs (`claude-opus-5-5`) and legacy effort-suffixed IDs (`claude-opus-5-5-high` → `model: 'claude-opus-5-5'` + `thought_level: 'high'`).

---

## 4. Error Handling & Edge Cases

1. **`agy` CLI Not Installed:** If the user selects a `Google Antigravity` model before installing `agy`, `AntigravityHarnessConnection` throws a clear actionable error directing them to **Settings → Model Provider → Google Antigravity** (where 1-click install & login live).
2. **Authentication Expired / Not Logged In:** `acpError` maps `-32000` (`AuthRequired`) to a clear prompt to click **Log in with Google** in **Settings → Model Provider → Google Antigravity**.
3. **MCP Server Slow / Dead:** `McpStdioBridgeHost` isolates each MCP server route; a failing external MCP server returns an MCP error for that tool without blocking `agy acp` session startup.
4. **Windows Symlink Permissions:** `stageAntigravitySkills` uses `'junction'` on `win32` (works on Windows Home without Administrator Mode or Developer Mode) and cleans up stale junctions on reconnect.

---

## 5. Verification & Testing Strategy

1. **Unit & Contract Tests (Vitest):**
   - `packages/provider-registry`: catalog generation, invariants, and source-sync tests for `google-antigravity` and its 5 models.
   - `src/main/ai/runtime/antigravity/__tests__/`:
     - `mcpStdioBridgeHost.test.ts`: verifies real in-memory `AgentMcpServer` tool listing and execution over the loopback HTTP + stdio relay.
     - `stageAntigravitySkills.test.ts`: verifies enabled skills junction staging and disabled skills exclusion.
     - `AntigravityHarnessConnection.test.ts`: verifies `agy acp` handshake, `_meta.antigravity.systemPrompt.append`, `mcpServers` + `additionalDirectories` injection, `model` + `thought_level` + `mode` mapping, `agy-acp:` resume token isolation, and mid-session Codex → Antigravity history seeding.
   - `src/main/ai/runtime/localAgent/__tests__/`: `selectModel.test.ts` & `nativeModelConfig.test.ts` for `antigravity-acp`.
2. **Typechecks & Build:**
   - `pnpm run typecheck:node` and `pnpm run typecheck:web` (exit code `0`).
   - Full Windows production build (`electron-vite build` + `build:utility-process` + `electron-builder --win --x64 --dir`) and native smoke test on `dist\win-unpacked\Cherry Studio.exe`.
   - End-to-end live probe spawning `agy.exe acp` with `McpStdioBridgeHost` + staged Cherry Skills to prove `agy.exe acp` connects to Cherry's MCP bridge and accepts model/effort switching cleanly.
3. **GitHub Push & MacBook Release Verification:**
   - Push to `origin/feat/antigravity-acp-windows` on `Andy-Lin55/cherry-studio` and verify `.github/workflows/mac-local-upgrade.yml` builds macOS `.dmg`/`.zip` artifacts cleanly.
