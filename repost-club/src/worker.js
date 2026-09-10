const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' }
});
const bad = (message, status = 400) => json({ error: message }, status);

function randomToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt = randomToken(16)) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: enc.encode(salt),
    iterations: 100000,
    hash: 'SHA-256'
  }, key, 256);
  const hash = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${salt}:${hash}`;
}

async function verifyPassword(password, stored) {
  const [salt] = String(stored || '').split(':');
  return !!salt && (await hashPassword(password, salt)) === stored;
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function authUser(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;

  const user = await env.DB.prepare(`
    SELECT u.id,u.username,u.email,u.instagram_username,u.points,u.trust_score,u.role
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expires_at>datetime('now')
  `).bind(token).first();

  if (user) {
    await env.DB.prepare(`UPDATE sessions SET created_at=CURRENT_TIMESTAMP WHERE token=?`).bind(token).run();
  }
  return user;
}

async function expireCampaigns(env) {
  const { results = [] } = await env.DB.prepare(`
    SELECT p.id,p.user_id,
      COALESCE(SUM((a.target_count-a.completed_count)*a.reward_points),0) refund
    FROM posts p LEFT JOIN post_actions a ON a.post_id=p.id
    WHERE p.status='active' AND p.expires_at<=datetime('now')
    GROUP BY p.id LIMIT 50
  `).all();

  for (const post of results) {
    const claim = await env.DB.prepare(`
      UPDATE posts SET status='expired'
      WHERE id=? AND status='active' AND expires_at<=datetime('now')
    `).bind(post.id).run();
    if (!Number(claim.meta?.changes || 0)) continue;

    const refund = Number(post.refund || 0);
    if (refund > 0) {
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET points=points+? WHERE id=?').bind(refund, post.user_id),
        env.DB.prepare(`INSERT INTO point_transactions(user_id,amount,type,post_id,note)
          VALUES(?,?,'campaign_refund',?,'Créditos no utilizados al vencer la campaña')`)
          .bind(post.user_id, refund, post.id)
      ]);
    }
  }
}

async function api(request, env, url) {
  await expireCampaigns(env);

  if (request.method === 'POST' && url.pathname === '/api/register') {
    const body = await readJson(request);
    if (!body) return bad('JSON inválido');

    const username = String(body.username || '').trim().replace(/^@/, '');
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const instagram = String(body.instagram_username || '').trim().replace(/^@/, '') || null;

    if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) return bad('El usuario debe tener 3-30 caracteres y usar solo letras, números, punto, guion o guion bajo');
    if (!/^\S+@\S+\.\S+$/.test(email)) return bad('Email inválido');
    if (password.length < 8) return bad('La contraseña debe tener al menos 8 caracteres');

    let userId = null;
    try {
      const passwordHash = await hashPassword(password);
      const insert = await env.DB.prepare(`
        INSERT INTO users(username,email,password_hash,instagram_username)
        VALUES(?,?,?,?)
      `).bind(username, email, passwordHash, instagram).run();

      userId = Number(insert.meta?.last_row_id || 0);
      if (!userId) throw new Error('D1 no devolvió el id del usuario creado');

      const created = await env.DB.prepare(`
        SELECT id,username,email,instagram_username,points,trust_score,role
        FROM users WHERE id=?
      `).bind(userId).first();
      if (!created) throw new Error('No se pudo leer el usuario recién creado');

      const token = randomToken();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO point_transactions(user_id,amount,type,note)
          VALUES(?,50,'signup_bonus','Saldo inicial')`).bind(userId),
        env.DB.prepare(`INSERT INTO sessions(token,user_id,expires_at)
          VALUES(?,?,datetime('now','+30 days'))`).bind(token, userId)
      ]);

      return json({ token, user: created }, 201);
    } catch (e) {
      console.error('register_failed', e?.message || String(e));
      if (userId) {
        try { await env.DB.prepare('DELETE FROM users WHERE id=?').bind(userId).run(); } catch {}
      }
      if (String(e).includes('UNIQUE')) return bad('Ese usuario o email ya está registrado', 409);
      return bad(`No se pudo crear la cuenta: ${e?.message || 'error interno'}`, 500);
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(request);
    if (!body) return bad('JSON inválido');
    const identity = String(body.identity || '').trim().replace(/^@/, '').toLowerCase();
    const row = await env.DB.prepare(`
      SELECT * FROM users WHERE lower(email)=? OR lower(username)=? LIMIT 1
    `).bind(identity, identity).first();
    if (!row || !(await verifyPassword(String(body.password || ''), row.password_hash))) {
      return bad('Usuario/email o contraseña incorrectos', 401);
    }
    const token = randomToken();
    await env.DB.prepare(`INSERT INTO sessions(token,user_id,expires_at)
      VALUES(?,?,datetime('now','+30 days'))`).bind(token, row.id).run();
    return json({
      token,
      user: {
        id: row.id,
        username: row.username,
        email: row.email,
        instagram_username: row.instagram_username,
        points: row.points,
        trust_score: row.trust_score,
        role: row.role
      }
    });
  }

  const user = await authUser(request, env);
  if (!user) return bad('Sesión requerida', 401);

  if (request.method === 'GET' && url.pathname === '/api/me') {
    const { results: transactions = [] } = await env.DB.prepare(`
      SELECT amount,type,note,created_at
      FROM point_transactions
      WHERE user_id=? ORDER BY id DESC LIMIT 15
    `).bind(user.id).all();
    return json({ user, transactions });
  }

  if (request.method === 'GET' && url.pathname === '/api/community') {
    const { results: online = [] } = await env.DB.prepare(`
      SELECT u.id,u.username,u.instagram_username,MAX(s.created_at) last_seen
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.expires_at>datetime('now') AND s.created_at>=datetime('now','-5 minutes')
      GROUP BY u.id,u.username,u.instagram_username
      ORDER BY CASE WHEN u.id=? THEN 0 ELSE 1 END,last_seen DESC
      LIMIT 20
    `).bind(user.id).all();

    const { results: activity = [] } = await env.DB.prepare(`
      SELECT type,actor,target,detail,created_at FROM (
        SELECT 'post' type,u.username actor,NULL target,
          COALESCE(p.title,'Nueva publicación') detail,p.created_at created_at
        FROM posts p JOIN users u ON u.id=p.user_id

        UNION ALL

        SELECT 'action' type,actor.username actor,owner.username target,
          a.action_type detail,x.created_at created_at
        FROM participations x
        JOIN users actor ON actor.id=x.user_id
        JOIN post_actions a ON a.id=x.post_action_id
        JOIN posts p ON p.id=a.post_id
        JOIN users owner ON owner.id=p.user_id
        WHERE x.status='verified'
      )
      ORDER BY created_at DESC
      LIMIT 15
    `).all();

    return json({ online, activity });
  }

  if (request.method === 'POST' && url.pathname === '/api/logout') {
    const token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
    await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run();
    return json({ ok: true });
  }

  if (request.method === 'GET' && url.pathname === '/api/feed') {
    const { results = [] } = await env.DB.prepare(`
      SELECT p.id,p.url,p.title,p.platform,p.created_at,p.expires_at,p.user_id,
        u.username,u.instagram_username,
        a.id action_id,a.action_type,a.reward_points,a.target_count,a.completed_count,a.verification_mode,
        EXISTS(SELECT 1 FROM participations x WHERE x.post_action_id=a.id AND x.user_id=?) already_done
      FROM posts p
      JOIN users u ON u.id=p.user_id
      JOIN post_actions a ON a.post_id=p.id
      WHERE p.status='active' AND p.expires_at>datetime('now')
      ORDER BY p.created_at DESC,a.id ASC
    `).bind(user.id).all();

    const grouped = new Map();
    for (const r of results) {
      if (!grouped.has(r.id)) {
        grouped.set(r.id, {
          id:r.id,url:r.url,title:r.title,platform:r.platform,
          created_at:r.created_at,expires_at:r.expires_at,user_id:r.user_id,
          username:r.username,instagram_username:r.instagram_username,actions:[]
        });
      }
      grouped.get(r.id).actions.push({
        id:r.action_id,type:r.action_type,reward:r.reward_points,
        target:r.target_count,completed:r.completed_count,
        verification:r.verification_mode,already_done:!!r.already_done
      });
    }
    return json({ posts: [...grouped.values()] });
  }

  if (request.method === 'POST' && url.pathname === '/api/posts') {
    const body = await readJson(request);
    if (!body) return bad('JSON inválido');

    const urlValue = String(body.url || '').trim();
    const title = String(body.title || '').trim().slice(0,120) || null;
    const platform = String(body.platform || 'instagram').toLowerCase();
    const actions = Array.isArray(body.actions) ? body.actions : [];

    if (!/^https?:\/\//i.test(urlValue)) return bad('Ingresá una URL válida');
    if (platform !== 'instagram') return bad('La V1 solo acepta Instagram');
    if (!actions.length) return bad('Elegí al menos una acción');

    const active = await env.DB.prepare(`
      SELECT COUNT(*) count FROM posts
      WHERE user_id=? AND status='active' AND expires_at>datetime('now')
    `).bind(user.id).first();
    if (Number(active.count) >= 1) return bad('Solo podés tener una publicación activa a la vez');

    const prices = { like:1, comment:2, repost:3, mention:3 };
    const clean = [];
    for (const a of actions) {
      const type = String(a.type || '').toLowerCase();
      const target = Math.max(1, Math.min(20, Number(a.target || 1)));
      if (!(type in prices) || clean.some(x => x.type === type)) continue;
      clean.push({
        type,
        target,
        reward: prices[type],
        verification: type === 'comment' ? 'automatic' : 'trust'
      });
    }
    if (!clean.length) return bad('Acciones inválidas');

    const cost = clean.reduce((n,a) => n + a.reward * a.target, 0);
    const latest = await env.DB.prepare('SELECT points FROM users WHERE id=?').bind(user.id).first();
    if (Number(latest.points) < cost) return bad(`No tenés puntos suficientes. Costo: ${cost}`);

    let postId = null;
    try {
      const insert = await env.DB.prepare(`
        INSERT INTO posts(user_id,platform,url,title,expires_at)
        VALUES(?,?,?,?,datetime('now','+24 hours'))
      `).bind(user.id, platform, urlValue, title).run();

      postId = Number(insert.meta?.last_row_id || 0);
      if (!postId) throw new Error('D1 no devolvió el id de la campaña');

      const stmts = clean.map(a => env.DB.prepare(`
        INSERT INTO post_actions(post_id,action_type,reward_points,target_count,verification_mode)
        VALUES(?,?,?,?,?)
      `).bind(postId,a.type,a.reward,a.target,a.verification));

      stmts.push(env.DB.prepare('UPDATE users SET points=points-? WHERE id=? AND points>=?').bind(cost,user.id,cost));
      stmts.push(env.DB.prepare(`INSERT INTO point_transactions(user_id,amount,type,post_id,note)
        VALUES(?,?,'campaign_hold',?,'Puntos reservados para campaña')`).bind(user.id,-cost,postId));

      await env.DB.batch(stmts);
      const post = await env.DB.prepare(`SELECT id,url,title,platform,created_at,expires_at FROM posts WHERE id=?`).bind(postId).first();
      return json({ post, cost, actions: clean }, 201);
    } catch (e) {
      console.error('post_create_failed', e?.message || String(e));
      if (postId) {
        try { await env.DB.prepare('DELETE FROM posts WHERE id=?').bind(postId).run(); } catch {}
      }
      if (String(e).includes('UNIQUE')) return bad('Esa publicación ya fue cargada', 409);
      return bad(`No se pudo crear la campaña: ${e?.message || 'error interno'}`, 500);
    }
  }

  const completeMatch = url.pathname.match(/^\/api\/actions\/(\d+)\/complete$/);
  if (request.method === 'POST' && completeMatch) {
    const actionId = Number(completeMatch[1]);
    const action = await env.DB.prepare(`
      SELECT a.*,p.user_id owner_id,p.status,p.expires_at,p.url
      FROM post_actions a JOIN posts p ON p.id=a.post_id
      WHERE a.id=?
    `).bind(actionId).first();

    if (!action || action.status !== 'active') return bad('La acción ya no está disponible', 410);
    if (new Date(String(action.expires_at).replace(' ','T')+'Z') <= new Date()) return bad('La acción ya no está disponible', 410);
    if (Number(action.owner_id) === Number(user.id)) return bad('No podés completar tu propia campaña');
    if (action.verification_mode === 'automatic') return bad('Esta acción requiere verificación automática de Instagram', 409);

    let participationId = null;
    try {
      const insert = await env.DB.prepare(`
        INSERT INTO participations(post_action_id,user_id,status)
        VALUES(?,?,'claimed')
      `).bind(actionId,user.id).run();
      participationId = Number(insert.meta?.last_row_id || 0);
      if (!participationId) throw new Error('D1 no devolvió el id de participación');
    } catch (e) {
      if (String(e).includes('UNIQUE')) return bad('Ya completaste esta acción', 409);
      return bad('No se pudo reservar la acción', 500);
    }

    const slot = await env.DB.prepare(`
      UPDATE post_actions SET completed_count=completed_count+1
      WHERE id=? AND completed_count<target_count
    `).bind(actionId).run();

    if (!Number(slot.meta?.changes || 0)) {
      await env.DB.prepare('DELETE FROM participations WHERE id=?').bind(participationId).run();
      return bad('Esta acción ya completó su cupo', 409);
    }

    try {
      await env.DB.batch([
        env.DB.prepare(`UPDATE participations SET status='verified',verified_at=datetime('now') WHERE id=?`).bind(participationId),
        env.DB.prepare('UPDATE users SET points=points+? WHERE id=?').bind(action.reward_points,user.id),
        env.DB.prepare(`INSERT INTO point_transactions(user_id,amount,type,post_id,participation_id,note)
          VALUES(?,?,'action_reward',?,?,?)`)
          .bind(user.id,action.reward_points,action.post_id,participationId,`Recompensa por ${action.action_type}`)
      ]);
      return json({ ok:true, reward:Number(action.reward_points), participation_id:participationId });
    } catch (e) {
      await env.DB.batch([
        env.DB.prepare('UPDATE post_actions SET completed_count=MAX(completed_count-1,0) WHERE id=?').bind(actionId),
        env.DB.prepare('DELETE FROM participations WHERE id=?').bind(participationId)
      ]);
      return bad('No se pudo acreditar la acción', 500);
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/my-posts') {
    const { results = [] } = await env.DB.prepare(`
      SELECT p.*,
        COALESCE(SUM(a.target_count*a.reward_points),0) budget,
        COALESCE(SUM(a.completed_count*a.reward_points),0) spent
      FROM posts p LEFT JOIN post_actions a ON a.post_id=p.id
      WHERE p.user_id=?
      GROUP BY p.id ORDER BY p.id DESC LIMIT 20
    `).bind(user.id).all();
    return json({ posts: results });
  }

  return bad('Ruta no encontrada', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(request, env, url);
    return env.ASSETS.fetch(request);
  }
};
