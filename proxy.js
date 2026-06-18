/**
 * 长安游伴 · API代理 + Token验证服务器
 * 用途：静态文件服务 + DeepSeek API代理 + 一次性Token验证
 * 
 * 启动方式：node proxy.js
 * 默认端口：3457
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ============================================
// 🔑 配置区
// ============================================
const DEEPSEEK_API_KEY = 'sk-2061c4530730466589b025bd975a7bed';
const AMAP_WEB_KEY = 'bb7f0c78ad5530def46192c141edf568'; // 高德Web服务API Key（已更新 2026-06-17）
const AMAP_JS_KEY  = 'bb7f0c78ad5530def46192c141edf568'; // 高德JS API Key（前端用，同Web服务Key）
const PORT = 3457;
const ADMIN_KEY = 'changan2026'; // 管理密钥：用于创建token
const TOKENS_FILE = path.join(os.tmpdir(), 'changan-tokens.json');

const STATIC_EXTS = ['.html', '.js', '.css', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.txt'];

// ============================================
// 内部工具函数（供 enrich-poi 使用）
// ============================================
function fetchJSONInternal(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 12000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON解析失败: ' + e.message + ' | raw: ' + data.substring(0, 200))); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('高德API超时')); });
  });
}

function callDeepSeekInternal(prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 600
    });
    const options = {
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 30000
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0]) resolve(json.choices[0].message.content);
          else reject(new Error('DeepSeek返回异常: ' + data.substring(0, 200)));
        } catch(e) { reject(new Error('DeepSeek解析失败: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('DeepSeek请求超时')); });
    req.write(payload);
    req.end();
  });
}

// ============================================
// Token 管理
// ============================================
function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    }
  } catch (e) { console.error('读取tokens.json失败:', e.message); }
  return {};
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf-8');
}

function createToken() {
  const tokens = loadTokens();
  const token = 'cayb_' + crypto.randomBytes(12).toString('hex');
  tokens[token] = { used: false, created_at: new Date().toISOString(), used_at: null };
  saveTokens(tokens);
  return token;
}

function verifyToken(token) {
  const tokens = loadTokens();
  const info = tokens[token];
  if (!info) return { valid: false, reason: '无效的访问码' };
  if (info.used) return { valid: false, reason: '此访问码已被使用' };
  return { valid: true, info };
}

function useToken(token) {
  const tokens = loadTokens();
  if (!tokens[token] || tokens[token].used) return false;
  tokens[token].used = true;
  tokens[token].used_at = new Date().toISOString();
  saveTokens(tokens);
  return true;
}

// ============================================
// HTTP 服务器
// ============================================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // 绕过 localtunnel 的"Click to Continue"拦截页面
  res.setHeader('bypass-tunnel-reminder', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost:' + PORT);
  const urlPath = url.pathname;

  // ===== 获取公网 URL =====
  if (req.method === 'GET' && urlPath === '/api/public-url') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: publicUrl || '', status: publicUrl ? 'connected' : 'connecting' }));
    return;
  }

  // ===== Token API =====
  if (urlPath === '/api/token') {
    const action = url.searchParams.get('action');
    const token = url.searchParams.get('token');
    const adminKey = url.searchParams.get('key');

    if (action === 'verify' && token) {
      const result = verifyToken(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (action === 'create' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (data.key !== ADMIN_KEY) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '管理密钥错误' }));
            return;
          }
          const count = parseInt(data.count) || 1;
          if (count === 1) {
            const token = createToken();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ token, count: 1 }));
          } else {
            const tokens = [];
            for (let i = 0; i < count; i++) {
              tokens.push(createToken());
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tokens, count }));
          }
        } catch (e) {
          console.error('create token error:', e.message, 'body:', body);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '请求格式错误: ' + e.message }));
        }
      });
      return;
    }

    if (action === 'list' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (data.key !== ADMIN_KEY) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '管理密钥错误' }));
            return;
          }
          const tokens = loadTokens();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tokens }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '请求格式错误' }));
        }
      });
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '无效的操作，支持: verify, create, list' }));
    return;
  }

  // ===== API代理：/api/chat（免费开放，支付墙由前端控制）=====
  if (req.method === 'POST' && urlPath === '/api/chat') {
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'YOUR_DEEPSEEK_API_KEY') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API Key未配置', code: 'NO_API_KEY' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      console.log('📤 转发请求到 DeepSeek...');

      const options = {
        hostname: 'api.deepseek.com',
        path: '/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 60000
      };

      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          console.log('✅ DeepSeek 响应: HTTP ' + apiRes.statusCode);
          res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });

      apiReq.on('error', (err) => {
        console.error('❌ 请求失败:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '代理请求失败', message: err.message }));
      });

      apiReq.on('timeout', () => {
        apiReq.destroy();
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '请求超时' }));
      });

      apiReq.write(body);
      apiReq.end();
    });
    return;
  }

  // ===== API代理：/api/deepseek（不消耗Token，用于预览数据）=====
  if (req.method === 'POST' && urlPath === '/api/deepseek') {
    // 免费开放，不验证Token
    if (!DEEPSEEK_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API Key未配置' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      console.log('📤 [预览] 转发请求到 DeepSeek...');

      const options = {
        hostname: 'api.deepseek.com',
        path: '/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 30000
      };

      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });

      apiReq.on('timeout', () => { apiReq.destroy(); res.writeHead(504); res.end(JSON.stringify({ error: '请求超时' })); });
      apiReq.on('error', (e) => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
      apiReq.write(body);
      apiReq.end();
    });
    return;
  }

  // ===== 攻略生成端点：/api/guide?name=xxx =====
  if (req.method === 'GET' && urlPath === '/api/guide') {
    const name = url.searchParams.get('name');
    if (!name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '缺少景点名称' }));
      return;
    }

    const fs = require('fs');
    const path = require('path');
    const guidesDir = path.join(__dirname, 'guides');
    const cacheFile = path.join(guidesDir, name + '.json');

    // 1. 检查缓存
    if (fs.existsSync(cacheFile)) {
      console.log('📋 攻略缓存命中:', name);
      const cached = fs.readFileSync(cacheFile, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(cached);
      return;
    }

    // 2. 调用DeepSeek生成
    if (!DEEPSEEK_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API Key未配置' }));
      return;
    }

    console.log('📸 生成攻略:', name);

    const prompt = `请为西安景点"${name}"生成以下内容（简洁实用，每条不超过30字）：

1. 游玩攻略：最佳游玩时间、推荐路线、必看景点、附近美食
2. 避坑指南：常见陷阱、省钱技巧、注意事项

格式严格如下（不要多余解释）：
攻略：
- 最佳时间：...
- 路线：...
- 必看：...
- 美食：...

避坑：
- ...
- ...`;

    const requestBody = JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 800,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
        'Content-Length': Buffer.byteLength(requestBody)
      },
      timeout: 30000
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices[0].message.content;

          // 解析content
          const guideMatch = content.match(/攻略：([\s\S]*?)避坑：/);
          const pitfallsMatch = content.match(/避坑：([\s\S]*)/);

          const guide = guideMatch ? guideMatch[1].trim() : '暂无攻略';
          const pitfalls = pitfallsMatch ? pitfallsMatch[1].trim() : '暂无避坑指南';

          const result = { guide, pitfalls };

          // 保存到缓存
          if (!fs.existsSync(guidesDir)) {
            fs.mkdirSync(guidesDir, { recursive: true });
          }
          fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8');
          console.log('✅ 攻略已缓存:', name);

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (e) {
          console.error('❌ 解析DeepSeek响应失败:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '解析响应失败: ' + e.message }));
        }
      });
    });

    apiReq.on('error', (err) => {
      console.error('❌ DeepSeek请求失败:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'DeepSeek请求失败', message: err.message }));
    });

    apiReq.on('timeout', () => {
      apiReq.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '请求超时' }));
    });

    apiReq.write(requestBody);
    apiReq.end();
    return;
  }

  // ===== 自增长数据库：当AI推荐的POI在本地DB不存在时，自动从高德+DeepSeek抓取并保存 =====
  if (req.method === 'POST' && urlPath === '/api/enrich-poi') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { name, type } = JSON.parse(body); // type: attractions|foods|hotels|experience
        if (!name || !type) { res.writeHead(400); res.end(JSON.stringify({ error: 'name和type必填' })); return; }

        const dbFile = path.join(__dirname, 'data', type + '.json');
        let db = [];
        try { db = JSON.parse(fs.readFileSync(dbFile, 'utf-8')); } catch(e) { db = []; }

        // 已存在则直接返回（宽松匹配：双向 includes 或前3字相同）
        const shortName = name.length >= 3 ? name.substring(0, 3) : name;
        const existing = db.find(item => item.name && (
          item.name.includes(name) || name.includes(item.name) ||
          (shortName.length >= 3 && item.name.startsWith(shortName))
        ));
        if (existing) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, item: existing, source: 'cache' }));
          return;
        }

        console.log(`🔍 DB未命中，从高德抓取: [${type}] ${name}`);

        // 1. 高德POI搜索（精准搜索+extensions=all）
        const typeMap = { attractions: '风景名胜|科教文化服务', foods: '餐饮服务', hotels: '住宿服务', experience: '休闲娱乐|购物服务' };
        const amapSearchUrl = `https://restapi.amap.com/v3/place/text?keywords=${encodeURIComponent(name)}&city=西安&citylimit=true&types=${encodeURIComponent(typeMap[type]||'')}&extensions=all&output=JSON&key=${AMAP_WEB_KEY}`;

        const amapData = await fetchJSONInternal(amapSearchUrl);
        const pois = (amapData && amapData.pois) ? amapData.pois : [];
        const poi = pois[0]; // 取第一个最相关结果

        if (!poi) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '高德未找到该POI: ' + name }));
          return;
        }

        // 2. 提取图片
        let images = [];
        if (poi.photos && Array.isArray(poi.photos)) {
          images = poi.photos.slice(0, 6).map(p => typeof p === 'string' ? p : (p.url || '')).filter(Boolean);
        }

        // 3. 解析坐标
        let lat = null, lng = null;
        if (poi.location) {
          const parts = poi.location.split(',');
          lng = parseFloat(parts[0]);
          lat = parseFloat(parts[1]);
        }

        // 4. 提取字段
        const safeStr = v => (typeof v === 'string' ? v : (Array.isArray(v) ? v.join(',') : String(v||'')));
        const biz = poi.biz_ext || {};
        const rating = parseFloat(biz.rating) || parseFloat(poi.biz_type) || null;
        const tel = safeStr(poi.tel);
        const address = safeStr(poi.address);
        const adname = safeStr(poi.adname);
        const openTime = safeStr(biz.open_time || poi.business_area || '');
        const tag = safeStr(poi.tag);
        const desc = (poi.biz_ext && poi.biz_ext.intro) ? safeStr(poi.biz_ext.intro) : (tag ? tag.split(';')[0] : '');
        const catMap = { attractions: '景点', foods: '美食', hotels: '酒店', experience: '体验' };

        // 5. 模板化攻略（不调DeepSeek，省积分！核心AI规划只调一次）
        const catLabel = catMap[type] || type;
        const templateGuide = {
          attractions: `${name}是西安标志性景点，建议预留2-3小时游览，深入感受千年古都的历史底蕴。`,
          foods: `${name}是西安地道美食，老西安人都知道的好味道，来西安必尝的经典。`,
          hotels: `${name}地处西安核心区域，交通便利，周边餐饮购物方便，是旅居西安的理想之选。`,
          experience: `${name}是西安特色文化体验，沉浸式感受古都魅力，值得专门安排时间前往。`
        };
        const guide = templateGuide[type] || `${name}是西安值得一去的${catLabel}。`;
        const pitfalls = desc ? `${desc}。建议提前查询营业时间，节假日人多建议错峰。` : '建议提前查询营业时间，节假日人多建议错峰出行。';
        const mustSee = `${name}——来西安不可错过。`;

        // 6. 构建新条目
        const newItem = {
          id: poi.id || ('ai_' + Date.now()),
          name: poi.name || name,
          cat: catMap[type] || type,
          desc: desc || mustSee,
          address: address,
          adname: adname,
          lat: lat,
          lng: lng,
          coord: (lng && lat) ? (lng + ',' + lat) : '',
          rating: rating,
          tel: tel,
          openTime: openTime,
          images: images,
          guide: guide,
          pitfalls: pitfalls,
          mustSee: mustSee,
          tag: tag,
          source: 'amap_enrich',
          createdAt: new Date().toISOString()
        };

        // 7. 不再保存到本地数据库（避免污染DB文件，仅当前会话使用）
        // db.push(newItem);
        // fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), 'utf-8');
        console.log(`✅ 临时富化: [${type}] ${newItem.name}（不写入DB）`);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, item: newItem, source: 'amap_fresh' }));

      } catch(e) {
        console.error('❌ enrich-poi失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ===== 意见反馈 API =====
  if (req.method === 'POST' && urlPath === '/api/feedback') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const feedbackFile = path.join(__dirname, 'data', 'feedback.json');
        let list = [];
        try { list = JSON.parse(fs.readFileSync(feedbackFile, 'utf-8')); } catch(e) {}
        list.unshift({ ...data, id: Date.now(), ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '' });
        if (list.length > 500) list = list.slice(0, 500);
        fs.writeFileSync(feedbackFile, JSON.stringify(list, null, 2), 'utf-8');
        console.log('📝 收到反馈:', data.type, '—', data.content.substring(0, 50));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('❌ 反馈保存失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ===== 高德API代理：附近POI搜索 =====
  if (req.method === 'GET' && urlPath.startsWith('/api/amap/')) {
    const apiPath = urlPath.replace('/api/amap/', '');
    const amapUrl = new URL('https://restapi.amap.com/' + apiPath);
    // 把前端传来的参数转发，并注入 Key
    url.searchParams.forEach((v, k) => amapUrl.searchParams.set(k, v));
    amapUrl.searchParams.set('key', AMAP_WEB_KEY);

    console.log('📍 高德API:', apiPath, amapUrl.searchParams.toString().substring(0, 80));

    const options = {
      hostname: 'restapi.amap.com',
      path: amapUrl.pathname + amapUrl.search,
      method: 'GET',
      timeout: 10000
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(data);
      });
    });

    apiReq.on('error', (err) => {
      console.error('❌ 高德API错误:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '高德API请求失败', message: err.message }));
    });

    apiReq.on('timeout', () => {
      apiReq.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '高德API请求超时' }));
    });

    apiReq.end();
    return;
  }

  // ===== 静态文件服务 =====
  if (req.method === 'GET') {
    let filePath = urlPath;
    if (filePath === '/') filePath = '/index.html';

    const ext = path.extname(filePath).toLowerCase();
    if (STATIC_EXTS.includes(ext)) {
      const fullPath = path.join(__dirname, filePath);
      if (!fullPath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
        '.txt': 'text/plain; charset=utf-8'
      };

      fs.readFile(fullPath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('404 Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(data);
      });
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   🏮 长安游伴 · 服务器已启动            ║');
  console.log('║   地址: http://localhost:' + PORT + '              ║');
  console.log('║   管理: http://localhost:' + PORT + '/admin.html     ║');
  console.log('║   API:  POST /api/chat?token=xxx        ║');
  console.log('║   API:  POST /api/deepseek?token=xxx    ║');
  console.log('╚══════════════════════════════════════════╝');
  
  if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'YOUR_DEEPSEEK_API_KEY') {
    console.warn('⚠️  API Key 尚未配置！');
  } else {
    console.log('✅  API Key 已配置');
  }
  console.log('✅  Token管理已启用 (管理密钥: ' + ADMIN_KEY + ')');
  
  // ===== 自动开启内网穿透 =====
  startLocaltunnel();
});

// 内网穿透（localtunnel）
const NODE_MODULES_PATH = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules';
let publicUrl = '';

async function startLocaltunnel() {
  try {
    // 尝试 require localtunnel
    let lt;
    try {
      lt = require(NODE_MODULES_PATH + '/localtunnel');
    } catch(e) {
      console.log('⚠️  localtunnel 未安装，跳过内网穿透');
      console.log('   手动启动穿透: node tunnel.js');
      return;
    }
    
    console.log('\n🌐 正在启动内网穿透...');
    
    let tunnel;
    try {
      tunnel = await lt({ port: PORT, subdomain: 'changan-youban' });
    } catch(e) {
      // 子域名被占用，用随机域名
      tunnel = await lt({ port: PORT });
    }
    
    publicUrl = tunnel.url;
    
    // 保存到文件（用 os.tmpdir 避免权限问题）
    const urlFile1 = path.join(os.tmpdir(), 'changan-tunnel-url.txt');
    const urlFile2 = path.join(__dirname, 'tunnel-url.txt');
    try { fs.writeFileSync(urlFile1, publicUrl); } catch(e) {}
    try { fs.writeFileSync(urlFile2, publicUrl); } catch(e) { /* Desktop 目录可能无写权限 */ }
    
    console.log('\n╔═══════════════════════════════════════════════════╗');
    console.log('║  🌐 内网穿透成功！公网地址：                      ║');
    console.log('║  ' + publicUrl.padEnd(51) + '║');
    console.log('╚═══════════════════════════════════════════════════╝');
    console.log('  📱 管理后台: ' + publicUrl + '/admin.html');
    console.log('  🔗 买家链接: ' + publicUrl + '/index.html?token=TOKEN\n');
    
    tunnel.on('close', () => {
      console.log('\n⚠️  隧道断开，3秒后重连...');
      setTimeout(() => startLocaltunnel(), 3000);
    });
    
    tunnel.on('error', (err) => {
      console.error('隧道错误:', err.message);
    });
    
  } catch(err) {
    console.error('⚠️  内网穿透失败:', err.message);
    console.log('   服务器本地可正常使用，公网访问需手动配置');
  }
}
