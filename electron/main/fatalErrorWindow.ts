import { app, BrowserWindow } from 'electron'

interface FatalErrorWindowOptions {
  title: string
  message: string
  details?: string
}

let fatalWindow: BrowserWindow | null = null

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function buildFatalErrorHtml({ title, message, details }: FatalErrorWindowOptions): string {
  const safeTitle = escapeHtml(title)
  const safeMessage = escapeHtml(message)
  const safeDetails = details ? escapeHtml(details) : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>${safeTitle}</title>
  <style>
    :root { color-scheme: light dark; font-family: "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; overflow: hidden; background: #f8fafc; color: #0f172a; }
    .shell { min-height: 100vh; display: grid; grid-template-rows: 40px 1fr; }
    .titlebar { -webkit-app-region: drag; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #e2e8f0; background: #fff; padding-left: 16px; }
    .brand { display: flex; align-items: center; gap: 9px; font-size: 12px; font-weight: 650; color: #334155; }
    .brand-mark { width: 8px; height: 8px; border-radius: 2px; background: #0891b2; box-shadow: 12px 0 0 #0f766e; }
    .close { -webkit-app-region: no-drag; display: flex; width: 46px; height: 40px; align-items: center; justify-content: center; border: 0; background: transparent; color: #64748b; font-size: 20px; cursor: pointer; text-decoration: none; }
    .close:hover, .close:focus-visible { background: #fee2e2; color: #b91c1c; outline: none; }
    main { position: relative; display: grid; place-items: center; padding: 32px; }
    main::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: #dc2626; }
    .content { width: min(100%, 560px); }
    .eyebrow { margin: 0 0 10px; color: #dc2626; font-size: 11px; font-weight: 700; }
    h1 { margin: 0; font-size: 24px; line-height: 1.3; font-weight: 680; }
    .message { margin: 14px 0 0; color: #475569; font-size: 14px; line-height: 1.75; }
    .details { margin: 20px 0 0; max-height: 150px; overflow: auto; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; padding: 12px; color: #475569; font: 12px/1.65 Consolas, monospace; white-space: pre-wrap; word-break: break-word; user-select: text; }
    .actions { display: flex; justify-content: flex-end; margin-top: 24px; }
    .exit { display: inline-flex; min-width: 108px; height: 44px; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: #b91c1c; color: #fff; padding: 0 18px; font-size: 14px; font-weight: 650; cursor: pointer; text-decoration: none; }
    .exit:hover { background: #991b1b; }
    .exit:focus-visible { outline: 3px solid rgba(220, 38, 38, .28); outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      body { background: #020617; color: #f8fafc; }
      .titlebar { border-color: #1e293b; background: #0f172a; }
      .brand { color: #cbd5e1; }
      .message { color: #cbd5e1; }
      .details { border-color: #334155; background: #0f172a; color: #cbd5e1; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="titlebar">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>RT-AI 投研小助手</span></div>
      <a class="close" aria-label="退出应用" href="trade-watch-fatal://exit">×</a>
    </header>
    <main>
      <section class="content" role="alert" aria-labelledby="fatal-title">
        <p class="eyebrow">启动诊断</p>
        <h1 id="fatal-title">${safeTitle}</h1>
        <p class="message">${safeMessage}</p>
        ${safeDetails ? `<pre class="details">${safeDetails}</pre>` : ''}
        <div class="actions"><a class="exit" href="trade-watch-fatal://exit">退出应用</a></div>
      </section>
    </main>
  </div>
</body>
</html>`
}

export function showFatalErrorWindow(options: FatalErrorWindowOptions): BrowserWindow {
  if (fatalWindow && !fatalWindow.isDestroyed()) {
    fatalWindow.focus()
    return fatalWindow
  }

  fatalWindow = new BrowserWindow({
    width: 680,
    height: 480,
    minWidth: 560,
    minHeight: 400,
    title: options.title,
    frame: false,
    show: false,
    backgroundColor: '#f8fafc',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  fatalWindow.once('ready-to-show', () => fatalWindow?.show())
  fatalWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== 'trade-watch-fatal://exit') return
    event.preventDefault()
    fatalWindow?.close()
  })
  fatalWindow.on('closed', () => {
    fatalWindow = null
    app.exit(1)
  })
  void fatalWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildFatalErrorHtml(options))}`)
  return fatalWindow
}
