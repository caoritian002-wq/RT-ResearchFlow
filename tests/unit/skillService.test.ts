import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  discoverSkills,
  loadSkillContent,
  loadVerifiedSkillBundle,
  validateCustomPath
} from '../../electron/main/services/skillService'

const tempDirs: string[] = []
const projectSkillsDir = path.resolve(__dirname, '../../skills')

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-watch-skill-'))
  tempDirs.push(dir)
  return dir
}

function createSkill(parent: string, dirName: string, version = ''): string {
  const skillDir = path.join(parent, dirName)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${dirName}\ndescription: 测试技能\n${version ? `version: ${version}\n` : ''}---\n\n# ${dirName}\n\n规则正文\n`,
    'utf8'
  )
  return skillDir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('skillService', () => {
  it('从项目内置目录发现完整的产业研究 Skill', () => {
    const skill = discoverSkills(projectSkillsDir, [])
      .find((item) => item.skillId === 'builtin:industry-chain-research')

    expect(skill).toMatchObject({
      name: 'industry-chain-research',
      source: 'builtin',
      integrity: 'complete'
    })
    expect(skill?.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(skill?.ruleVersion).toBe(`sha256:${skill?.contentHash.slice(0, 12)}`)
    expect(skill?.contentLength).toBeGreaterThan(10_000)
  })

  it('从模拟安装态 resources/skills 发现产业研究 Skill', () => {
    const resourcesDir = createTempDir()
    const packagedSkillsDir = path.join(resourcesDir, 'skills')
    const packagedSkillDir = path.join(packagedSkillsDir, 'industry-chain-research')
    fs.mkdirSync(packagedSkillDir, { recursive: true })
    fs.copyFileSync(
      path.join(projectSkillsDir, 'industry-chain-research', 'SKILL.md'),
      path.join(packagedSkillDir, 'SKILL.md')
    )

    const skill = discoverSkills(packagedSkillsDir, [])
      .find((item) => item.skillId === 'builtin:industry-chain-research')

    expect(skill).toMatchObject({
      source: 'builtin',
      integrity: 'complete'
    })
    expect(skill?.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('同时发现父目录中的 Skill 和直接 Skill 目录', () => {
    const parent = createTempDir()
    const skillDir = createSkill(parent, 'industry-chain-research', '1.2.3')

    const fromParent = discoverSkills('', [parent])
    const fromDirect = discoverSkills('', [skillDir])

    expect(fromParent).toHaveLength(1)
    expect(fromDirect).toHaveLength(1)
    expect(fromDirect[0]).toMatchObject({
      skillId: 'custom:industry-chain-research',
      version: '1.2.3',
      ruleVersion: '1.2.3',
      integrity: 'complete'
    })
  })

  it('内容未变化时哈希稳定，正文变化时哈希变化', () => {
    const parent = createTempDir()
    const skillDir = createSkill(parent, 'hash-skill')

    const first = discoverSkills('', [skillDir])[0]
    const second = discoverSkills('', [skillDir])[0]
    fs.appendFileSync(path.join(skillDir, 'SKILL.md'), '\n新增规则\n', 'utf8')
    const changed = discoverSkills('', [skillDir])[0]

    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(second.contentHash).toBe(first.contentHash)
    expect(changed.contentHash).not.toBe(first.contentHash)
    expect(first.ruleVersion).toBe(`sha256:${first.contentHash.slice(0, 12)}`)
    expect(first.contentLength).toBe(loadSkillContent(skillDir).length - '\n新增规则\n'.length)
  })

  it('保存前重新读取Skill并拒绝发现后发生的内容变化', () => {
    const parent = createTempDir()
    const skillDir = createSkill(parent, 'verified-skill')
    const discovered = discoverSkills('', [skillDir])[0]

    expect(loadVerifiedSkillBundle(discovered)).toEqual(expect.objectContaining({
      contentHash: discovered.contentHash,
      sourceDisplayName: 'verified-skill',
    }))
    fs.appendFileSync(path.join(skillDir, 'SKILL.md'), '\n发现后修改\n', 'utf8')
    expect(loadVerifiedSkillBundle(discovered)).toBeNull()
  })

  it('同一来源出现重复 ID 时保留先发现项并暴露冲突路径', () => {
    const firstParent = createTempDir()
    const secondParent = createTempDir()
    const firstSkill = createSkill(firstParent, 'duplicate-skill')
    const secondSkill = createSkill(secondParent, 'duplicate-skill')

    const skills = discoverSkills('', [firstParent, secondParent])

    expect(skills).toHaveLength(1)
    expect(skills[0].dirPath).toBe(firstSkill)
    expect(skills[0].integrity).toBe('conflict')
    expect(skills[0].conflictPaths).toEqual([firstSkill, secondSkill])
  })

  it('路径校验返回稳定错误码', () => {
    const parent = createTempDir()
    const filePath = path.join(parent, 'file.txt')
    fs.writeFileSync(filePath, 'content', 'utf8')

    expect(validateCustomPath(path.join(parent, 'missing'))).toMatchObject({ code: 'PATH_NOT_FOUND' })
    expect(validateCustomPath(filePath)).toMatchObject({ code: 'NOT_DIRECTORY' })
    expect(validateCustomPath(parent)).toEqual({ ok: true })
  })
})
