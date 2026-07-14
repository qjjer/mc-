// 使用 Durable Objects 的信令服务器
export class Room {
  constructor(state, env) {
    this.state = state;
    this.sessions = [];
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.sessions.push(server);
    server.accept();

    server.addEventListener('message', (event) => {
      for (const ws of this.sessions) {
        if (ws !== server && ws.readyState === WebSocket.OPEN) {
          ws.send(event.data);
        }
      }
    });

    server.addEventListener('close', () => {
      this.sessions = this.sessions.filter(ws => ws !== server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const roomId = url.searchParams.get('room') || 'default';
    const id = env.ROOM.idFromName(roomId);
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  }
}