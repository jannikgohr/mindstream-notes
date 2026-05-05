import {emit as tauriEmit, listen as tauriListen} from '@tauri-apps/api/event'


export type TauriEvents = {
    'fullscreen-note': {noteId: string, title: string}
}

export function emit<K extends keyof TauriEvents>(
    event: K,
    payload: TauriEvents[K]
) {
    return tauriEmit(event, payload)
}

export function listen<K extends keyof TauriEvents>(
    event: K,
    handler: (payload: TauriEvents[K]) => void
) {
    return tauriListen(event, (e) => handler(e.payload as TauriEvents[K]))
}