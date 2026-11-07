# Google Antigravity ACP Windows Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork `CherryHQ/cherry-studio` (PR #21221 baseline) to `Andy-Lin55/cherry-studio`, patch `antigravity-acp` so Windows/public `agy` (`agy acp`) is natively discovered, installed, and launched over ACP, push the branch, back up user data, and build a runnable Windows x64 app wired to `D:\BaiduNetdiskDownload\cherryStudio`.

**Architecture:** `antigravity-acp` in `src/shared/ai/localAgent.ts` switches its primary executable from Google's legacy internal `agy_acp_server.par` to `agy` with `args: ['acp']`, keeping `agy_acp_server.par` and `agy_acp_server` as fallback aliases handled in `resolveLocalAgentLaunch` (`src/main/ai/runtime/localAgent/launch.ts`). `resolveInstallRecipe` (`src/main/ai/runtime/localAgent/installRecipe.ts`) routes `'antigravity-acp'` to the existing native `agy` PowerShell/bash installer recipe.

**Tech Stack:** TypeScript, Electron, React, Vitest, `mise` (`node@24`, `pnpm@12.6.0`), `electron-vite`, `electron-builder`, GitHub CLI (`gh`).

## Global Constraints

- Node engine floor: `>=24.12.0` (`mise` managed inside `D:\BaiduNetdiskDownload\cherryStudio\cherry-studio-src`; leave system Node `v22.15.0` untouched).
- Package manager: `pnpm@12.6.0`.
- Compliance: Only invoke official `agy` (`agy acp`) over JSON-RPC `stdio`; never read or proxy `~/.gemini/antigravity-cli/antigravity-oauth-token`.
- Data safety: Back up `D:\BaiduNetdiskDownload\cherryStudio\Data\cherrystudio.sqlite*` before launching the new build against existing user data.

---

### Task 1: Fork Repository, Clone PR #21221 Baseline & Provision Toolchain

