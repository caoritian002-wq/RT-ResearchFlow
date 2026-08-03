import React, { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface InfoTipProps {
  /** 气泡内显示的解释文字 */
  content: string
  /** 气泡弹出方向，默认 'top' */
  placement?: 'top' | 'bottom' | 'left' | 'right'
  /** 自定义触发元素；不传时默认显示 ⓘ */
  children?: React.ReactNode
}

/** 气泡相对触发器的偏移间距（px） */
const GAP = 8

/** 根据 placement 和触发器 DOMRect 计算气泡的 fixed 坐标及 transform */
function calcBubbleStyle(
  placement: NonNullable<InfoTipProps['placement']>,
  rect: DOMRect,
): React.CSSProperties {
  switch (placement) {
    case 'top':
      return {
        top: rect.top - GAP,
        left: rect.left + rect.width / 2,
        transform: 'translate(-50%, -100%)',
      }
    case 'bottom':
      return {
        top: rect.bottom + GAP,
        left: rect.left + rect.width / 2,
        transform: 'translate(-50%, 0)',
      }
    case 'left':
      return {
        top: rect.top + rect.height / 2,
        left: rect.left - GAP,
        transform: 'translate(-100%, -50%)',
      }
    case 'right':
      return {
        top: rect.top + rect.height / 2,
        left: rect.right + GAP,
        transform: 'translate(0, -50%)',
      }
  }
}

/** 三角箭头的 Tailwind 类：指向触发器一侧 */
const ARROW_CLASS: Record<NonNullable<InfoTipProps['placement']>, string> = {
  top: 'top-full left-1/2 -translate-x-1/2 border-t-white dark:border-t-slate-800',
  bottom: 'bottom-full left-1/2 -translate-x-1/2 border-b-white dark:border-b-slate-800',
  left: 'left-full top-1/2 -translate-y-1/2 border-l-white dark:border-l-slate-800',
  right: 'right-full top-1/2 -translate-y-1/2 border-r-white dark:border-r-slate-800',
}

/**
 * 术语悬停解释气泡组件。
 * 触发器为 ⓘ 字符，hover 时弹出说明气泡。
 * 使用 ReactDOM.createPortal 渲染到 document.body，fixed 定位，
 * 彻底规避父级 overflow:hidden/scroll 容器的裁剪问题。
 */
export default function InfoTip({ content, placement = 'top', children }: InfoTipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const [bubbleStyle, setBubbleStyle] = useState<React.CSSProperties | null>(null)

  const handleMouseEnter = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setBubbleStyle(calcBubbleStyle(placement, rect))
  }, [placement])

  const handleMouseLeave = useCallback(() => {
    setBubbleStyle(null)
  }, [])

  return (
    <>
      <span
        ref={triggerRef}
        className="inline-block leading-none"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocus={handleMouseEnter}
        onBlur={handleMouseLeave}
      >
        {children ?? (
          <span
            className="inline-block cursor-help select-none text-slate-400 transition-colors hover:text-blue-500"
            aria-label={content}
          >
            ⓘ
          </span>
        )}
      </span>

      {bubbleStyle !== null &&
        createPortal(
          <span
            style={{ position: 'fixed', zIndex: 9999, pointerEvents: 'none', ...bubbleStyle }}
            className="w-56 rounded-lg bg-white p-2 shadow-lg text-xs leading-relaxed text-slate-700 dark:bg-slate-800 dark:text-slate-200 whitespace-pre-line"
            role="tooltip"
          >
            {content}
            {/* 三角箭头 */}
            <span className={`absolute h-0 w-0 border-4 border-transparent ${ARROW_CLASS[placement]}`} />
          </span>,
          document.body,
        )}
    </>
  )
}
