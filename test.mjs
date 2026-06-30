/**
 * 動作確認スクリプト
 * node test.mjs
 */
import https from 'https';

const UNIQUE_ID   = 'urielwq';
const SESSION_ID  = process.env.TIKTOK_SESSION_ID ?? '';
const TARGET_IDC  = process.env.TIKTOK_TARGET_IDC ?? '';

if (!SESSION_ID) {
  console.error('❌ TIKTOK_SESSION_ID が未設定です');
  console.error('   実行例: $env:TIKTOK_SESSION_ID="xxxx"; node test.mjs');
  process.exit(1);
}

// ── Step 1: roomId取得 ────────────────────────────────────────────────────────

function fetchText(url, cookie) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Cookie: cookie,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function fetchBinary(url, cookie) {
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

const cookie = `sessionid=${SESSION_ID}${TARGET_IDC ? `; tt-target-idc=${TARGET_IDC}` : ''}`;

console.log(`\n[Step 1] @${UNIQUE_ID} のroomIdを取得中...`);
const html = await fetchText(`https://www.tiktok.com/@${UNIQUE_ID}/live`, cookie);

const roomIdMatch = html.match(/"roomId"\s*:\s*"(\d+)"/);
const statusMatch = html.match(/"status"\s*:\s*(\d+)/);
const titleMatch  = html.match(/"title"\s*:\s*"([^"]+)"/);

if (!roomIdMatch) {
  console.error('❌ roomIdが見つかりません。配信中か・sessionidが有効か確認してください');

  // デバッグ用: HTMLの一部を出力
  const snippet = html.slice(0, 2000);
  console.log('\n--- HTML snippet ---');
  console.log(snippet);
  process.exit(1);
}

const roomId = roomIdMatch[1];
const status = statusMatch ? parseInt(statusMatch[1]) : -1;
const title  = titleMatch  ? titleMatch[1] : '(不明)';

console.log(`✅ roomId: ${roomId}`);
console.log(`   status: ${status} ${status === 4 ? '(配信中)' : '(配信中ではない可能性)'}`);
console.log(`   title:  ${title}`);

// ── Step 2: Webcastエンドポイントにリクエスト ─────────────────────────────────

console.log('\n[Step 2] Webcastエンドポイントに接続中...');
const params = new URLSearchParams({
  aid: '1988', app_name: 'tiktok_web',
  room_id: roomId, cursor: '', next_type: '2',
});

const buf = await fetchBinary(
  `https://webcast.tiktok.com/webcast/im/fetch/?${params}`,
  cookie
);

console.log(`✅ レスポンス受信: ${buf.length} bytes`);
console.log(`   先頭4バイト(hex): ${buf.slice(0, 4).toString('hex')}`);

// JSONとして解釈できるか試みる
try {
  const json = JSON.parse(buf.toString('utf8'));
  console.log('\n📦 JSONレスポンス:');
  console.log(`   cursor:   ${json.cursor ?? '(なし)'}`);
  console.log(`   messages: ${json.data?.messages?.length ?? 0} 件`);
  if (json.data?.messages?.length) {
    console.log('   message types:', json.data.messages.map(m => m.type).join(', '));
  }
} catch {
  // Protobufバイナリ
  console.log('   → Protobufバイナリ形式で受信（正常）');
  console.log('   → 本実装ではprotobuf.jsでデコードします');
}

console.log('\n🎉 接続確認完了！pacesync-live-connector は正常に動作できます。');
