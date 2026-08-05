import { describe, expect, it } from 'vitest'
import {
  detailContentToText,
  extractDetailContent,
  normalizeDetailContentHtml,
} from '../../electron/main/services/detailContentExtraction'

describe('详情正文抽取', () => {
  it('按备用选择器抽取视频页并把脚本播放器转换为安全视频引用', () => {
    const html = `
      <html><body>
        <div class="video-content-left">
          <h1>视频新闻标题</h1>
          <div class="vertical-player">
            <img class="poster" src="/cover.png">
            <div class="vertical-player-cover"><img src="/cover.png"></div>
            <div class="vertical-video-player-wrapper"><div id="video-player"></div></div>
          </div>
          <div class="video-content-description">视频简介正文</div>
        </div>
        <script>
          var player = new Aliplayer({
            "id": "video-player",
            "source": "https://media.example.com/news.mp4",
            "cover": "https://media.example.com/cover.png"
          })
        </script>
      </body></html>
    `

    const result = extractDetailContent(
      html,
      '.detail-content|.video-content-left',
      'https://www.example.com/live/video-detail/1.html',
    )

    expect(result?.matchedSelector).toBe('.video-content-left')
    expect(result?.content).toContain('<video controls="" preload="metadata" playsinline="" poster="https://media.example.com/cover.png">')
    expect(result?.content).toContain('<source src="https://media.example.com/news.mp4" type="video/mp4">')
    expect(result?.content).toContain('打开视频原始地址')
    expect(result?.content).toContain('视频简介正文')
    expect(result?.content).not.toContain('vertical-player-cover')
    expect(detailContentToText(result?.content ?? '')).toContain('视频新闻标题')
  })

  it('规范化相对图片地址并移除非 HTTP 资源', () => {
    const normalized = normalizeDetailContentHtml(
      '<img src="/asset.png"><img src="javascript:alert(1)">',
      'https://www.example.com/news/1.html',
    )

    expect(normalized).toContain('src="https://www.example.com/asset.png"')
    expect(normalized).not.toContain('javascript:')
  })
})
