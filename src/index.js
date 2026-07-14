// ===== 导入 JWT 库 =====
import { SignJWT, jwtVerify } from 'jose';

// =========================================
//  User Durable Object
// =========================================
export class User {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ---- 初始化用户 ----
    if (path === '/init' && method === 'POST') {
      const { nickname, salt, hash } = await request.json();
      await this.storage.put('nickname', nickname);
      await this.storage.put('salt', salt);
      await this.storage.put('hash', hash);
      await this.storage.put('contacts', []);
      await this.storage.put('tokenVersion', 0);
      await this.storage.put('rooms', []);
      return new Response('OK', { status: 200 });
    }

    // ---- 获取用户信息 ----
    if (path === '/info' && method === 'GET') {
      const nickname = await this.storage.get('nickname') || '';
      const contacts = await this.storage.get('contacts') || [];
      const tokenVersion = await this.storage.get('tokenVersion') || 0;
      const rooms = await this.storage.get('rooms') || [];
      return new Response(JSON.stringify({ nickname, contacts, tokenVersion, rooms }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ---- 获取联系人列表 ----
    if (path === '/contacts' && method === 'GET') {
      const contacts = await this.storage.get('contacts') || [];
      return new Response(JSON.stringify(contacts), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ---- 添加联系人 ----
    if (path === '/contacts' && method === 'POST') {
      const { contactId } = await request.json();
      let contacts = await this.storage.get('contacts') || [];
      if (!contacts.includes(contactId)) {
        contacts.push(contactId);
        await this.storage.put('contacts', contacts);
      }
      return new Response('OK', { status: 200 });
    }

    // ---- 获取用户的所有房间 ----
    if (path === '/rooms' && method === 'GET') {
      const rooms = await this.storage.get('rooms') || [];
      return new Response(JSON.stringify(rooms), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ---- 添加房间到用户列表 ----
    if (path === '/rooms' && method === 'POST') {
      const { roomId } = await request.json();
      let rooms = await this.storage.get('rooms') || [];
      if (!rooms.includes(roomId)) {
        rooms.push(roomId);
        await this.storage.put('rooms', rooms);
      }
      return new Response('OK', { status: 200 });
    }

    // ---- 递增 tokenVersion（退出登录） ----
    if (path === '/bump-version' && method === 'POST') {
      let version = await this.storage.get('tokenVersion') || 0;
      version++;
      await this.storage.put('tokenVersion', version);
      return new Response(JSON.stringify({ newVersion: version }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  }
}

// =========================================
//  Room Durable Object
// =========================================
export class Room {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.connections = [];
  }

  // ---- 广播成员更新 ----
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

    // ---- 创建房间 ----
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

    // ---- 获取房间信息 ----
    if (path === '/info' && method === 'GET') {
      const members = await this.storage.get('members') || [];
      const roomName = await this.storage.get('roomName') || '群聊';
      const creatorId = await this.storage.get('creatorId') || '';
      return new Response(JSON.stringify({ members, roomName, creatorId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ---- 获取成员列表 ----
    if (path === '/members' && method === 'GET') {
      const members = await this.storage.get('members') || [];
      return new Response(JSON.stringify(members), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ---- 加入房间 ----
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

    // ---- 离开房间 ----
    if (path === '/leave' && method === 'POST') {
      const { userId } = await request.json();
      let members = await this.storage.get('members') || [];
      members = members.filter(m => m.userId !== userId);
      await this.storage.put('members', members);
      this.broadcastMembers(members);
      return new Response('OK', { status: 200 });
    }

    // ---- WebSocket 信令 (关键!) ----
    if (path === '/ws') {
      const userId = url.searchParams.get('user') || 'unknown';
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      server.userId = userId;
      this.connections.push(server);
      server.accept();

      // 尝试获取昵称（从存储中）
      const members = await this.storage.get('members') || [];
      const member = members.find(m => m.userId === userId);
      server.nickname = member ? member.nickname : '用户';

      server.addEventListener('message', (event) => {
        const data = event.data;
        // 转发给房间内所有其他连接
        for (const ws of this.connections) {
          if (ws !== server && ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          }
        }
      });

      server.addEventListener('close', async () => {
        this.connections = this.connections.filter(ws => ws !== server);
        // 从成员列表中移除
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

// =========================================
//  Worker 入口
// =========================================
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'default-secret-change-me');

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ---- CORS 预检 ----
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

    // ---- 辅助：从 JWT 获取 userId ----
    async function getUserIdFromAuth(request) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
      const token = authHeader.split(' ')[1];
      try {
        const { payload } = await jwtVerify(token, JWT_SECRET);
        return payload.userId;
      } catch {
        return null;
      }
    }

    // ---- 鉴权中间件 ----
    async function requireAuth(request) {
      const userId = await getUserIdFromAuth(request);
      if (!userId) {
        return { error: '未授权，请先登录', status: 401 };
      }
      return { userId };
    }

    // =========================================
    //  路由处理
    // =========================================

    // ---- 临时用户注册 ----
    if (path === '/guest/register' && method === 'POST') {
      const { nickname } = await request.json();
      const userId = 'guest_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      await env.USER_INDEX.put(userId, 'guest', { expirationTtl: 3600 });
      return jsonResponse({ userId });
    }

    // ---- 正式用户注册 ----
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

    // ---- 用户登录 ----
    if (path === '/user/login' && method === 'POST') {
      const { userId, password } = await request.json();
      const exists = await env.USER_INDEX.get(userId);
      if (exists === null) {
        return jsonResponse({ error: '用户不存在' }, 404);
      }
      const id = env.USER.idFromName(userId);
      const stub = env.USER.get(id);
      const infoRes = await stub.fetch(new Request('https://dummy/info'));
      const { salt, hash: storedHash, tokenVersion, nickname } = await infoRes.json();
      const inputHash = await hashPassword(password, salt);
      if (inputHash !== storedHash) {
        return jsonResponse({ error: '密码错误' }, 401);
      }
      const token = await new SignJWT({ userId, nickname, version: tokenVersion })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('180d')
        .sign(JWT_SECRET);
      return jsonResponse({ token, userId, nickname });
    }

    // ---- 退出登录 ----
    if (path === '/user/logout' && method === 'POST') {
      const auth = await requireAuth(request);
      if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
      const id = env.USER.idFromName(auth.userId);
      const stub = env.USER.get(id);
      await stub.fetch(new Request('https://dummy/bump-version', { method: 'POST' }));
      return jsonResponse({ message: '已退出' });
    }

    // ---- 用户相关请求（需鉴权） ----
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

    // ---- 房间相关请求（转发给 Room DO） ----
    if (path.startsWith('/room/')) {
      const parts = path.split('/');
      const roomId = parts[2];                     // 例如 'test'
      const subPath = '/' + parts.slice(3).join('/'); // 例如 '/ws' 或 '/join'
      // 创建 Room DO 实例
      const id = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(id);
      // 重写 URL，去掉 /room/{roomId} 前缀，让 DO 只看到子路径
      const newUrl = request.url.replace(`/room/${roomId}`, '');
      const newRequest = new Request(request, { url: newUrl });
      const response = await stub.fetch(newRequest);
      // 添加 CORS 头
      const headers = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
      return new Response(response.body, { status: response.status, headers });
    }

    // ---- 创建房间（新，基于 /room/create） ----
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
      // 添加到用户的房间列表
      const userDO = env.USER.idFromName(auth.userId);
      const userStub = env.USER.get(userDO);
      await userStub.fetch(new Request('https://dummy/rooms', {
        method: 'POST',
        body: JSON.stringify({ roomId }),
      }));
      return jsonResponse({ roomId });
    }

    // ---- 获取用户的所有房间 ----
    if (path === '/user/rooms' && method === 'GET') {
      const auth = await requireAuth(request);
      if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
      const id = env.USER.idFromName(auth.userId);
      const stub = env.USER.get(id);
      const response = await stub.fetch(new Request('https://dummy/rooms'));
      const data = await response.json();
      return jsonResponse(data);
    }

    // ---- 默认 ----
    return jsonResponse({ message: 'Voice Signal Server' });
  }
};