**Files:**
- Create: `D:\BaiduNetdiskDownload\cherryStudio\cherry-studio-src\` (git clone)
- Create: `D:\BaiduNetdiskDownload\cherryStudio\cherry-studio-src\docs\superpowers\specs\2026-11-07-antigravity-acp-windows-design.md`
- Create: `D:\BaiduNetdiskDownload\cherryStudio\cherry-studio-src\docs\superpowers\plans\2026-11-07-antigravity-acp-windows.md`

**Interfaces:**
- Consumes: `CherryHQ/cherry-studio` branch `kangfenmao/multica-local-agents`, `C:\Users\andyl\.cherrystudio\bin\mise.exe`
- Produces: Local git branch `feat/antigravity-acp-windows` tracking fork `Andy-Lin55/cherry-studio`, working `node >= 24.12.0` + `pnpm 12.6.0` + installed `node_modules`.

- [ ] **Step 1: Fork `CherryHQ/cherry-studio` to `Andy-Lin55/cherry-studio` and shallow-clone `kangfenmao/multica-local-agents`**

```powershell
gh repo fork CherryHQ/cherry-studio --clone=false
git clone --branch kangfenmao/multica-local-agents --single-branch --depth 50 https://github.com/CherryHQ/cherry-studio.git D:\BaiduNetdiskDownload\cherryStudio\cherry-studio-src
cd D:\BaiduNetdiskDownload\cherryStudio\cherry-studio-src
git remote rename origin upstream
git remote add origin https://github.com/Andy-Lin55/cherry-studio.git
git checkout -b feat/antigravity-acp-windows
```

- [ ] **Step 2: Provision `node@24` and `pnpm@12.6.0` via `mise` and install dependencies**

```powershell
$mise = 'C:\Users\andyl\.cherrystudio\bin\mise.exe'
& $mise install node@24 pnpm@12.6.0
& $mise exec node@24 pnpm@12.6.0 -- node -v
& $mise exec node@24 pnpm@12.6.0 -- pnpm -v
cd D:\BaiduNetdiskDownload\cherryStudio\cherry-studio-src
& $mise exec node@24 pnpm@12.6.0 -- pnpm install --frozen-lockfile
```

- [ ] **Step 3: Save spec & plan docs into repository and commit**

Copy design spec and implementation plan into `docs/superpowers/specs/` and `docs/superpowers/plans/`, then commit on `feat/antigravity-acp-windows`.

---

### Task 2: Patch `antigravity-acp` Preset, Launch Resolution & Install Recipe (TDD)

**Files:**
- Modify: `src/shared/ai/localAgent.ts:370-391`
- Modify: `src/main/ai/runtime/localAgent/launch.ts:210-235`
- Modify: `src/main/ai/runtime/localAgent/installRecipe.ts:35-43`
- Test: `src/main/ai/runtime/localAgent/__tests__/launch.test.ts`
- Test: `src/main/ai/runtime/localAgent/__tests__/installRecipe.test.ts`

**Interfaces:**
- Consumes: `LOCAL_AGENT_PRESETS` (`src/shared/ai/localAgent.ts`), `CODE_CLI_TOOL_PRESETS` (`src/shared/data/presets/codeCliTools.ts`)
- Produces:
  - `resolveLocalAgentLaunch(config)` returning `{ executable: '.../agy', args: ['acp'], ... }` when `agy` is installed, or legacy args (`['--uid=']` on Linux, `[]` elsewhere) when `agy_acp_server.par` / `agy_acp_server` is resolved.
  - `resolveInstallRecipe('antigravity-acp', undefined, platform)` returning official PowerShell/bash `CliScriptRecipe`.

- [ ] **Step 1: Write failing tests in `launch.test.ts` and `installRecipe.test.ts`**

Update `src/main/ai/runtime/localAgent/__tests__/launch.test.ts`:
- Change table row `['antigravity-acp', 'agy_acp_server.par', []]` to `['antigravity-acp', 'agy', ['acp']]` (and remove the special-case `presetId === 'antigravity-acp' && process.platform === 'linux' ? ['--uid='] : args` in that `it.each` assertion since `agy` uses `['acp']` on all platforms).
- Update `'detects the Antigravity adapter and interactive CLI independently'` to verify both:
  1. When `agy` is installed, `detectLocalAgents()` resolves `path: '/user/bin/agy'` and `terminalPath: '/user/bin/agy'`, and `resolveLocalAgentLaunch` passes `args: ['acp']`.
  2. When only `agy_acp_server.par` is installed, `detectLocalAgents()` falls back to `path: '/user/bin/agy_acp_server.par'` (`terminalPath: undefined`), and `resolveLocalAgentLaunch` passes `process.platform === 'linux' ? ['--uid='] : []`.

Update `src/main/ai/runtime/localAgent/__tests__/installRecipe.test.ts`:
- Assert `resolveInstallRecipe('antigravity-acp', undefined, 'win32')` matches `{ manager: 'script', command: 'powershell.exe' }` containing `https://antigravity.google/cli/install.ps1`, and `'darwin'` matches `{ manager: 'script', command: 'bash' }` containing `https://antigravity.google/cli/install.sh`.

- [ ] **Step 2: Run Vitest on both test files to verify RED failure**

```powershell
& $mise exec node@24 pnpm@12.6.0 -- pnpm exec vitest run --project main src/main/ai/runtime/localAgent/__tests__/launch.test.ts src/main/ai/runtime/localAgent/__tests__/installRecipe.test.ts
```
Expected: FAIL (`antigravity-acp` still resolves `agy_acp_server.par` and `resolveInstallRecipe('antigravity-acp')` returns `undefined`).

- [ ] **Step 3: Implement minimal changes in `localAgent.ts`, `launch.ts`, and `installRecipe.ts`**

In `src/shared/ai/localAgent.ts`:
```ts
  {
    id: 'antigravity-acp',
    terminalArgs: [],
    loginArgs: ['acp', '--login'],
    terminalExecutable: 'agy',
    name: 'Google Antigravity',
    protocol: 'acp',
    executable: 'agy',
    aliases: ['agy_acp_server.par', 'agy_acp_server'],
    args: ['acp'],
    helpUrl: 'https://antigravity.google/docs/ide/extensions'
  },
```

