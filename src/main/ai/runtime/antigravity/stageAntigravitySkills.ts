import { mkdir, rm, stat, symlink } from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'

const logger = loggerService.withContext('AntigravitySkillsStage')

export interface StageAntigravitySkillsInput {
  agentDataPath: string
  sessionId: string
  skills: ReadonlyArray<{ folderName: string; isEnabled: boolean }>
  getSkillDirectory: (folderName: string) => string
}

export interface StagedAntigravitySkills {
  additionalDirectories: string[]
  cleanup(): Promise<void>
}

function isSafeFolderName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  )
}

/**
 * Materializes Cherry Studio's per-agent enabled skills into an isolated
 * `<agentDataPath>/.antigravity-harness/<sessionId>/.agents/skills/<folderName>`
 * directory tree using junctions (`win32`) or directory symlinks (POSIX), ready
 * to pass via `agy acp` `additionalDirectories`.
 */
export async function stageAntigravitySkills(
  input: StageAntigravitySkillsInput
): Promise<StagedAntigravitySkills> {
  const safeSessionId = input.sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'default'
  const stagingRoot = path.join(input.agentDataPath, '.antigravity-harness', safeSessionId)
  const skillsDir = path.join(stagingRoot, '.agents', 'skills')

  await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})

  const enabledSkills = input.skills.filter((skill) => skill.isEnabled && isSafeFolderName(skill.folderName))
  if (enabledSkills.length === 0) {
    return {
      additionalDirectories: [],
      cleanup: async () => {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  await mkdir(skillsDir, { recursive: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  let stagedCount = 0

  for (const skill of enabledSkills) {
    const sourceDir = input.getSkillDirectory(skill.folderName)
    try {
      const info = await stat(sourceDir)
      if (!info.isDirectory()) continue
      const targetLink = path.join(skillsDir, skill.folderName)
      await symlink(sourceDir, targetLink, linkType)
      stagedCount += 1
    } catch (error) {
      logger.warn(`Skipping missing or unreadable skill directory ${skill.folderName}`, { sourceDir, error })
    }
  }

  return {
    additionalDirectories: stagedCount > 0 ? [stagingRoot] : [],
    cleanup: async () => {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
    }
  }
}
