import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { stageAntigravitySkills } from '../stageAntigravitySkills'

describe('stageAntigravitySkills', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cherry-agy-skills-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('stages enabled skills into .agents/skills/<folderName> junctions/symlinks and cleans up safely', async () => {
    const sourceRoot = path.join(root, 'skills-store')
    const agentDataPath = path.join(root, 'agent-data')
    await mkdir(path.join(sourceRoot, 'fxbaogao-deep-research'), { recursive: true })
    await mkdir(path.join(sourceRoot, 'japan-finance'), { recursive: true })
    await mkdir(path.join(sourceRoot, 'disabled-skill'), { recursive: true })

    await writeFile(path.join(sourceRoot, 'fxbaogao-deep-research', 'SKILL.md'), '# FXBaogao Skill\n', 'utf8')
    await writeFile(path.join(sourceRoot, 'japan-finance', 'SKILL.md'), '# Japan Finance Skill\n', 'utf8')
    await writeFile(path.join(sourceRoot, 'disabled-skill', 'SKILL.md'), '# Disabled Skill\n', 'utf8')

    const staged = await stageAntigravitySkills({
      agentDataPath,
      sessionId: 'session-abc',
      skills: [
        { folderName: 'fxbaogao-deep-research', isEnabled: true },
        { folderName: 'disabled-skill', isEnabled: false },
        { folderName: 'japan-finance', isEnabled: true },
        { folderName: 'missing-skill', isEnabled: true }
      ],
      getSkillDirectory: (folderName) => path.join(sourceRoot, folderName)
    })

    expect(staged.additionalDirectories).toHaveLength(1)
    const [stagingRoot] = staged.additionalDirectories
    expect(
      await readFile(path.join(stagingRoot, '.agents', 'skills', 'fxbaogao-deep-research', 'SKILL.md'), 'utf8')
    ).toBe('# FXBaogao Skill\n')
    expect(await readFile(path.join(stagingRoot, '.agents', 'skills', 'japan-finance', 'SKILL.md'), 'utf8')).toBe(
      '# Japan Finance Skill\n'
    )
    await expect(stat(path.join(stagingRoot, '.agents', 'skills', 'disabled-skill'))).rejects.toThrow()

    await staged.cleanup()

    await expect(stat(stagingRoot)).rejects.toThrow()
    // Source skill directories must remain completely intact!
    expect(await readFile(path.join(sourceRoot, 'fxbaogao-deep-research', 'SKILL.md'), 'utf8')).toBe(
      '# FXBaogao Skill\n'
    )
  })
})
