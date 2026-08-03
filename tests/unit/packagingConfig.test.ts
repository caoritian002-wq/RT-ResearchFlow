import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

interface PackagingConfig {
  productName: string
  npmRebuild: boolean
  directories: { buildResources: string; output: string }
  nsis: {
    oneClick: boolean
    perMachine: boolean
    selectPerMachineByDefault: boolean
    allowToChangeInstallationDirectory: boolean
    deleteAppDataOnUninstall: boolean
    include: string
  }
}

const config = require('../../electron-builder.js') as PackagingConfig
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('Windows 打包配置', () => {
  it('发布脚本显式加载可在 Windows 使用的 JS 配置', () => {
    expect(packageJson.scripts.dist).toContain('--config electron-builder.js')
    expect(packageJson.scripts['dist:win']).toContain('--config electron-builder.js')
    expect(packageJson.scripts['dist:win']).not.toContain('scripts/prepare-dist.js')
    expect(packageJson.scripts.postinstall).toBe('electron-builder install-app-deps')
    expect(config.npmRebuild).toBe(false)
    expect(config.productName).toBe('RT-ResearchFlow')
    expect(config.directories.output).toBe('release')
  })

  it('使用可选目录的辅助安装并默认保留数据', () => {
    expect(config.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      selectPerMachineByDefault: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
      include: 'resources/installer.nsh',
    })
  })

  it('NSIS 宏在删除程序前保护 data 并让删除数据保持显式选择', () => {
    const include = readFileSync(join(__dirname, '../../resources/installer.nsh'), 'utf8')
    expect(include).toContain('!macro customRemoveFiles')
    expect(include).toContain('Rename "$INSTDIR\\data" "$INSTDIR.__trade_watch_data_preserved"')
    expect(include).toContain('Rename "$INSTDIR.__trade_watch_data_preserved" "$INSTDIR\\data"')
    expect(include).toContain('MB_DEFBUTTON2')
    expect(include).toContain('${ifNot} ${Silent}')
  })
})
