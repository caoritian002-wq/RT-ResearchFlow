import type { AppToastTone } from './AppToast'

export interface AppToastMessage {
  message: string
  tone: AppToastTone
}

const APP_TOAST_EVENT = 'trade-watch:app-toast'

export function publishAppToast(message: string, tone: AppToastTone = 'info'): void {
  window.dispatchEvent(new CustomEvent<AppToastMessage>(APP_TOAST_EVENT, {
    detail: { message, tone },
  }))
}

export function subscribeAppToast(listener: (toast: AppToastMessage) => void): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<AppToastMessage>).detail)
  }
  window.addEventListener(APP_TOAST_EVENT, handler)
  return () => window.removeEventListener(APP_TOAST_EVENT, handler)
}
