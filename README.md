# pacesync-live-connector

A high-performance TikTok LIVE event connector for PaceSync — receive real-time chat, gifts, and viewer events with automatic session refresh.

## Features

- **Real-time events**: chat, gifts, likes, follows, shares, viewers, subscriptions
- **Auto session refresh**: Chrome CDP経由でsessionidを自動取得・更新
- **Auto reconnect**: 切断時に自動再接続
- **TypeScript**: 完全な型定義付き
- **Zero credentials required**: sessionidのみで動作（公式APIキー不要）

## Status

✅ **動作確認済み** (2026-06-30) — roomId取得・Webcastエンドポイント接続を確認

## Installation

```bash
npm install pacesync-live-connector
```

## Quick Start

```typescript
import { TikTokLiveConnector } from 'pacesync-live-connector';

const connector = new TikTokLiveConnector('your_tiktok_username', {
  sessionId: process.env.TIKTOK_SESSION_ID!,
  targetIdc: process.env.TIKTOK_TARGET_IDC,
});

connector.on('chat', (event) => {
  console.log(`${event.user.nickname}: ${event.comment}`);
});

connector.on('gift', (event) => {
  console.log(`${event.user.nickname} sent ${event.giftName} x${event.repeatCount}`);
});

connector.on('viewer', (event) => {
  console.log(`Viewers: ${event.viewerCount}`);
});

connector.on('error', (err) => {
  console.error('Error:', err);
});

connector.on('disconnect', (reason) => {
  console.log('Disconnected:', reason);
});

// ライブ配信に接続
const roomInfo = await connector.connect();
console.log(`Connected to: ${roomInfo.title}`);
```

## Session Refresh

sessionidが失効した場合、Chrome CDP経由で自動更新できます:

```typescript
// Chromeを --remote-debugging-port=9222 で起動してTikTokにログインした状態で実行
await connector.refreshSession();
```

または手動で更新:

```typescript
import { refreshSessionFromChrome } from 'pacesync-live-connector';

const { sessionId, targetIdc } = await refreshSessionFromChrome(9222);
```

## Events

| Event | Payload | Description |
|---|---|---|
| `chat` | `ChatEvent` | チャットメッセージ |
| `gift` | `GiftEvent` | ギフト |
| `like` | `LikeEvent` | いいね |
| `follow` | `FollowEvent` | フォロー |
| `share` | `ShareEvent` | シェア |
| `viewer` | `ViewerEvent` | 視聴者数更新 |
| `subscribe` | `SubscribeEvent` | サブスクリプション |
| `connect` | `roomId: string` | 接続完了 |
| `disconnect` | `reason: string` | 切断 |
| `error` | `Error` | エラー |

## vs TikTok-Live-Connector

| | TikTok-Live-Connector | pacesync-live-connector |
|---|---|---|
| セッション管理 | 手動 | Chrome CDP自動取得 |
| TypeScript | ❌ | ✅ |
| 自動再接続 | △ | ✅ |
| PaceSync統合 | ❌ | ✅ |

## License

MIT
