/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.tradewatcher.app',
  productName: 'RT-ResearchFlow',
  directories: {
    buildResources: 'resources',
    output: 'release'
  },
  files: [
    'out/**/*',
    '!out/**/*.map',
    'node_modules/better-sqlite3/build/Release/*.node'
  ],
  extraResources: [
    {
      from: 'skills',
      to: 'skills',
      filter: ['**/*']
    },
    {
      from: 'out/research-access',
      to: 'research-access',
      filter: ['**/*']
    }
  ],
  // postinstall rebuilds native modules once; packaging reuses that verified Electron ABI output.
  npmRebuild: false,
  win: {
    icon: 'icon.ico',
    artifactName: '${productName}-Setup-${version}-${arch}.${ext}',
    target: [{ target: 'nsis', arch: ['x64'] }]
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    selectPerMachineByDefault: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    include: 'resources/installer.nsh'
  },
  publish: null
}

module.exports = config
