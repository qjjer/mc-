// =============================================
//  User Durable Object
// =============================================
export class User {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/init' && method === 'POST') {
      const { nickname, salt, hash } = await request.json();
      await this.storage.put('nickname', nickname);
      await this.storage.put('salt', salt);
      await this.storage.put('hash', hash);
      await this.storage.put('contacts', []);
      await this.storage.put('rooms', []);
      return new Response('OK', { status: 200 });
    }

    if (path === '/info' && method === 'GET') {
      const nickname = await this.storage.get('nickname') || '';
      const contacts = await this.storage.get('contacts') || [];
      const rooms = await this.storage.get('rooms') || [];
      return new Response(JSON.stringify({ nickname, contacts, rooms }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path === '/contacts' && method === 'GET') {
      const contacts = await this.storage.get('contacts') || [];
      return new Response(JSON.stringify(contacts), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path === '/contacts' && method === 'POST') {
      const { contactId } = await request.json();
      let contacts = await this.storage.get('contacts') || [];
      if (!contacts.includes(contactId)) {
        contacts.push(contactId);
        await this.storage.put('contacts', contacts);
      }
      return new Response('OK', { status: 200 });
    }

    if (path === '/rooms' && method === 'GET') {
      const rooms = await this.storage.get('rooms') || [];
      return new Response(JSON.stringify(rooms), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path === '/rooms' && method === 'POST') {
      const { roomId } = await request.json();
      let rooms = await this.storage.get('rooms') || [];
      if (!rooms.includes(roomId)) {
        rooms.push(roomId);
        await this.storage.put('rooms', rooms);
      }
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  }
}

// =============================================
//  Room Durable Object（保持不变）
// =============================================
export class Room {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.connections = [];
  }

  broadcastMembers(members) {
    const message = JSON.stringify({
      type: 'members_update',
      members: members,
    });
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/create' && method === 'POST') {
      const { creatorId, roomName } = await request.json();
      const roomId = 'room_' + Math.floor(100000 + Math.random() * 900000);
      await this.storage.put('creatorId', creatorId);
      await this.storage.put('roomName', roomName || '群聊');
      await this.storage.put('members', [{ userId: creatorId, nickname: '创建者' }]);
      await this.storage.put('createdAt', Date.now());
      return new Response(JSON.stringify({ roomId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path === '/info' && method === 'GET') {
      const members = await this.storage.get('members') || [];
      const roomName = await this.storage.get('roomName') || '群聊';
      const creatorId = await this.storage.get('creatorId') || '';
      return new Response(JSON.stringify({ members, roomName, creatorId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path === '/members' && method === 'GET') {
      const members = await this.storage.get('members') || [];
      return new Response(JSON.stringify(members), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path === '/join' && method === 'POST') {
      const { userId, nickname } = await request.json();
      let members = await this.storage.get('members') || [];
      const exists = members.some(m => m.userId === userId);
      if (!exists) {
        members.push({ userId, nickname: nickname || '用户' });
        await this.storage.put('members', members);
        this.broadcastMembers(members);
      }
      return new Response('OK', { status: 200 });
    }

    if (path === '/leave' && method === 'POST') {
      const { userId } = await request.json();
      let members = await this.storage.get('members') || [];
      members = members.filter(m => m.userId !== userId);
      await this.storage.put('members', members);
      this.broadcastMembers(members);
      return new Response('OK', { status: 200 });
    }

    if (path === '/ws') {
      const userId = url.searchParams.get('user') || 'unknown';
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      server.userId = userId;
      this.connections.push(server);
      server.accept();

      const members = await this.storage.get('members') || [];
      const member = members.find(m => m.userId === userId);
      server.nickname = member ? member.nickname : '用户';

      server.addEventListener('message', (event) => {
        const data = event.data;
        for (const ws of this.connections) {
          if (ws !== server && ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          }
        }
      });

      server.addEventListener('close', async () => {
        this.connections = this.connections.filter(ws => ws !== server);
        let members = await this.storage.get('members') || [];
        const beforeCount = members.length;
        members = members.filter(m => m.userId !== userId);
        if (members.length !== beforeCount) {
          await this.storage.put('members', members);
          this.broadcastMembers(members);
        }
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not Found', { status: 404 });
  }
}

// =============================================
//  辅助函数（密码哈希）
// =============================================
async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
}

// =============================================
//  Worker 入口（无 JWT）
// =============================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ---- CORS ----
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    function jsonResponse(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ---- 从 Authorization header 提取 token，验证 ----
    async function getUserIdFromToken(request) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
      const token = authHeader.split(' ')[1];
      const userId = await env.SESSION_STORE.get(token);
      return userId;
    }

    async function requireAuth(request) {
      const userId = await getUserIdFromToken(request);
      if (!userId) {
        return { error: '未授权，请先登录', status: 401 };
      }
      return { userId };
    }

    // =============================================
    //  路由处理（顺序重要）
    // =============================================

    // ---- 1. 房间路由（最优先） ----
    if (path.startsWith('/room/')) {
      const parts = path.split('/');
      const roomId = parts[2];
      const id = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(id);
      const newUrl = request.url.replace(`/room/${roomId}`, '');
      const newRequest = new Request(request, { url: newUrl });
      const response = await stub.fetch(newRequest);
      const headers = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
      return new Response(response.body, { status: response.status, headers });
    }

    // ---- 2. 临时用户注册 ----
    if (path === '/guest/register' && method === 'POST') {
      const { nickname } = await request.json();
      const userId = 'guest_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      return jsonResponse({ userId });
    }

    // ---- 3. 正式用户注册 ----
    if (path === '/user/register' && method === 'POST') {
      const { userId, nickname, password } = await request.json();
      const exists = await env.USER_INDEX.get(userId);
      if (exists !== null) {
        return jsonResponse({ error: '该ID已被注册' }, 400);
      }
      const salt = crypto.randomUUID();
      const hash = await hashPassword(password, salt);
      const id = env.USER.idFromName(userId);
      const stub = env.USER.get(id);
      await stub.fetch(new Request('https://dummy/init', {
        method: 'POST',
        body: JSON.stringify({ nickname, salt, hash }),
      }));
      await env.USER_INDEX.put(userId, 'registered');
      return jsonResponse({ success: true });
    }

    // ---- 4. 用户登录 ----
    if (path === '/user/login' && method === 'POST') {
      const { userId, password } = await request.json();
      const exists = await env.USER_INDEX.get(userId);
      if (exists === null) {
        return jsonResponse({ error: '用户不存在' }, 404);
      }
      const id = env.USER.idFromName(userId);
      const stub = env.USER.get(id);
      const infoRes = await stub.fetch(new Request('https://dummy/info'));
      const { salt, hash: storedHash, nickname } = await infoRes.json();
      const inputHash = await hashPassword(password, salt);
      if (inputHash !== storedHash) {
        return jsonResponse({ error: '密码错误' }, 401);
      }
      // 生成 session token
      const token = crypto.randomUUID();
      // 存储到 KV，有效期 180 天（秒）
      await env.SESSION_STORE.put(token, userId, { expirationTtl: 180 * 24 * 60 * 60 });
      return jsonResponse({ token, userId, nickname });
    }

    // ---- 5. 退出登录 ----
    if (path === '/user/logout' && method === 'POST') {
      const auth = await requireAuth(request);
      if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
      const authHeader = request.headers.get('Authorization');
      const token = authHeader.split(' ')[1];
      await env.SESSION_STORE.delete(token);
      return jsonResponse({ message: '已退出' });
    }

    // ---- 6. 用户相关请求（需鉴权） ----
    if (path.startsWith('/user/')) {
      const auth = await requireAuth(request);
      if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
      const parts = path.split('/');
      const userId = parts[2];
      if (auth.userId !== userId) {
        return jsonResponse({ error: '无权访问其他用户数据' }, 403);
      }
      const id = env.USER.idFromName(userId);
      const stub = env.USER.get(id);
      const newUrl = request.url.replace(`/user/${userId}`, '');
      const newRequest = new Request(request, { url: newUrl });
      const response = await stub.fetch(newRequest);
      const headers = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
      return new Response(response.body, { status: response.status, headers });
    }

    // ---- 7. 创建房间 ----
    if (path === '/room/create' && method === 'POST') {
      const auth = await requireAuth(request);
      if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
      const { roomName } = await request.json();
      const roomId = 'room_' + Math.floor(100000 + Math.random() * 900000);
      const id = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(id);
      await stub.fetch(new Request('https://dummy/create', {
        method: 'POST',
        body: JSON.stringify({ creatorId: auth.userId, roomName: roomName || '群聊' }),
      }));
      const userDO = env.USER.idFromName(auth.userId);
      const userStub = env.USER.get(userDO);
      await userStub.fetch(new Request('https://dummy/rooms', {
        method: 'POST',
        body: JSON.stringify({ roomId }),
      }));
      return jsonResponse({ roomId });
    }

    // ---- 8. 获取用户所有房间 ----
    if (path === '/user/rooms' && method === 'GET') {
      const auth = await requireAuth(request);
      if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
      const id = env.USER.idFromName(auth.userId);
      const stub = env.USER.get(id);
      const response = await stub.fetch(new Request('https://dummy/rooms'));
      const data = await response.json();
      return jsonResponse(data);
    }

    // ---- 9. 根路径 ----
    if (path === '/') {
      return jsonResponse({ message: 'Voice Signal Server' });
    }

    return new Response('Not Found', { status: 404 });
  }
};
