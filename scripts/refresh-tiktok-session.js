#!/usr/bin/env node
/**
 * refresh-tiktok-session.js
 * ─────────────────────────
 * Chrome DevTools Protocol 経由で TikTok の sessionid / tt-target-idc を取得し、
 * 本番サーバーを更新する。
 *
 * 使い方:
 *   node scripts/refresh-tiktok-session.js
 *     → グローバル .env を更新 + pm2 restart（全ルームに適用）
 *
 *   node scripts/refresh-tiktok-session.js --room moro_2525
 *     → users テーブルの per-room 設定を更新（pm2 restart 不要）
 *     → 同時にグローバル .env も更新する（fallback も最新に保つ）
 *
 * 事前準備（1回だけ）:
 *   1. Chrome を --remote-debugging-port=9222 で起動してTikTokにログイン
 *      "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
 *   2. TikTok (www.tiktok.com) を開いた状態にする
 *   3. このスクリプトを実行
 */
'use strict';

const http      = require('http');
const https     = require('https');
const { exec }  = require('child_process');
const WebSocket = require('ws');

const CDP_PORT     = Number(process.env.CDP_PORT)     || 9222;
const PROD_HOST    = process.env.PROD_HOST             || 'prod-aws';
const PROD_DIR     = process.env.PROD_DIR              || '/home/ubuntu/pace-sync';
const PROD_API_URL = process.env.PACESYNC_API_URL      || 'https://app.paceshinc.com';
const NEED_COOKIES = ['sessionid', 'tt-target-idc'];

// ── CLI 引数パース ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const roomIdx = args.indexOf('--room');
const targetRoom = roomIdx !== -1 ? args[roomIdx + 1] : null;

if (roomIdx !== -1 && !targetRoom) {
    console.error('❌ --room オプションにルーム名を指定してください。例: --room moro_2525');
    process.exit(1);
}

// ── ① CDP ページ一覧を取得 ────────────────────────────────────────────────
function getCdpTargets() {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        }).on('error', () => {
            reject(new Error(
                `Chrome に接続できません。\n` +
                `以下のコマンドで Chrome を起動してください:\n` +
                `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=${CDP_PORT}\n` +
                `その後 www.tiktok.com を開いてから再実行してください。`
            ));
        });
    });
}

// ── ② CDP WebSocket 経由で Cookie を取得 ─────────────────────────────────
function getCookiesFromTarget(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);

        ws.once('open', () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Network.getCookies',
                params: { urls: ['https://www.tiktok.com', 'https://tiktok.com'] },
            }));
        });

        ws.once('message', (raw) => {
            ws.close();
            try {
                const msg = JSON.parse(raw);
                resolve(msg.result?.cookies || []);
            } catch (e) { reject(e); }
        });

        ws.once('error', reject);
        setTimeout(() => { ws.close(); reject(new Error('CDP タイムアウト')); }, 8000);
    });
}

// ── ③-A SSH で .env を更新（グローバル） ─────────────────────────────────
function updateServerEnv(values) {
    return new Promise((resolve, reject) => {
        const cmds = [
            `sed -i '/^TIKTOK_SESSION_ID=/d' ${PROD_DIR}/.env`,
            `sed -i '/^TIKTOK_TARGET_IDC=/d' ${PROD_DIR}/.env`,
            `echo 'TIKTOK_SESSION_ID=${values.sessionid}' >> ${PROD_DIR}/.env`,
            `echo 'TIKTOK_TARGET_IDC=${values['tt-target-idc']}' >> ${PROD_DIR}/.env`,
            `pm2 restart pace-sync --update-env`,
            `echo '✓ .env 更新 + pm2 restart 完了'`,
        ].join(' && ');

        exec(`ssh ${PROD_HOST} "${cmds}"`, (err, stdout, stderr) => {
            if (err) { reject(new Error(stderr || err.message)); return; }
            resolve(stdout.trim());
        });
    });
}

// ── ③-B 本番 API 経由で per-room DB を更新 ───────────────────────────────
function updateRoomCredentials(roomId, values, adminToken) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            roomId,
            sessionId:  values.sessionid,
            targetIdc:  values['tt-target-idc'],
        });

        const url = new URL(`${PROD_API_URL}/api/admin/debug/tiktok-session/room`);
        const opts = {
            hostname: url.hostname,
            path:     url.pathname,
            method:   'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Authorization':  `Bearer ${adminToken}`,
            },
        };

        const req = https.request(opts, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.ok) { reject(new Error(`API error: ${JSON.stringify(json)}`)); return; }
                    resolve(json);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── ④ 管理者トークンを SSH 経由で取得（本番 JWT） ─────────────────────────
