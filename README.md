# @shibusawa/pacesync-live-connector

A TypeScript-first TikTok LIVE event connector — receive real-time chat, gifts, likes, and more with automatic session refresh and content restriction detection.

## Features

- **Real-time events**: chat, gifts, likes, follows, shares, viewers, subscriptions
- **Content restriction detection**: AGE_GATE / SUBSCRIPTION / REGION_BLOCK / PRIVATE を自動分類
- **Auto session refresh**: Chrome CDP経由でsessionidを自動取得・更新
- **Auto reconnect**: 切断時に自動再接続
- **TypeScript**: 完全な型定義付き
- **Robust avatar extraction**: 7パターンのフォールバックでアイコンURLを確実に取得

## Installation

```bash
npm install @shibusawa/pacesync-live-connector
```

## Quick Start

```typescript
import { TikTokLiveConnector } from '@shibusawa/pacesync-live-connector';

const connector = new TikTokLiveConnector('tiktok_username', {
  sessionId: process.env.TIKTOK_SESSION_ID!,
  targetIdc: process.env.TIKTOK_TARGET_IDC,   // optional
});

// チャットを受信
connector.on('chat', (event) => {
  console.log(`${event.user.nickname}: ${event.comment}`);
  console.log(`アイコン: ${event.user.profilePictureUrl}`);
});

// ギフトを受信
connector.on('gift', (event) => {
  console.log(`🎁 ${event.user.nickname} → ${event.giftName} x${event.repeatCount}`);
});

// いいねを受信
connector.on('like', (event) => {
  console.log(`❤️ ${event.user.nickname} (+${event.likeCount})`);
});

// 視聴者数が更新されたとき
connector.on('viewer', (event) => {
  console.log(`👁 視聴者数: ${event.viewerCount}`);
});

// コンテンツ制限を検知したとき
connector.on('restriction', (restriction) => {
  console.log(`🔒 ${restriction.label} (突破可能: ${restriction.bypassable})`);
});

connector.on('connect',    (roomId) => console.log('接続完了:', roomId));
connector.on('disconnect', (reason) => console.log('切断:', reason));
connector.on('error',      (err)    => console.error('エラー:', err));

// 接続
const roomInfo = await connector.connect();
console.log(`配信タイトル: ${roomInfo.title}`);
```

## Getting your sessionId

TikTokのsessionidは、Chromeでログイン済みの状態からCDP経由で自動取得できます:

```bash
# Chrome を デバッグポート付きで起動（既存のChromeを全て閉じてから実行）
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

```typescript
import { refreshSessionFromChrome } from '@shibusawa/pacesync-live-connector';

const { sessionId, targetIdc } = await refreshSessionFromChrome(9222);
// → sessionId, targetIdc を .env に保存して使う
```

または接続中にセッションが切れた場合:

```typescript
await connector.refreshSession();
```

## Content Restriction Detection

接続前にコンテンツ制限を自動検知します:

```typescript
connector.on('restriction', (r) => {
  // r.type: 'AGE_GATE' | 'SUBSCRIPTION' | 'REGION_BLOCK' | 'PRIVATE' | 'UNKNOWN'
  // r.bypassable: true なら sessionId で突破を試みる
  // r.label: '年齢制限 (18+)' など
  // r.apiStatusCode: 4003110 など
  if (!r.bypassable) {
    console.log(`接続不可: ${r.label}`);
  }
});
```

| type | 意味 | 突破可能 |
|------|------|---------|
| `AGE_GATE` | 年齢制限 (18+) | ✅ sessionIdで突破 |
| `PRIVATE` | 非公開アカウント | ❌ |
| `REGION_BLOCK` | 地域制限 | ❌ |
| `SUBSCRIPTION` | サブスク限定 | ❌ |

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `chat` | `ChatEvent` | チャットメッセージ |
| `gift` | `GiftEvent` | ギフト送信 |
| `like` | `LikeEvent` | いいね |
| `follow` | `FollowEvent` | フォロー |
| `share` | `ShareEvent` | シェア |
| `viewer` | `ViewerEvent` | 視聴者数更新 |
| `subscribe` | `SubscribeEvent` | サブスクリプション |
| `restriction` | `ContentRestriction` | コンテンツ制限検知 |
| `connect` | `roomId: string` | 接続完了 |
| `disconnect` | `reason: string` | 切断 |
| `error` | `Error` | エラー |

## vs TikTok-Live-Connector (zerodytrash)

| | zerodytrash | @shibusawa/pacesync-live-connector |
|---|---|---|
| 言語 | JavaScript | **TypeScript** |
| コンテンツ制限分類 | ❌ | ✅ AGE_GATE / SUBSCRIPTION 等 |
| Chrome CDP セッション取得 | ❌ | ✅ 自動取得 |
| アイコンURL抽出 | 基本のみ | ✅ 7パターンフォールバック |
| 自動再接続 | △ | ✅ |

## PaceSync との連携

このライブラリは [PaceSync](https://app.paceshinc.com) — TikTok LIVE 配信者向けダッシュボードのコアコネクターとして使われています。

年齢制限のある配信アカウントでも弾幕・コメントを取得し続けるための SESSION_ID 管理ツールも同梱しています:

```bash
# Chrome CDP 経由で sessionid を取得し、PaceSync 本番サーバーを自動更新
node scripts/refresh-tiktok-session.js --room your_tiktok_username
```

環境変数でサーバーをカスタマイズ可能:

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `PACESYNC_API_URL` | `https://app.paceshinc.com` | PaceSync サーバー URL |
| `PROD_HOST` | `prod-aws` | SSH ホスト名 |
| `PROD_DIR` | `/home/ubuntu/pace-sync` | サーバー上のディレクトリ |
| `CDP_PORT` | `9222` | Chrome CDP ポート |

## License

MIT
