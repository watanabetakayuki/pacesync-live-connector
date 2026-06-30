import { EventEmitter } from 'events';
import https from 'https';
import WebSocket from 'ws';
import {
  ConnectorOptions,
  ChatEvent,
  GiftEvent,
  LikeEvent,
  FollowEvent,
  ShareEvent,
  ViewerEvent,
  SubscribeEvent,
  RoomInfo,
} from './types';
import { refreshSessionFromChrome } from './session';

const WEBCAST_BASE = 'https://webcast.tiktok.com/webcast/im/fetch/';
const TIKTOK_BASE  = 'https://www.tiktok.com';

export interface TikTokLiveConnectorEvents {
  chat:       (event: ChatEvent) => void;
  gift:       (event: GiftEvent) => void;
  like:       (event: LikeEvent) => void;
  follow:     (event: FollowEvent) => void;
  share:      (event: ShareEvent) => void;
  viewer:     (event: ViewerEvent) => void;
  subscribe:  (event: SubscribeEvent) => void;
  connect:    (roomId: string) => void;
  disconnect: (reason: string) => void;
  error:      (err: Error) => void;
}

declare interface TikTokLiveConnector {
  on<K extends keyof TikTokLiveConnectorEvents>(event: K, listener: TikTokLiveConnectorEvents[K]): this;
  emit<K extends keyof TikTokLiveConnectorEvents>(event: K, ...args: Parameters<TikTokLiveConnectorEvents[K]>): boolean;
}

class TikTokLiveConnector extends EventEmitter {
  private uniqueId: string;
  private options: Required<ConnectorOptions>;
  private ws: WebSocket | null = null;
  private cursor = '';
  private internalRoomId = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private destroyed = false;

  constructor(uniqueId: string, options: ConnectorOptions) {
    super();
    this.uniqueId = uniqueId.replace('@', '');
    this.options = {
      sessionId:        options.sessionId,
      targetIdc:        options.targetIdc ?? '',
      cdpPort:          options.cdpPort ?? 9222,
      reconnect:        options.reconnect ?? true,
      reconnectDelay:   options.reconnectDelay ?? 3000,
      pollingInterval:  options.pollingInterval ?? 1000,
    };
  }

  /** ライブ接続を開始する */
  async connect(): Promise<RoomInfo> {
    if (this.destroyed) throw new Error('このインスタンスは既に破棄されています');
    if (this.connected) throw new Error('既に接続中です');

    const roomInfo = await this.fetchRoomInfo();
    this.internalRoomId = roomInfo.roomId;

    if (roomInfo.status !== 4) {
      throw new Error(`ライブ配信中ではありません (status: ${roomInfo.status})`);
    }

    await this.startPolling();
    this.connected = true;
    this.emit('connect', this.internalRoomId);
    return roomInfo;
  }

  /** 切断してリソースを解放する */
  disconnect(): void {
    this.destroyed = true;
    this.cleanup();
    this.emit('disconnect', 'manual');
  }

  /** sessionidをChromeから自動更新する */
  async refreshSession(): Promise<void> {
    const values = await refreshSessionFromChrome(this.options.cdpPort);
    this.options.sessionId = values.sessionId;
    this.options.targetIdc = values.targetIdc;
  }

  private async fetchRoomInfo(): Promise<RoomInfo> {
    const url = `${TIKTOK_BASE}/@${this.uniqueId}/live`;
    const html = await this.fetchHtml(url);

    const roomIdMatch = html.match(/"roomId"\s*:\s*"(\d+)"/);
    const statusMatch = html.match(/"status"\s*:\s*(\d+)/);
    const titleMatch  = html.match(/"title"\s*:\s*"([^"]+)"/);
    const viewerMatch = html.match(/"userCount"\s*:\s*(\d+)/);

    if (!roomIdMatch) {
      throw new Error(`roomIdが見つかりません: @${this.uniqueId}`);
    }

