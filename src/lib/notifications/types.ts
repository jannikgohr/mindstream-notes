import type { Component } from 'svelte';

export type NotificationKind =
  | 'update'
  | 'collaboration-invite'
  | 'share-bundle'
  | 'generic'
  | 'sync-offline';
export type NotificationWidgetType =
  | 'update'
  | 'collaboration-invite'
  | 'share-bundle'
  | 'generic';

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

export interface CollaborationInviteNotificationData {
  invitationId: string;
  senderUsername: string | null;
  collectionUid: string;
  accessLevel: 'read_only' | 'read_write' | 'admin';
}

export interface ShareBundleNotificationData {
  manifestCollectionUid: string;
  // Null until the user accepts the manifest — its content (and thus the share
  // name) is only readable once they're a member. `pending` marks that state.
  name: string | null;
  pending: boolean;
  senderUsername: string | null;
  accessLevel: 'read_only' | 'read_write' | 'admin' | null;
  complete: boolean;
  warnings: string[];
}

export interface NotificationWidgetProps {
  notification: AppNotification;
  onClose?: () => void;
}

export type NotificationWidgetComponent = Component<NotificationWidgetProps>;
