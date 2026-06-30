/**
 * chatイベント受信テスト — 配信中アカウントに接続してコメントをリアルタイム表示
 * node test-chat.mjs
 */
import https from 'https';

const UNIQUE_ID  = process.argv[2] ?? 'urielwq';
const SESSION_ID = process.env.TIKTOK_SESSION_ID ?? '';
const TARGET_IDC = process.env.TIKTOK_TARGET_IDC ?? '';

if (!SESSION_ID) {
  console.error('❌ TIKTOK_SESSION_ID が未設定');
  process.exit(1);
}

const cookie = `sessionid=${SESSION_ID}${TARGET_IDC ? `; tt-target-idc=${TARGET_IDC}` : ''}`;

function fetchBinary(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Cookie: cookie,
        Referer: 'https://www.tiktok.com/',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// Step1: roomId取得
console.log(`\n🔍 @${UNIQUE_ID} のroomIdを取得中...`);
const html = (await fetchBinary(`https://www.tiktok.com/@${UNIQUE_ID}/live`)).toString('utf8');

const roomId = html.match(/"roomId"\s*:\s*"(\d+)"/)?.[1];
const status = html.match(/"status"\s*:\s*(\d+)/)?.[1];
const title  = html.match(/"title"\s*:\s*"([^"]+)"/)?.[1];

if (!roomId) {
  console.error('❌ roomIdが見つかりません。配信中か確認してください');
  process.exit(1);
}

console.log(`✅ roomId: ${roomId}`);
console.log(`   status: ${status} ${status === '4' ? '(配信中🔴)' : '(配信中でない可能性)'}`);
console.log(`   title:  ${title ?? '不明'}`);
console.log(`\n💬 コメント受信中... (Ctrl+C で終了)\n`);

// Step2: ポーリングでメッセージ取得
let cursor = '';
let msgCount = 0;

async function poll() {
  const params = new URLSearchParams({
    aid: '1988', app_name: 'tiktok_web',
    room_id: roomId, cursor, next_type: '2',
  });

  const buf = await fetchBinary(`https://webcast.tiktok.com/webcast/im/fetch/?${params}`);
  if (!buf.length) return;

  // JSONとして解釈を試みる
  try {
    const json = JSON.parse(buf.toString('utf8'));
    if (json?.cursor) cursor = json.cursor;

    const messages = json?.data?.messages ?? [];
    for (const msg of messages) {
      const ts = new Date().toLocaleTimeString('ja-JP');
      switch (msg.type) {
        case 'WebcastChatMessage':
          msgCount++;
          console.log(`[${ts}] 💬 ${msg.user?.nickname ?? '?'}: ${msg.comment}`);
          break;
        case 'WebcastGiftMessage':
          console.log(`[${ts}] 🎁 ${msg.user?.nickname ?? '?'} → ${msg.gift?.name ?? 'ギフト'} x${msg.repeatCount}`);
          break;
        case 'WebcastLikeMessage':
          process.stdout.write(`❤️  `);
          break;
        case 'WebcastSocialMessage':
          if (msg.displayType?.includes('follow'))
            console.log(`[${ts}] 👤 ${msg.user?.nickname ?? '?'} がフォローしました`);
          break;
        case 'WebcastRoomUserSeqMessage':
          process.stdout.write(`\r👁 視聴者: ${msg.viewerCount}  `);
          break;
      }
    }
  } catch {
    // Protobufバイナリ — 現段階では表示のみ
    console.log(`📦 Protobufバイナリ受信: ${buf.length} bytes`);
  }
}

// 1秒ごとにポーリング
setInterval(() => poll().catch(() => {}), 1000);
await poll();
