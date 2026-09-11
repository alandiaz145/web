import legacy from './worker.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const bad = (message, status = 400) => json({ error: message }, status);

function randomToken(bytes = 24) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sessionUser(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  return env.DB.prepare(`
    SELECT u.id,u.username,u.instagram_username
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expires_at>datetime('now')
    LIMIT 1
  `).bind(token).first();
}

function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function encryptToken(value, secret) {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return `${bytesToB64(iv)}.${bytesToB64(new Uint8Array(cipher))}`;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function validMetaSignature(raw, signature, appSecret) {
  if (!signature?.startsWith('sha256=') || !appSecret) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const expected = signature.slice(7);
  if (!/^[a-f0-9]{64}$/i.test(expected)) return false;
  const sig = new Uint8Array(expected.match(/.{2}/g).map(x => parseInt(x, 16)));
  return crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(raw));
}

function callbackHtml(ok, message) {
  const safe = String(message || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  const target = ok ? '/?instagram=connected' : '/?instagram=error';
  return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Repost Club</title><body style="margin:0;background:#09090b;color:#fff;font:16px system-ui;display:grid;place-items:center;min-height:100vh"><main style="max-width:520px;padding:32px;text-align:center"><h1>${ok ? 'Instagram conectado' : 'No se pudo conectar Instagram'}</h1><p>${safe}</p><p>Volviendo a Repost Club…</p></main><script>setTimeout(()=>location.href=${JSON.stringify(target)},1200)</script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function handleInstagram(request, env, url) {
  const redirectUri = env.INSTAGRAM_REDIRECT_URI || `${url.origin}/api/instagram/callback`;

  // Meta webhook verification challenge (no login required).
  if (request.method === 'GET' && url.pathname === '/api/instagram/webhook') {
    const mode = url.searchParams.get('hub.mode');
    const verifyToken = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && challenge && env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN && verifyToken === env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
      return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // Receive and store signed Instagram webhook payloads. Processing comes next.
  if (request.method === 'POST' && url.pathname === '/api/instagram/webhook') {
    if (!env.INSTAGRAM_APP_SECRET) return new Response('Webhook secret not configured', { status: 503 });
    const raw = await request.text();
    const signature = request.headers.get('x-hub-signature-256') || '';
    if (!(await validMetaSignature(raw, signature, env.INSTAGRAM_APP_SECRET))) return new Response('Invalid signature', { status: 401 });

    let payload;
    try { payload = JSON.parse(raw); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const eventKey = await sha256Hex(`${signature}:${raw}`);
    const eventType = payload?.object || 'instagram';
    try {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO instagram_webhook_events(event_key,event_type,payload)
        VALUES(?,?,?)
      `).bind(eventKey, eventType, raw).run();
    } catch (e) {
      console.error('instagram_webhook_store_failed', e?.message || String(e));
      return new Response('Database not ready', { status: 503 });
    }
    return new Response('EVENT_RECEIVED', { status: 200 });
  }

  // OAuth callback is public; the one-time state binds it to the logged-in Repost Club user.
  if (request.method === 'GET' && url.pathname === '/api/instagram/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error_description') || url.searchParams.get('error');
    if (oauthError) return callbackHtml(false, oauthError);
    if (!code || !state) return callbackHtml(false, 'Faltan datos de autorización.');
    if (!env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET || !env.INSTAGRAM_TOKEN_KEY) {
      return callbackHtml(false, 'Falta configurar Instagram en Cloudflare.');
    }

    let stateRow;
    try {
      stateRow = await env.DB.prepare(`
        SELECT state,user_id FROM instagram_oauth_states
        WHERE state=? AND expires_at>datetime('now') LIMIT 1
      `).bind(state).first();
    } catch {
      return callbackHtml(false, 'Falta aplicar la migración de Instagram en D1.');
    }
    if (!stateRow) return callbackHtml(false, 'La autorización venció o ya fue utilizada.');
    await env.DB.prepare('DELETE FROM instagram_oauth_states WHERE state=?').bind(state).run();

    const form = new URLSearchParams({
      client_id: env.INSTAGRAM_APP_ID,
      client_secret: env.INSTAGRAM_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code
    });
    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const shortToken = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !shortToken.access_token) {
      console.error('instagram_short_token_failed', JSON.stringify(shortToken));
      return callbackHtml(false, shortToken.error_message || shortToken.error?.message || 'Instagram rechazó el código OAuth.');
    }

    let accessToken = shortToken.access_token;
    let expiresIn = Number(shortToken.expires_in || 3600);
    const exchange = new URL('https://graph.instagram.com/access_token');
    exchange.searchParams.set('grant_type', 'ig_exchange_token');
    exchange.searchParams.set('client_secret', env.INSTAGRAM_APP_SECRET);
    exchange.searchParams.set('access_token', accessToken);
    const longRes = await fetch(exchange);
    const longToken = await longRes.json().catch(() => ({}));
    if (longRes.ok && longToken.access_token) {
      accessToken = longToken.access_token;
      expiresIn = Number(longToken.expires_in || 5184000);
    }

    const profileUrl = new URL('https://graph.instagram.com/me');
    profileUrl.searchParams.set('fields', 'id,username,account_type');
    profileUrl.searchParams.set('access_token', accessToken);
    const profileRes = await fetch(profileUrl);
    const profile = await profileRes.json().catch(() => ({}));
    if (!profileRes.ok || !(profile.id || shortToken.user_id) || !profile.username) {
      console.error('instagram_profile_failed', JSON.stringify(profile));
      return callbackHtml(false, profile.error?.message || 'No pudimos leer el perfil profesional de Instagram.');
    }

    const igUserId = String(profile.id || shortToken.user_id);
    const encrypted = await encryptToken(accessToken, env.INSTAGRAM_TOKEN_KEY);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    const scopes = 'instagram_business_basic,instagram_business_manage_comments';

    try {
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO instagram_connections(user_id,ig_user_id,username,account_type,access_token_encrypted,token_expires_at,scopes,updated_at)
          VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(user_id) DO UPDATE SET
            ig_user_id=excluded.ig_user_id,
            username=excluded.username,
            account_type=excluded.account_type,
            access_token_encrypted=excluded.access_token_encrypted,
            token_expires_at=excluded.token_expires_at,
            scopes=excluded.scopes,
            updated_at=CURRENT_TIMESTAMP
        `).bind(stateRow.user_id, igUserId, profile.username, profile.account_type || null, encrypted, expiresAt, scopes),
        env.DB.prepare('UPDATE users SET instagram_username=? WHERE id=?').bind(profile.username, stateRow.user_id)
      ]);
    } catch (e) {
      console.error('instagram_connection_save_failed', e?.message || String(e));
      if (String(e).includes('UNIQUE')) return callbackHtml(false, 'Esta cuenta de Instagram ya está vinculada a otro usuario de Repost Club.');
      return callbackHtml(false, 'No pudimos guardar la conexión de Instagram.');
    }

    return callbackHtml(true, `@${profile.username} quedó vinculada a tu cuenta.`);
  }

  // Remaining Instagram routes require a Repost Club session.
  const user = await sessionUser(request, env);
  if (!user) return bad('Sesión requerida', 401);

  if (request.method === 'GET' && url.pathname === '/api/instagram/status') {
    try {
      const connection = await env.DB.prepare(`
        SELECT ig_user_id,username,account_type,token_expires_at,scopes,connected_at,updated_at
        FROM instagram_connections WHERE user_id=? LIMIT 1
      `).bind(user.id).first();
      return json({ connected: !!connection, connection: connection || null });
    } catch {
      return bad('Falta aplicar la migración de Instagram en D1', 503);
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/instagram/oauth/start') {
    if (!env.INSTAGRAM_APP_ID) return bad('Falta INSTAGRAM_APP_ID en Cloudflare', 503);
    const state = randomToken(24);
    try {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM instagram_oauth_states WHERE user_id=? OR expires_at<=datetime(\'now\')').bind(user.id),
        env.DB.prepare(`INSERT INTO instagram_oauth_states(state,user_id,expires_at) VALUES(?,?,datetime('now','+10 minutes'))`).bind(state, user.id)
      ]);
    } catch {
      return bad('Falta aplicar la migración de Instagram en D1', 503);
    }

    const auth = new URL('https://www.instagram.com/oauth/authorize');
    auth.searchParams.set('client_id', env.INSTAGRAM_APP_ID);
    auth.searchParams.set('redirect_uri', redirectUri);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', 'instagram_business_basic,instagram_business_manage_comments');
    auth.searchParams.set('state', state);
    auth.searchParams.set('enable_fb_login', '0');
    auth.searchParams.set('force_authentication', '1');
    return json({ url: auth.toString() });
  }

  if (request.method === 'POST' && url.pathname === '/api/instagram/disconnect') {
    try {
      await env.DB.prepare('DELETE FROM instagram_connections WHERE user_id=?').bind(user.id).run();
      return json({ ok: true });
    } catch {
      return bad('Falta aplicar la migración de Instagram en D1', 503);
    }
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/instagram/')) {
      const response = await handleInstagram(request, env, url);
      if (response) return response;
    }
    return legacy.fetch(request, env, ctx);
  }
};