function getAdminToken() {
    return new Promise((resolve, reject) => {
        // 本番サーバーに直接リクエストしてトークンを取得する代わりに、
        // ローカルの .env から ADMIN_TOKEN を読む（設定されている場合）
        const localEnvPath = require('path').join(__dirname, '..', '.env');
        try {
            const envContent = require('fs').readFileSync(localEnvPath, 'utf8');
            const match = envContent.match(/^REFRESH_ADMIN_TOKEN=(.+)$/m);
            if (match) {
                resolve(match[1].trim());
                return;
            }
        } catch (_) {}

        reject(new Error(
            'REFRESH_ADMIN_TOKEN が .env に設定されていません。\n' +
            '管理者としてログインして取得した JWT を .env に追加してください:\n' +
            'REFRESH_ADMIN_TOKEN=<jwt_token>\n\n' +
            'または --global オプションで .env のみ更新することもできます:\n' +
            'node scripts/refresh-tiktok-session.js --global'
        ));
    });
}

// ── main ──────────────────────────────────────────────────────────────────
(async () => {
    const mode = targetRoom ? `ルーム個別 (@${targetRoom}) + グローバル .env` : 'グローバル .env のみ';
    console.log(`[refresh-tiktok-session] モード: ${mode}`);
    console.log('[refresh-tiktok-session] Chrome CDP に接続中...');

    // CDP からクッキー取得
    let targets;
    try {
        targets = await getCdpTargets();
    } catch (e) {
        console.error('❌', e.message);
        process.exit(1);
    }

    const tiktokTarget = targets.find(t =>
        t.type === 'page' && t.url && t.url.includes('tiktok.com')
    );
    if (!tiktokTarget) {
        console.error('❌ TikTok のタブが見つかりません。Chrome で www.tiktok.com を開いてください。');
        process.exit(1);
    }

    console.log(`[refresh-tiktok-session] TikTok タブ検出: ${tiktokTarget.url}`);
    console.log('[refresh-tiktok-session] Cookie を取得中...');

    let cookies;
    try {
        cookies = await getCookiesFromTarget(tiktokTarget.webSocketDebuggerUrl);
    } catch (e) {
        console.error('❌ Cookie 取得失敗:', e.message);
        process.exit(1);
    }

    const found = {};
    for (const c of cookies) {
        if (NEED_COOKIES.includes(c.name)) found[c.name] = c.value;
    }

    const missing = NEED_COOKIES.filter(k => !found[k]);
    if (missing.length > 0) {
        console.error(`❌ 以下の Cookie が見つかりません: ${missing.join(', ')}`);
        console.error('   TikTok にログインしているか確認してください。');
        process.exit(1);
    }

    console.log(`[refresh-tiktok-session] ✓ sessionid     = ${found.sessionid.slice(0, 6)}...`);
    console.log(`[refresh-tiktok-session] ✓ tt-target-idc = ${found['tt-target-idc']}`);

    // ── ルーム個別 DB 更新（--room 指定時） ──────────────────────────────
    if (targetRoom) {
        console.log(`[refresh-tiktok-session] @${targetRoom} の DB 認証情報を更新中...`);
        let adminToken;
        try {
            adminToken = await getAdminToken();
        } catch (e) {
            console.error('❌', e.message);
            process.exit(1);
        }
        try {
            const result = await updateRoomCredentials(targetRoom, found, adminToken);
            console.log(`[refresh-tiktok-session] ✅ @${targetRoom} DB 更新完了 — sessionId_set=${result.sessionId_set}, targetIdc=${result.targetIdc}`);
        } catch (e) {
            console.error('❌ ルーム DB 更新失敗:', e.message);
            process.exit(1);
        }
    }

    // ── グローバル .env 更新（常に実行） ─────────────────────────────────
    console.log('[refresh-tiktok-session] 本番サーバー .env を更新中（グローバル fallback）...');
    try {
        const result = await updateServerEnv(found);
        console.log('[refresh-tiktok-session]', result);
    } catch (e) {
        console.error('❌ .env 更新失敗:', e.message);
        process.exit(1);
    }

    const summary = targetRoom
        ? `✅ 完了 — @${targetRoom} DB + グローバル .env + pm2 restart`
        : `✅ 完了 — グローバル .env + pm2 restart`;
    console.log(`[refresh-tiktok-session] ${summary}`);
})();
