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
    await env.DB.prepare('UPDATE sessions SET created_at=CURRENT_TIMESTAMP WHERE token=?').bind(token).run();
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

    await env.DB.prepare(`
      UPDATE participations SET status='rejected'
      WHERE status='claimed' AND post_action_id IN (SELECT id FROM post_actions WHERE post_id=?)
    `).bind(post.id).run();

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

async function getAction(env, actionId) {
  return env.DB.prepare(`
    SELECT a.*,p.user_id owner_id,p.status post_status,p.expires_at,p.url,p.id post_id
    FROM post_actions a JOIN posts p ON p.id=a.post_id
    WHERE a.id=?
  `).bind(actionId).first();
}

function actionAvailable(action) {
  if (!action || action.post_status !== 'active') return false;
  const expires = new Date(String(action.expires_at).replace(' ', 'T') + 'Z');
  return expires > new Date();
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
          a.action_type detail,x.verified_at created_at
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
        (SELECT x.status FROM participations x WHERE x.post_action_id=a.id AND x.user_id=? LIMIT 1) my_status
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
        verification:r.verification_mode,my_status:r.my_status || null
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

  const cancelMatch = url.pathname.match(/^\/api\/posts\/(\d+)\/cancel$/);
  if (request.method === 'POST' && cancelMatch) {
    const postId = Number(cancelMatch[1]);
    const post = await env.DB.prepare(`
      SELECT p.id,p.user_id,p.status,
        COALESCE(SUM((a.target_count-a.completed_count)*a.reward_points),0) refund
      FROM posts p LEFT JOIN post_actions a ON a.post_id=p.id
      WHERE p.id=? GROUP BY p.id
    `).bind(postId).first();

    if (!post || Number(post.user_id) !== Number(user.id)) return bad('Campaña no encontrada', 404);
    if (post.status !== 'active') return bad('La campaña ya no está activa', 409);

    const changed = await env.DB.prepare(`
      UPDATE posts SET status='cancelled' WHERE id=? AND user_id=? AND status='active'
    `).bind(postId, user.id).run();
    if (!Number(changed.meta?.changes || 0)) return bad('La campaña ya no está activa', 409);

    await env.DB.prepare(`
      UPDATE participations SET status='rejected'
      WHERE status='claimed' AND post_action_id IN (SELECT id FROM post_actions WHERE post_id=?)
    `).bind(postId).run();

    const refund = Number(post.refund || 0);
    if (refund > 0) {
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET points=points+? WHERE id=?').bind(refund, user.id),
        env.DB.prepare(`INSERT INTO point_transactions(user_id,amount,type,post_id,note)
          VALUES(?,?,'campaign_refund',?,'Campaña cancelada · puntos no utilizados')`).bind(user.id, refund, postId)
      ]);
    }
    return json({ ok:true, refund });
  }

  const startMatch = url.pathname.match(/^\/api\/actions\/(\d+)\/start$/);
  if (request.method === 'POST' && startMatch) {
    const actionId = Number(startMatch[1]);
    const action = await getAction(env, actionId);
    if (!actionAvailable(action)) return bad('La acción ya no está disponible', 410);
    if (Number(action.owner_id) === Number(user.id)) return bad('No podés completar tu propia campaña');
    if (Number(action.completed_count) >= Number(action.target_count)) return bad('Esta acción ya completó su cupo', 409);

    const existing = await env.DB.prepare(`
      SELECT id,status,created_at,verified_at FROM participations
      WHERE post_action_id=? AND user_id=? LIMIT 1
    `).bind(actionId, user.id).first();
    if (existing) return json({ participation: existing, verification: action.verification_mode });

    try {
      const insert = await env.DB.prepare(`
        INSERT INTO participations(post_action_id,user_id,status) VALUES(?,?,'claimed')
      `).bind(actionId, user.id).run();
      return json({
        participation: { id:Number(insert.meta?.last_row_id || 0), status:'claimed' },
        verification: action.verification_mode
      }, 201);
    } catch (e) {
      if (String(e).includes('UNIQUE')) {
        const again = await env.DB.prepare(`SELECT id,status,created_at,verified_at FROM participations WHERE post_action_id=? AND user_id=? LIMIT 1`).bind(actionId,user.id).first();
        return json({ participation: again, verification: action.verification_mode });
      }
      return bad('No se pudo iniciar la acción', 500);
    }
  }

  const completeMatch = url.pathname.match(/^\/api\/actions\/(\d+)\/complete$/);
  if (request.method === 'POST' && completeMatch) {
    const actionId = Number(completeMatch[1]);
    const action = await getAction(env, actionId);
    if (!actionAvailable(action)) return bad('La acción ya no está disponible', 410);
    if (Number(action.owner_id) === Number(user.id)) return bad('No podés completar tu propia campaña');
    if (action.verification_mode === 'automatic') return bad('Esta acción se acredita cuando Instagram la verifica', 409);

    let participation = await env.DB.prepare(`
      SELECT id,status FROM participations WHERE post_action_id=? AND user_id=? LIMIT 1
    `).bind(actionId, user.id).first();

    if (participation?.status === 'verified') return bad('Ya completaste esta acción', 409);
    if (participation?.status === 'rejected') return bad('Esta participación ya no está disponible', 409);

    if (!participation) {
      try {
        const insert = await env.DB.prepare(`
          INSERT INTO participations(post_action_id,user_id,status) VALUES(?,?,'claimed')
        `).bind(actionId, user.id).run();
        participation = { id:Number(insert.meta?.last_row_id || 0), status:'claimed' };
      } catch (e) {
        if (String(e).includes('UNIQUE')) {
          participation = await env.DB.prepare(`SELECT id,status FROM participations WHERE post_action_id=? AND user_id=? LIMIT 1`).bind(actionId,user.id).first();
        } else {
          return bad('No se pudo reservar la acción', 500);
        }
      }
    }

    const slot = await env.DB.prepare(`
      UPDATE post_actions SET completed_count=completed_count+1
      WHERE id=? AND completed_count<target_count
    `).bind(actionId).run();

    if (!Number(slot.meta?.changes || 0)) {
      await env.DB.prepare(`UPDATE participations SET status='rejected' WHERE id=? AND status='claimed'`).bind(participation.id).run();
      return bad('Esta acción ya completó su cupo', 409);
    }

    try {
      await env.DB.batch([
        env.DB.prepare(`UPDATE participations SET status='verified',verified_at=datetime('now') WHERE id=?`).bind(participation.id),
        env.DB.prepare('UPDATE users SET points=points+? WHERE id=?').bind(action.reward_points,user.id),
        env.DB.prepare(`INSERT INTO point_transactions(user_id,amount,type,post_id,participation_id,note)
          VALUES(?,?,'action_reward',?,?,?)`)
          .bind(user.id,action.reward_points,action.post_id,participation.id,`Recompensa por ${action.action_type}`)
      ]);

      const incomplete = await env.DB.prepare(`
        SELECT COUNT(*) count FROM post_actions WHERE post_id=? AND completed_count<target_count
      `).bind(action.post_id).first();
      if (Number(incomplete?.count || 0) === 0) {
        await env.DB.prepare(`UPDATE posts SET status='completed' WHERE id=? AND status='active'`).bind(action.post_id).run();
      }

      return json({ ok:true, reward:Number(action.reward_points), participation_id:participation.id });
    } catch (e) {
      await env.DB.batch([
        env.DB.prepare('UPDATE post_actions SET completed_count=MAX(completed_count-1,0) WHERE id=?').bind(actionId),
        env.DB.prepare(`UPDATE participations SET status='claimed',verified_at=NULL WHERE id=?`).bind(participation.id)
      ]);
      return bad('No se pudo acreditar la acción', 500);
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/my-posts') {
    const { results: rows = [] } = await env.DB.prepare(`
      SELECT p.id,p.url,p.title,p.platform,p.status,p.created_at,p.expires_at,
        a.id action_id,a.action_type,a.reward_points,a.target_count,a.completed_count,a.verification_mode
      FROM posts p LEFT JOIN post_actions a ON a.post_id=p.id
      WHERE p.user_id=?
      ORDER BY p.id DESC,a.id ASC
      LIMIT 120
    `).bind(user.id).all();

    const { results: people = [] } = await env.DB.prepare(`
      SELECT p.id post_id,a.id action_id,x.id participation_id,x.status,x.created_at,x.verified_at,
        u.id user_id,u.username,u.instagram_username
      FROM participations x
      JOIN post_actions a ON a.id=x.post_action_id
      JOIN posts p ON p.id=a.post_id
      JOIN users u ON u.id=x.user_id
      WHERE p.user_id=?
      ORDER BY x.id DESC
      LIMIT 300
    `).bind(user.id).all();

    const posts = new Map();
    for (const r of rows) {
      if (!posts.has(r.id)) {
        posts.set(r.id, {
          id:r.id,url:r.url,title:r.title,platform:r.platform,status:r.status,
          created_at:r.created_at,expires_at:r.expires_at,budget:0,spent:0,actions:[]
        });
      }
      if (r.action_id) {
        const a = {
          id:r.action_id,type:r.action_type,reward:Number(r.reward_points),target:Number(r.target_count),
          completed:Number(r.completed_count),verification:r.verification_mode,participants:[]
        };
        posts.get(r.id).budget += a.reward * a.target;
        posts.get(r.id).spent += a.reward * a.completed;
        posts.get(r.id).actions.push(a);
      }
    }

    for (const person of people) {
      const post = posts.get(person.post_id);
      if (!post) continue;
      const action = post.actions.find(a => Number(a.id) === Number(person.action_id));
      if (!action) continue;
      action.participants.push({
        id:person.participation_id,user_id:person.user_id,username:person.username,
        instagram_username:person.instagram_username,status:person.status,
        created_at:person.created_at,verified_at:person.verified_at
      });
    }

    return json({ posts:[...posts.values()] });
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
