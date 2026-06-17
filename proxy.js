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