    return {
      roomId:      roomIdMatch[1],
      status:      statusMatch  ? parseInt(statusMatch[1])  : 0,
      title:       titleMatch   ? titleMatch[1]             : '',
      viewerCount: viewerMatch  ? parseInt(viewerMatch[1])  : 0,
    };
  }

  private async startPolling(): Promise<void> {
    await this.fetchMessages();
    this.pollTimer = setInterval(
      () => this.fetchMessages().catch(err => this.handleError(err)),
      this.options.pollingInterval
    );
  }

  private async fetchMessages(): Promise<void> {
    const params = new URLSearchParams({
      aid:       '1988',
      app_name:  'tiktok_web',
      room_id:   this.internalRoomId,
      cursor:    this.cursor,
      next_type: '2',
    });

    const url = `${WEBCAST_BASE}?${params}`;
    const cookie = this.buildCookie();
    const raw = await this.fetchJson(url, cookie);

    if (!raw?.data) return;

    this.cursor = raw.cursor ?? this.cursor;
    this.dispatchMessages(raw.data.messages ?? []);
  }

  private dispatchMessages(messages: any[]): void {
    const ts = Date.now();
    for (const msg of messages) {
      try {
        switch (msg.type) {
          case 'WebcastChatMessage':
            this.emit('chat', {
              type:      'chat',
              user:      this.parseUser(msg.user),
              comment:   msg.comment ?? '',
              timestamp: ts,
            } satisfies ChatEvent);
            break;

          case 'WebcastGiftMessage':
            this.emit('gift', {
              type:         'gift',
              user:         this.parseUser(msg.user),
              giftId:       msg.giftId ?? 0,
              giftName:     msg.gift?.name ?? '',
              diamondCount: msg.gift?.diamondCount ?? 0,
              repeatCount:  msg.repeatCount ?? 1,
              repeatEnd:    msg.repeatEnd === 1,
              timestamp:    ts,
            } satisfies GiftEvent);
            break;

          case 'WebcastLikeMessage':
            this.emit('like', {
              type:           'like',
              user:           this.parseUser(msg.user),
              likeCount:      msg.count ?? 0,
              totalLikeCount: msg.total ?? 0,
              timestamp:      ts,
            } satisfies LikeEvent);
            break;

          case 'WebcastSocialMessage':
            if (msg.displayType?.includes('follow')) {
              this.emit('follow', {
                type:      'follow',
                user:      this.parseUser(msg.user),
                timestamp: ts,
              } satisfies FollowEvent);
            } else if (msg.displayType?.includes('share')) {
              this.emit('share', {
                type:      'share',
                user:      this.parseUser(msg.user),
                timestamp: ts,
              } satisfies ShareEvent);
            }
            break;

          case 'WebcastRoomUserSeqMessage':
            this.emit('viewer', {
              type:        'viewer',
              viewerCount: msg.viewerCount ?? 0,
              timestamp:   ts,
            } satisfies ViewerEvent);
            break;

          case 'WebcastMemberMessage':
            if (msg.actionId === 7) {
              this.emit('subscribe', {
                type:      'subscribe',
                user:      this.parseUser(msg.user),
                timestamp: ts,
              } satisfies SubscribeEvent);
            }
            break;
        }
      } catch {
        // 個別メッセージのパースエラーは無視して継続
      }
    }
  }

  private parseUser(raw: any) {
    return {
      userId:            String(raw?.id ?? ''),
      uniqueId:          raw?.uniqueId ?? '',
      nickname:          raw?.nickname ?? '',
      profilePictureUrl: raw?.avatarThumb?.urlList?.[0],
      followRole:        raw?.followInfo?.followStatus,
    };
  }

  private buildCookie(): string {
    const parts = [`sessionid=${this.options.sessionId}`];
    if (this.options.targetIdc) parts.push(`tt-target-idc=${this.options.targetIdc}`);
    return parts.join('; ');
  }

  private fetchHtml(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const opts = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Cookie: this.buildCookie(),
        },
      };
      https.get(url, opts, (res) => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }

  private fetchJson(url: string, cookie: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const opts = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Cookie: cookie,
          Referer: 'https://www.tiktok.com/',
        },
      };
      https.get(url, opts, (res) => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(null); }
        });
      }).on('error', reject);
    });
  }

  private handleError(err: Error): void {
    this.emit('error', err);
    if (this.options.reconnect && !this.destroyed) {
      this.cleanup();
      this.connected = false;
      this.emit('disconnect', 'error');
      this.reconnectTimer = setTimeout(() => {
        this.connect().catch(e => this.emit('error', e));
      }, this.options.reconnectDelay);
    }
  }

  private cleanup(): void {
    if (this.pollTimer)     { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.reconnectTimer){ clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws)            { this.ws.close(); this.ws = null; }
  }
}

export { TikTokLiveConnector };
