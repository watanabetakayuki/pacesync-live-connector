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
import { decodeWebcastResponse, decodeMessage } from './proto/decoder';

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
  private wsConnected = false;

  constructor(uniqueId: string, options: ConnectorOptions) {
    super();
    this.uniqueId = uniqueId.replace('@', '');
    this.options = {
      sessionId:       options.sessionId,
      targetIdc:       options.targetIdc ?? '',
      cdpPort:         options.cdpPort ?? 9222,
      reconnect:       options.reconnect ?? true,
      reconnectDelay:  options.reconnectDelay ?? 3000,
      pollingInterval: options.pollingInterval ?? 1000,
    };
  }

  async connect(): Promise<RoomInfo> {
    if (this.destroyed) throw new Error('このインスタンスは既に破棄されています');
    if (this.connected) throw new Error('既に接続中です');

    const roomInfo = await this.fetchRoomInfo();
    this.internalRoomId = roomInfo.roomId;

    if (roomInfo.status !== 4) {
      throw new Error(`ライブ配信中ではありません (status: ${roomInfo.status})`);
    }

    // まずHTTPポーリングでwsUrlを取得し、WebSocketに切り替える
    await this.initConnection();
    this.connected = true;
    this.emit('connect', this.internalRoomId);
    return roomInfo;
  }

  disconnect(): void {
    this.destroyed = true;
    this.cleanup();
    this.emit('disconnect', 'manual');
  }

  async refreshSession(): Promise<void> {
    const values = await refreshSessionFromChrome(this.options.cdpPort);
    this.options.sessionId = values.sessionId;
    this.options.targetIdc = values.targetIdc;
  }

  private async initConnection(): Promise<void> {
    const { wsUrl } = await this.fetchInitial();

    if (wsUrl) {
      this.connectWebSocket(wsUrl);
    } else {
      // wsUrlが取れなかった場合はポーリングにフォールバック
      this.startPolling();
    }
  }

  private async fetchInitial(): Promise<{ wsUrl: string | null }> {
    const params = new URLSearchParams({
      aid:       '1988',
      app_name:  'tiktok_web',
      room_id:   this.internalRoomId,
      cursor:    '',
      next_type: '2',
    });

    const buffer = await this.fetchBinary(
      `${WEBCAST_BASE}?${params}`,
      this.buildCookie()
    );

    if (!buffer.length) return { wsUrl: null };

    try {
      const response = await decodeWebcastResponse(buffer);
      if (response.cursor) this.cursor = response.cursor;
      await this.dispatchProtoMessages(response.messages);
      return { wsUrl: (response as any).wsUrl ?? null };
    } catch {
      try {
        const json = JSON.parse(buffer.toString('utf8'));
        if (json?.cursor) this.cursor = json.cursor;
        await this.dispatchJsonMessages(json?.data?.messages ?? []);
        return { wsUrl: json?.wsUrl ?? null };
      } catch {
        return { wsUrl: null };
      }
    }
  }

  private connectWebSocket(wsUrl: string): void {
    const url = new URL(wsUrl);
    url.searchParams.set('cursor', this.cursor);

    const ws = new WebSocket(url.toString(), {
      headers: {
        Cookie:     this.buildCookie(),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    this.ws = ws;

    ws.on('open', () => {
      this.wsConnected = true;
    });

    ws.on('message', async (data: Buffer) => {
      try {
        const response = await decodeWebcastResponse(data);
        if (response.cursor) this.cursor = response.cursor;
        await this.dispatchProtoMessages(response.messages);

        // ACK送信（TikTokサーバーが要求する場合）
        if ((response as any).needAck) {
          this.sendWebSocketAck(response.cursor);
        }
      } catch {
        // バイナリ解析失敗は無視
      }
    });

    ws.on('close', (code) => {
      this.wsConnected = false;
      this.ws = null;
      if (!this.destroyed) {
        this.handleDisconnect(`ws closed (code: ${code})`);
      }
    });

    ws.on('error', (err) => {
      this.emit('error', err);
      // エラー時はポーリングにフォールバック
      if (!this.destroyed && !this.wsConnected) {
        this.startPolling();
      }
    });
  }

  private sendWebSocketAck(cursor: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const ack = JSON.stringify({ cursor, internalExt: '' });
      this.ws.send(ack);
    }
  }

  private startPolling(): void {
    this.fetchMessages().catch(err => this.handleError(err));
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

    const buffer = await this.fetchBinary(
      `${WEBCAST_BASE}?${params}`,
      this.buildCookie()
    );

    if (!buffer.length) return;

    try {
      const response = await decodeWebcastResponse(buffer);
      if (response.cursor) this.cursor = response.cursor;
      await this.dispatchProtoMessages(response.messages);
    } catch {
      try {
        const json = JSON.parse(buffer.toString('utf8'));
        if (json?.cursor) this.cursor = json.cursor;
        await this.dispatchJsonMessages(json?.data?.messages ?? []);
      } catch { /* 無視 */ }
    }
  }

  private async dispatchProtoMessages(messages: { method: string; payload: Uint8Array }[]): Promise<void> {
    const ts = Date.now();
    for (const msg of messages) {
      try {
        const decoded = await decodeMessage(msg.method, msg.payload);
        if (decoded) this.emitFromDecoded(msg.method, decoded, ts);
      } catch { /* 個別エラーは無視 */ }
    }
  }

  private emitFromDecoded(method: string, d: any, ts: number): void {
    switch (method) {
      case 'WebcastChatMessage':
        this.emit('chat', {
          type: 'chat', user: this.parseUser(d.user),
          comment: d.comment ?? '', timestamp: ts,
        } satisfies ChatEvent);
        break;

      case 'WebcastGiftMessage':
        this.emit('gift', {
          type: 'gift', user: this.parseUser(d.user),
          giftId: d.giftId ?? 0, giftName: d.gift?.name ?? '',
          diamondCount: d.gift?.diamondCount ?? 0,
          repeatCount: d.repeatCount ?? 1, repeatEnd: d.repeatEnd === 1,
          timestamp: ts,
        } satisfies GiftEvent);
        break;

      case 'WebcastLikeMessage':
        this.emit('like', {
          type: 'like', user: this.parseUser(d.user),
          likeCount: Number(d.count ?? 0),
          totalLikeCount: Number(d.total ?? 0), timestamp: ts,
        } satisfies LikeEvent);
        break;

      case 'WebcastSocialMessage':
        if (d.displayType?.includes('follow')) {
          this.emit('follow', { type: 'follow', user: this.parseUser(d.user), timestamp: ts } satisfies FollowEvent);
        } else if (d.displayType?.includes('share')) {
          this.emit('share', { type: 'share', user: this.parseUser(d.user), timestamp: ts } satisfies ShareEvent);
        }
        break;

      case 'WebcastRoomUserSeqMessage':
        this.emit('viewer', {
          type: 'viewer', viewerCount: Number(d.viewerCount ?? 0), timestamp: ts,
        } satisfies ViewerEvent);
        break;

      case 'WebcastMemberMessage':
        if (d.actionId === 7) {
          this.emit('subscribe', { type: 'subscribe', user: this.parseUser(d.user), timestamp: ts } satisfies SubscribeEvent);
        }
        break;
    }
  }

  private async dispatchJsonMessages(messages: any[]): Promise<void> {
    const ts = Date.now();
    for (const msg of messages) {
      try { this.emitFromDecoded(msg.type, msg, ts); } catch { /* 無視 */ }
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

  private fetchBinary(url: string, cookie = ''): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...(cookie ? { Cookie: cookie, Referer: 'https://www.tiktok.com/' } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
  }

  private async fetchRoomInfo(): Promise<RoomInfo> {
    const buffer = await this.fetchBinary(
      `${TIKTOK_BASE}/@${this.uniqueId}/live`,
      this.buildCookie()
    );
    const text = buffer.toString('utf8');

    const roomIdMatch = text.match(/"roomId"\s*:\s*"(\d+)"/);
    const statusMatch = text.match(/"status"\s*:\s*(\d+)/);
    const titleMatch  = text.match(/"title"\s*:\s*"([^"]+)"/);
    const viewerMatch = text.match(/"userCount"\s*:\s*(\d+)/);

    if (!roomIdMatch) throw new Error(`roomIdが見つかりません: @${this.uniqueId}`);

    return {
      roomId:      roomIdMatch[1],
      status:      statusMatch  ? parseInt(statusMatch[1])  : 0,
      title:       titleMatch   ? titleMatch[1]             : '',
      viewerCount: viewerMatch  ? parseInt(viewerMatch[1])  : 0,
    };
  }

  private handleDisconnect(reason: string): void {
    this.connected = false;
    this.emit('disconnect', reason);
    if (this.options.reconnect && !this.destroyed) {
      this.reconnectTimer = setTimeout(() => {
        this.connect().catch(e => this.emit('error', e));
      }, this.options.reconnectDelay);
    }
  }

  private handleError(err: Error): void {
    this.emit('error', err);
    if (this.options.reconnect && !this.destroyed) {
      this.cleanup();
      this.handleDisconnect('error');
    }
  }

  private cleanup(): void {
    if (this.pollTimer)      { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws)             { this.ws.close(); this.ws = null; }
    this.wsConnected = false;
  }
}

export { TikTokLiveConnector };