In `src/main/ai/runtime/localAgent/launch.ts`:
```ts
  const legacyAntigravityServer =
    preset?.id === 'antigravity-acp' &&
    path.basename(executable).toLowerCase().startsWith('agy_acp_server')
  const defaultArgs = legacyAntigravityServer
    ? process.platform === 'linux'
      ? ['--uid=']
      : []
    : [...(preset?.platformArgs?.[process.platform as 'linux' | 'darwin' | 'win32'] ?? preset?.args ?? [])]
```
(used when `config.args.length === 0`).

In `src/main/ai/runtime/localAgent/installRecipe.ts`:
```ts
  const native =
    preset.protocol !== 'acp' ||
    ['kimi', 'hermes', 'deepseek-harness', 'openclaw', 'antigravity-acp'].includes(presetId)
      ? CODE_CLI_TOOL_PRESETS.find((entry) => entry.executable === preset.executable)
      : undefined
```

- [ ] **Step 4: Re-run Vitest & typechecks to verify GREEN**

```powershell
& $mise exec node@24 pnpm@12.6.0 -- pnpm exec vitest run --project main src/main/ai/runtime/localAgent/__tests__/launch.test.ts src/main/ai/runtime/localAgent/__tests__/installRecipe.test.ts
& $mise exec node@24 pnpm@12.6.0 -- pnpm typecheck:node
& $mise exec node@24 pnpm@12.6.0 -- pnpm typecheck:web
```
Expected: All tests PASS, 0 type errors.

- [ ] **Step 5: Commit and push `feat/antigravity-acp-windows` to `Andy-Lin55/cherry-studio`**

```powershell
git add src/shared/ai/localAgent.ts src/main/ai/runtime/localAgent/launch.ts src/main/ai/runtime/localAgent/installRecipe.ts src/main/ai/runtime/localAgent/__tests__/launch.test.ts src/main/ai/runtime/localAgent/__tests__/installRecipe.test.ts
git commit -m "fix(local-agent): support public agy acp CLI and installer for antigravity-acp"
git push -u origin feat/antigravity-acp-windows
```

---

### Task 3: Back Up Existing User Data, Build Windows x64 App & Wire Data Directory

**Files:**
- Create: `D:\BaiduNetdiskDownload\cherryStudio\Data\backups\pre-acp-20261107\`
- Create: `D:\BaiduNetdiskDownload\cherryStudio\cherry-studio-src\dist\win-unpacked\Cherry Studio.exe` (build output)
- Modify: `C:\Users\andyl\.cherrystudio\config\config.json`
- Modify: `C:\Users\andyl\.cherrystudio\boot-config.json`

**Interfaces:**
- Consumes: Compiled Electron bundle from `pnpm build` + `electron-builder --win --x64 --dir`
- Produces: Runnable `Cherry Studio.exe` bound to `D:\BaiduNetdiskDownload\cherryStudio` with backed-up SQLite state.

- [ ] **Step 1: Back up `cherrystudio.sqlite` (and `-wal` / `-shm`)**

Copy `Data\cherrystudio.sqlite*` into `D:\BaiduNetdiskDownload\cherryStudio\Data\backups\pre-acp-20261107\` and verify file sizes.

- [ ] **Step 2: Build unpacked Windows x64 application**

Run the Electron preparation/native rebuild + `pnpm build` + `electron-builder --win --x64 --dir` under `mise` (`node@24`, `pnpm@12.6.0`) and verify `Cherry Studio.exe` is produced.

- [ ] **Step 3: Register new executable path in Cherry Studio boot/user-data config**

Add the built `Cherry Studio.exe` path to `C:\Users\andyl\.cherrystudio\config\config.json` and `C:\Users\andyl\.cherrystudio\boot-config.json` pointing to `D:\BaiduNetdiskDownload\cherryStudio` while preserving the existing `D:\Cherry Studio\Cherry Studio.exe` entry.
