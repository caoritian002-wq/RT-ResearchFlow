import { Menu, app, BrowserWindow, shell } from 'electron'

export function buildChineseMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS app menu
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { label: '关于 ' + app.getName(), role: 'about' as const },
              { type: 'separator' as const },
              { label: '服务', role: 'services' as const },
              { type: 'separator' as const },
              { label: '隐藏 ' + app.getName(), role: 'hide' as const },
              { label: '隐藏其他', role: 'hideOthers' as const },
              { label: '全部显示', role: 'unhide' as const },
              { type: 'separator' as const },
              { label: '退出', role: 'quit' as const }
            ]
          }
        ]
      : []),

    // 文件
    {
      label: '文件',
      submenu: [
        {
          label: '立即扫描',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:triggerScan')
          }
        },
        { type: 'separator' },
        isMac
          ? { label: '关闭窗口', role: 'close' as const }
          : { label: '退出', role: 'quit' as const }
      ]
    },

    // 编辑
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' as const },
        { label: '重做', role: 'redo' as const },
        { type: 'separator' },
        { label: '剪切', role: 'cut' as const },
        { label: '复制', role: 'copy' as const },
        { label: '粘贴', role: 'paste' as const },
        { label: '全选', role: 'selectAll' as const }
      ]
    },

    // 视图
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' as const },
        { label: '强制重新加载', role: 'forceReload' as const },
        { label: '开发者工具', role: 'toggleDevTools' as const },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' as const },
        { label: '放大', role: 'zoomIn' as const },
        { label: '缩小', role: 'zoomOut' as const },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' as const }
      ]
    },

    // 窗口
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' as const },
        { label: '缩放', role: 'zoom' as const },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { label: '前置全部窗口', role: 'front' as const }
            ]
          : [{ label: '关闭', role: 'close' as const }])
      ]
    },

    // 帮助
    {
      label: '帮助',
      submenu: [
        {
          label: '项目主页',
          click: () => shell.openExternal('https://github.com')
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
