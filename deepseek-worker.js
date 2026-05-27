/**
 * Cloudflare Worker：My Girl 云端服务 + DeepSeek 安全代理
 *
 * 功能：
 * 1. /chat：代替前端调用 DeepSeek，前端不会看到 sk 密钥。
 * 2. /message、/snapshot、/task、/period：保存双人聊天、任务、姨妈日期。
 *
 * Cloudflare 需要配置：
 * - Secret：DEEPSEEK_API_KEY = 你的 DeepSeek sk-...
 * - KV 绑定：MY_GIRL_KV = 一个 Workers KV namespace
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === '/chat' && request.method === 'POST') {
        return handleDeepSeek(request, env);
      }

      if (url.pathname === '/snapshot' && request.method === 'GET') {
        const roomCode = normalizeRoom(url.searchParams.get('room'));
        const room = await getRoom(env, roomCode);
        return json(room);
      }

      if (url.pathname === '/message' && request.method === 'POST') {
        const body = await request.json();
        const roomCode = normalizeRoom(body.roomCode);
        const message = sanitizeMessage(body.message);
        const room = await updateRoom(env, roomCode, (data) => {
          data.messages.push(message);
          data.messages = data.messages.slice(-300);
          return data;
        });
        return json({ ok: true, messages: room.messages });
      }

      if (url.pathname === '/clear-messages' && request.method === 'POST') {
        const body = await request.json();
        const roomCode = normalizeRoom(body.roomCode);
        const room = await updateRoom(env, roomCode, (data) => {
          data.messages = [];
          return data;
        });
        return json({ ok: true, messages: room.messages });
      }

      if (url.pathname === '/task' && request.method === 'POST') {
        const body = await request.json();
        const roomCode = normalizeRoom(body.roomCode);
        const task = sanitizeTask(body.task);
        const room = await updateRoom(env, roomCode, (data) => {
          data.tasks.unshift(task);
          data.tasks = data.tasks.slice(0, 200);
          return data;
        });
        return json({ ok: true, tasks: room.tasks });
      }

      if (url.pathname === '/task' && request.method === 'PATCH') {
        const body = await request.json();
        const roomCode = normalizeRoom(body.roomCode);
        const id = cleanText(body.id, 100);
        const patch = sanitizeTaskPatch(body.patch || {});
        const room = await updateRoom(env, roomCode, (data) => {
          data.tasks = data.tasks.map((task) => task.id === id ? { ...task, ...patch } : task);
          return data;
        });
        return json({ ok: true, tasks: room.tasks });
      }

      if (url.pathname === '/task' && request.method === 'DELETE') {
        const body = await request.json();
        const roomCode = normalizeRoom(body.roomCode);
        const id = cleanText(body.id, 100);
        const room = await updateRoom(env, roomCode, (data) => {
          data.tasks = data.tasks.filter((task) => task.id !== id);
          return data;
        });
        return json({ ok: true, tasks: room.tasks });
      }

      if (url.pathname === '/clear-done' && request.method === 'POST') {
        const body = await request.json();
        const roomCode = normalizeRoom(body.roomCode);
        const room = await updateRoom(env, roomCode, (data) => {
          data.tasks = data.tasks.filter((task) => !task.done);
          return data;
        });
        return json({ ok: true, tasks: room.tasks });
      }

      if (url.pathname === '/period' && request.method === 'POST') {
        const body = await request.json();
        const roomCode = normalizeRoom(body.roomCode);
        const period = sanitizePeriod(body.period || {});
        const room = await updateRoom(env, roomCode, (data) => {
          data.period = period;
          return data;
        });
        return json({ ok: true, period: room.period });
      }

      return json({ error: 'Not Found' }, 404);
    } catch (error) {
      return json({ error: error.message || 'Server error' }, error.status || 500);
    }
  },
};

async function handleDeepSeek(request, env) {
  if (!env.DEEPSEEK_API_KEY) {
    return json({ error: 'Worker 未配置 DEEPSEEK_API_KEY Secret' }, 500);
  }

  const body = await request.json();
  const model = cleanText(body.model || 'deepseek-v4-flash', 80);
  const messages = Array.isArray(body.messages) ? body.messages.slice(-30).map((msg) => ({
    role: ['system', 'user', 'assistant'].includes(msg.role) ? msg.role : 'user',
    content: sanitizeDeepSeekContent(msg.content),
  })) : [];

  const upstream = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
  });

  const data = await upstream.text();
  return new Response(data, {
    status: upstream.status,
    headers: {
      ...corsHeaders(),
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
    },
  });
}

async function getRoom(env, roomCode) {
  if (!env.MY_GIRL_KV) throw new HttpError('Worker 未绑定 MY_GIRL_KV', 500);
  const raw = await env.MY_GIRL_KV.get(`room:${roomCode}`);
  if (!raw) return emptyRoom();
  try {
    const data = JSON.parse(raw);
    return {
      messages: Array.isArray(data.messages) ? data.messages : [],
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      period: data.period || null,
      updatedAt: data.updatedAt || '',
    };
  } catch {
    return emptyRoom();
  }
}

async function updateRoom(env, roomCode, mutator) {
  const current = await getRoom(env, roomCode);
  const next = mutator(current);
  next.updatedAt = new Date().toISOString();
  await env.MY_GIRL_KV.put(`room:${roomCode}`, JSON.stringify(next));
  return next;
}

function emptyRoom() {
  return { messages: [], tasks: [], period: null, updatedAt: '' };
}

function normalizeRoom(value) {
  const room = cleanText(value || '', 64).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!room || room.length < 3) throw new HttpError('房间码至少 3 位，只能包含字母、数字、-、_', 400);
  return room;
}

function sanitizeMessage(message = {}) {
  return {
    id: cleanText(message.id || crypto.randomUUID(), 100),
    who: message.who === 'b' ? 'b' : 'a',
    text: cleanText(message.text || '', 3000),
    image: sanitizeImage(message.image || ''),
    createdAt: cleanText(message.createdAt || new Date().toISOString(), 80),
  };
}

function sanitizeTask(task = {}) {
  return {
    id: cleanText(task.id || crypto.randomUUID(), 100),
    title: cleanText(task.title || '', 200),
    desc: cleanText(task.desc || '', 2000),
    owner: task.owner === 'b' ? 'b' : 'a',
    due: cleanText(task.due || '', 20),
    done: Boolean(task.done),
    doneAt: cleanText(task.doneAt || '', 80),
    createdAt: cleanText(task.createdAt || new Date().toISOString(), 80),
  };
}

function sanitizeTaskPatch(patch = {}) {
  const result = {};
  if ('title' in patch) result.title = cleanText(patch.title, 200);
  if ('desc' in patch) result.desc = cleanText(patch.desc, 2000);
  if ('owner' in patch) result.owner = patch.owner === 'b' ? 'b' : 'a';
  if ('due' in patch) result.due = cleanText(patch.due, 20);
  if ('done' in patch) result.done = Boolean(patch.done);
  if ('doneAt' in patch) result.doneAt = cleanText(patch.doneAt, 80);
  return result;
}

function sanitizePeriod(period = {}) {
  return {
    lastDate: cleanText(period.lastDate || '', 20),
    cycleLength: clamp(Number(period.cycleLength) || 28, 15, 60),
    duration: clamp(Number(period.duration) || 5, 1, 12),
    remindBefore: clamp(Number(period.remindBefore) || 0, 0, 14),
    lastNotifyDate: cleanText(period.lastNotifyDate || '', 20),
  };
}

function sanitizeImage(value) {
  const text = cleanText(value || '', 1_500_000);
  if (!text) return '';
  if (!text.startsWith('data:image/')) return '';
  return text;
}

function sanitizeDeepSeekContent(content) {
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content.slice(0, 12)) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text') {
        const text = cleanText(part.text || '', 200_000);
        if (text) parts.push({ type: 'text', text });
      }
      if (part.type === 'image_url' && part.image_url && part.image_url.url) {
        const url = sanitizeDeepSeekImageUrl(part.image_url.url);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    return parts.length ? parts : '';
  }
  return cleanText(content || '', 200_000);
}

function sanitizeDeepSeekImageUrl(value) {
  const text = cleanText(value || '', 2_500_000);
  if (/^data:image\/(png|jpe?g|webp);base64,/i.test(text)) return text;
  return '';
}

function cleanText(value, maxLength = 1000) {
  return String(value ?? '').slice(0, maxLength);
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
