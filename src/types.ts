export interface ConnectorOptions {
  sessionId: string;
  targetIdc?: string;
  /** Chrome CDP port for auto session refresh (default: 9222) */
  cdpPort?: number;
  /** Auto reconnect on disconnect (default: true) */
  reconnect?: boolean;
  /** Reconnect delay in ms (default: 3000) */
  reconnectDelay?: number;
  /** Request polling interval in ms (default: 1000) */
  pollingInterval?: number;
}

export interface TikTokUser {
  userId: string;
  uniqueId: string;
  nickname: string;
  profilePictureUrl?: string;
  followRole?: number;
}

export interface ChatEvent {
  type: 'chat';
  user: TikTokUser;
  comment: string;
  timestamp: number;
}

export interface GiftEvent {
  type: 'gift';
  user: TikTokUser;
  giftId: number;
  giftName: string;
  diamondCount: number;
  repeatCount: number;
  repeatEnd: boolean;
  timestamp: number;
}

export interface LikeEvent {
  type: 'like';
  user: TikTokUser;
  likeCount: number;
  totalLikeCount: number;
  timestamp: number;
}

export interface FollowEvent {
  type: 'follow';
  user: TikTokUser;
  timestamp: number;
}

export interface ShareEvent {
  type: 'share';
  user: TikTokUser;
  timestamp: number;
}

export interface ViewerEvent {
  type: 'viewer';
  viewerCount: number;
  timestamp: number;
}

export interface SubscribeEvent {
  type: 'subscribe';
  user: TikTokUser;
  timestamp: number;
}

export interface ConnectEvent {
  type: 'connect';
  roomId: string;
  timestamp: number;
}

export interface DisconnectEvent {
  type: 'disconnect';
  reason: string;
  timestamp: number;
}

export interface ErrorEvent {
  type: 'error';
  error: Error;
  timestamp: number;
}

export type LiveEvent =
  | ChatEvent
  | GiftEvent
  | LikeEvent
  | FollowEvent
  | ShareEvent
  | ViewerEvent
  | SubscribeEvent
  | ConnectEvent
  | DisconnectEvent
  | ErrorEvent;

export interface RoomInfo {
  roomId: string;
  status: number;
  title: string;
  viewerCount: number;
}
