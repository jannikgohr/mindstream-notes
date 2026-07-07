import type { Component } from 'svelte';

export type NotificationKind =
  | 'update'
  | 'collaboration-invite'
  | 'generic'
  | 'sync-offline';
export type NotificationWidgetType =
  | 'update'
  | 'collaboration-invite'
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

export interface NotificationWidgetProps {
  notification: AppNotification;
  onClose?: () => void;
}

export type NotificationWidgetComponent = Component<NotificationWidgetProps>;
