import type { Component } from 'svelte';
import type { UserKey } from '$lib/api/sharing';

export type NotificationKind =
  | 'update'
  | 'share-invite'
  | 'generic'
  | 'sync-offline'
  | 'session-ended'
  | 'sync-limit'
  | 'plugin-gated'
  | 'plugin-new';
export type NotificationWidgetType = 'update' | 'share-invite' | 'generic';

export interface AppNotification<TData = unknown> {
  id: string;
  kind: NotificationKind;
  widgetType: NotificationWidgetType;
  createdAt: number;
  data: TData;
  onOpen?: () => void | Promise<void>;
}

export interface UpdateNotificationData {
  version: string;
  currentVersion: string;
}

/** An invitation to a shared folder that waits for an answer. */
export interface ShareInviteNotificationData {
  invitationId: string;
  collectionUid: string;
  // The folder's name, which comes with the invitation. Null only when the
  // server did not send it along.
  name: string | null;
  senderUsername: string | null;
  accessLevel: 'read_only' | 'read_write' | 'admin';
  // The sender's key, held against the one this device remembers for them.
  // Null when the invitation names no sender.
  senderKey: UserKey | null;
}

export interface NotificationWidgetProps {
  notification: AppNotification;
  onClose?: () => void;
}

export type NotificationWidgetComponent = Component<NotificationWidgetProps>;
