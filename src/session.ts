import http from 'http';
import WebSocket from 'ws';

const NEED_COOKIES = ['sessionid', 'tt-target-idc'];

export interface SessionValues {
  sessionId: string;
  targetIdc: string;
}

/** Chrome CDP経由でTikTokのsessionid/tt-target-idcを取得する */
export async function refreshSessionFromChrome(cdpPort = 9222): Promise<SessionValues> {
  const targets = await getCdpTargets(cdpPort);

  const tiktokTarget = targets.find(
    (t: any) => t.type === 'page' && t.url?.includes('tiktok.com')
  );
  if (!tiktokTarget) {
    throw new Error(
      'TikTokのタブが見つかりません。Chromeでwww.tiktok.comを開いてください。'
    );
  }

  const cookies = await getCookiesFromTarget(tiktokTarget.webSocketDebuggerUrl);
  const found: Record<string, string> = {};
  for (const c of cookies) {
    if (NEED_COOKIES.includes(c.name)) found[c.name] = c.value;
  }

  const missing = NEED_COOKIES.filter(k => !found[k]);
  if (missing.length > 0) {
    throw new Error(`Cookie取得失敗: ${missing.join(', ')} が見つかりません`);
  }

  return {
    sessionId: found['sessionid'],
    targetIdc: found['tt-target-idc'],
  };
}

function getCdpTargets(port: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', () => {
      reject(new Error(
        `Chrome CDP に接続できません (port: ${port})。\n` +
        `chrome.exe --remote-debugging-port=${port} で起動してください。`
      ));
    });
  });
}

function getCookiesFromTarget(wsUrl: string): Promise<any[]> {
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
        const msg = JSON.parse(raw.toString());
        resolve(msg.result?.cookies || []);
      } catch (e) { reject(e); }
    });
    ws.once('error', reject);
    setTimeout(() => { ws.close(); reject(new Error('CDP タイムアウト')); }, 8000);
  });
}
