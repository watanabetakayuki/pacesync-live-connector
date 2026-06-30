import protobuf from 'protobufjs';
import path from 'path';

let root: protobuf.Root | null = null;

async function getRoot(): Promise<protobuf.Root> {
  if (!root) {
    root = await protobuf.load(
      path.join(__dirname, 'webcast.proto')
    );
  }
  return root;
}

export interface DecodedMessage {
  method: string;
  payload: Uint8Array;
}

export interface WebcastResponse {
  messages: DecodedMessage[];
  cursor: string;
  hasMore: boolean;
}

/** バイナリレスポンスをWebcastResponseにデコードする */
export async function decodeWebcastResponse(buffer: Buffer): Promise<WebcastResponse> {
  const r = await getRoot();
  const WebcastResponseType = r.lookupType('WebcastResponse');
  const decoded = WebcastResponseType.decode(buffer) as any;
  return {
    messages: decoded.messages ?? [],
    cursor:   decoded.cursor   ?? '',
    hasMore:  decoded.hasMore  ?? false,
  };
}

/** 個別メッセージのpayloadをデコードする */
export async function decodeMessage(method: string, payload: Uint8Array): Promise<any> {
  const r = await getRoot();
  try {
    const MessageType = r.lookupType(method);
    return MessageType.decode(payload);
  } catch {
    return null;
  }
}
