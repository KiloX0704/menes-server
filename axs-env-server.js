#!/usr/bin/env node
/**
 * AXS Environment Management HTTP API Server
 *
 * 独立运行的 HTTP API 服务器，与 OpenClaw 分离部署
 * 提供完整的环境变量管理能力，支持多租户 workspace
 * 通过 openclaw CLI 自动初始化完整的 agent workspace
 *
 * 用法:
 *   node axs-env-api-server.js --port 18999
 *   node axs-env-api-server.js start/stop/status
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// ==================== 配置 ====================
const DEFAULT_PORT = parseInt(process.env.PORT) || 18999;
const OPENCLAW_BASE = process.env.OPENCLAW_BASE || '/openclaw/data';
const SHARED_FILES_DIR = process.env.SHARED_FILES_DIR || path.join(OPENCLAW_BASE, 'skills');

// 敏感变量列表 - 默认隐藏
const SENSITIVE_VARS = [
  'AXS_API_TOKEN',
  'APIFOX_API_TOKEN',
  'AXS_USER_UUID'
];

// 共享文件列表 - 用 symlink 链接到每个 workspace
const SHARED_FILES = ['SOUL.md', 'IDENTITY.md'];

// ==================== 工具函数 ====================

/**
 * Agent ID 命名规则（对齐目录名）
 */
function agentIdFor(user_id) {
  return `user_admin_${user_id}`;
}

/**
 * Workspace 路径
 */
function workspacePathFor(tenant_name, user_id) {
  return path.join(OPENCLAW_BASE, `workspace_${tenant_name}_${user_id}`);
}

/**
 * .env.axs 文件路径
 */
function envFilePathFor(tenant_name, user_id) {
  return path.join(workspacePathFor(tenant_name, user_id), '.env.axs');
}

/**
 * 转义 env 值中的特殊字符
 */
function escapeEnvValue(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
}

/**
 * 写入/更新 .env.axs 文件（export KEY="VALUE" 格式）
 */
function upsertEnvFileExports(filePath, exportsMap) {
  const normalized = {};
  for (const [k, v] of Object.entries(exportsMap || {})) {
    if (v === undefined || v === null) continue;
    normalized[k] = escapeEnvValue(v);
  }
  if (Object.keys(normalized).length === 0) return;

  let existing = '';
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, 'utf8');
  } else {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const lines = existing ? existing.split('\n') : [];
  const idxByKey = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^export\s+([A-Z0-9_]+)="([\s\S]*)"$/);
    if (m) idxByKey.set(m[1], i);
  }

  for (const [k, v] of Object.entries(normalized)) {
    const newLine = `export ${k}="${v}"`;
    const idx = idxByKey.get(k);
    if (idx === undefined) lines.push(newLine);
    else lines[idx] = newLine;
  }

  fs.writeFileSync(filePath, lines.join('\n').trimEnd() + '\n', 'utf8');
}

// ==================== 核心逻辑 ====================

/**
 * 检查 agent 是否已在 openclaw 中注册
 */
function isAgentRegistered(agentId) {
  try {
    const output = execSync('openclaw agents list --json 2>/dev/null', {
      encoding: 'utf8',
      timeout: 15000
    });
    const agents = JSON.parse(output.trim());
    return agents.some(a => a.id === agentId);
  } catch (e) {
    console.warn(`[ensure] Failed to list agents: ${e.message}`);
    return false;
  }
}

/**
 * 通过 openclaw CLI 创建 agent + workspace
 * CLI 会自动：
 *   - 创建 workspace 目录
 *   - 生成标准文件（AGENTS.md, TOOLS.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md, SOUL.md, IDENTITY.md）
 *   - 初始化 .git
 *   - 创建 .openclaw/workspace-state.json
 *   - 注册到 openclaw.json
 */
function createAgentViaCli(agentId, wsPath) {
  try {
    const cmd = `openclaw agents add ${JSON.stringify(agentId)} --workspace ${JSON.stringify(wsPath)} --non-interactive --json`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
    console.log(`[ensure] Created agent via CLI: ${agentId}`);
    return { success: true, output: result.trim() };
  } catch (e) {
    console.error(`[ensure] CLI agent creation failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * 将共享文件替换为 symlink
 * 删除 CLI 生成的默认文件，指向 SHARED_FILES_DIR 下的共享版本
 */
function setupSharedSymlinks(wsPath) {
  const linked = [];
  const skipped = [];

  for (const file of SHARED_FILES) {
    const src = path.join(SHARED_FILES_DIR, file);
    const dest = path.join(wsPath, file);

    // 源文件不存在则跳过
    if (!fs.existsSync(src)) {
      console.warn(`[symlink] Shared file not found: ${src}`);
      skipped.push(file);
      continue;
    }

    // 检查目标是否已是正确的 symlink
    if (fs.existsSync(dest) || fs.lstatSync(dest).isSymbolicLink()) {
      try {
        const stat = fs.lstatSync(dest);
        if (stat.isSymbolicLink()) {
          const target = fs.readlinkSync(dest);
          if (target === src) {
            skipped.push(file);
            continue; // 已正确，跳过
          }
        }
        // 删除旧文件（普通文件或错误的 symlink）
        fs.unlinkSync(dest);
      } catch (e) {
        // dest 不存在，直接创建 symlink
      }
    }

    fs.symlinkSync(src, dest);
    linked.push(file);
    console.log(`[symlink] ${file} → ${src}`);
  }

  return { linked, skipped };
}

/**
 * 完整的 agent 初始化流程
 * 1. 检查是否已存在
 * 2. CLI 创建 agent + workspace
 * 3. 替换共享文件为 symlink
 * 4. 写入 .env.axs
 */
function ensureAgentFull(tenant_name, user_id, envVars) {
  const agentId = agentIdFor(user_id);
  const wsPath = workspacePathFor(tenant_name, user_id);
  const envPath = envFilePathFor(tenant_name, user_id);

  let created = false;
  let cliOutput = null;
  let cliError = null;

  // Step 1: 检查 agent 是否已存在
  const alreadyExists = isAgentRegistered(agentId);

  // Step 2: 不存在则通过 CLI 创建
  if (!alreadyExists) {
    const result = createAgentViaCli(agentId, wsPath);
    if (result.success) {
      created = true;
      cliOutput = result.output;
    } else {
      cliError = result.error;
      // Fallback: 手动创建目录（CLI 失败时的兜底）
      if (!fs.existsSync(wsPath)) {
        fs.mkdirSync(wsPath, { recursive: true });
        console.log(`[ensure] Fallback: created workspace dir manually`);
      }
    }
  } else {
    // 已存在但 workspace 目录不在 → 手动补建
    if (!fs.existsSync(wsPath)) {
      fs.mkdirSync(wsPath, { recursive: true });
      console.log(`[ensure] Agent exists but workspace missing, created: ${wsPath}`);
    }
  }

  // Step 3: 设置共享文件 symlink
  const symlinks = setupSharedSymlinks(wsPath);

  // Step 4: 写入 .env.axs
  upsertEnvFileExports(envPath, envVars);
  console.log(`[ensure] Wrote env file: ${envPath}`);

  return {
    success: true,
    agent_id: agentId,
    workspace_path: wsPath,
    env_path: envPath,
    created,
    already_existed: alreadyExists,
    symlinks,
    cli_error: cliError || undefined
  };
}

// ==================== API 处理 ====================

/**
 * 获取环境变量
 */
async function getEnvVars(tenant_name, user_id, show_sensitive = false) {
  try {
    const envFilePath = envFilePathFor(tenant_name, user_id);

    if (!fs.existsSync(envFilePath)) {
      return {
        success: false,
        error: 'Environment file not found',
        workspace_path: workspacePathFor(tenant_name, user_id)
      };
    }

    const content = fs.readFileSync(envFilePath, 'utf8');
    const lines = content.split('\n');
    const vars = {};

    for (const line of lines) {
      const match = line.match(/^export\s+(\w+)="([^"]*)"/);
      if (match) vars[match[1]] = match[2];
    }

    if (show_sensitive) {
      return { success: true, envVars: vars, hidden_count: 0 };
    }

    const publicVars = {};
    let hiddenCount = 0;
    for (const [key, value] of Object.entries(vars)) {
      if (SENSITIVE_VARS.includes(key)) {
        hiddenCount++;
      } else {
        publicVars[key] = value;
      }
    }

    return { success: true, envVars: publicVars, hidden_count: hiddenCount };
  } catch (error) {
    console.error('[API] Get env error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 列出所有 workspace
 */
async function listWorkspaces() {
  try {
    const entries = fs.readdirSync(OPENCLAW_BASE, { withFileTypes: true });
    const workspaces = entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith('workspace_'))
      .map(entry => {
        const match = entry.name.match(/^workspace_(.+?)_(.+)$/);
        return {
          dir: entry.name,
          tenant_name: match ? match[1] : null,
          user_id: match ? match[2] : null,
          path: path.join(OPENCLAW_BASE, entry.name)
        };
      });

    return { success: true, workspaces };
  } catch (error) {
    console.error('[API] List workspaces error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 删除 agent + workspace
 * 优先使用 openclaw CLI 删除以保持一致性
 */
async function deleteAgent(tenant_name, user_id) {
  const agentId = agentIdFor(user_id);
  const wsPath = workspacePathFor(tenant_name, user_id);
  const results = { agent_deleted: false, workspace_deleted: false };

  // Step 1: 通过 CLI 删除 agent 注册
  try {
    execSync(`openclaw agents delete ${JSON.stringify(agentId)} --force --json 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 15000
    });
    results.agent_deleted = true;
    console.log(`[delete] Removed agent via CLI: ${agentId}`);
  } catch (e) {
    console.warn(`[delete] CLI delete failed (may not exist): ${e.message}`);
  }

  // Step 2: 删除 workspace 目录
  if (fs.existsSync(wsPath)) {
    fs.rmSync(wsPath, { recursive: true, force: true });
    results.workspace_deleted = true;
    console.log(`[delete] Removed workspace: ${wsPath}`);
  }

  if (!results.agent_deleted && !results.workspace_deleted) {
    return { success: false, error: 'Agent and workspace not found' };
  }

  return { success: true, ...results, agent_id: agentId, workspace_path: wsPath };
}

// ==================== HTTP 服务器 ====================

/**
 * 读取请求体
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

/**
 * 发送 JSON 响应
 */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

/**
 * CORS 预检
 */
function handleCors(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return true;
  }
  return false;
}

/**
 * 路由处理
 */
async function handleRequest(req, res) {
  if (handleCors(req, res)) return;

  const url = new URL(req.url, `http://localhost:${DEFAULT_PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);

  try {
    // ========== GET /api/menes/health ==========
    if (method === 'GET' && pathname === '/api/menes/health') {
      return sendJson(res, 200, {
        status: 'OK',
        timestamp: new Date().toISOString(),
        version: '2.0.0',
        port: DEFAULT_PORT,
        openclaw_base: OPENCLAW_BASE,
        shared_files_dir: SHARED_FILES_DIR
      });
    }

    // ========== POST /api/menes/ensure ==========
    if (method === 'POST' && pathname === '/api/menes/ensure') {
      const body = await readBody(req);

      // 必填校验
      const required = ['AXS_TENANT_NAME', 'AXS_USER_ID', 'AXS_API_TOKEN'];
      for (const field of required) {
        if (!body[field]) {
          return sendJson(res, 400, {
            success: false,
            error: `Missing required field: ${field}`
          });
        }
      }

      // 默认值
      const defaults = {
        AXS_STATION_ID: '800019',
        AXS_BASE_URL: 'https://admin.pre.linkedsight.com',
        AXS_VERSION: '5.4',
        AXS_SORT_SERVICE_URL: 'http://101.33.204.121:5555/sort_tasks',
        AXS_SUBSPATIAL_CREATE_URL: 'http://113.118.46.251:5555/generate_sub_tasks',
        AXS_SPATIAL_ROUTE_URL: 'http://113.118.46.251:5555/solve_task_route',
        APIFOX_API_TOKEN: 'afxp_39b4fceBMSyoFjsf2AxFV4WpJeP5uEVQgb7s',
        APIFOX_RIDS_PROJECT_ID: '1487279',
        APIFOX_OTHER_PROJECT_ID: '1487426',
        APIFOX_RIDS_BRANCH_ID: '2427677',
        APIFOX_OTHER_BRANCH_ID: '2427814',
        AXS_CACHE_DIR: '/root/.openclaw/cache/axs-api-doc',
        AXS_CACHE_TTL: '300',
        AXS_DEBUG: 'false'
      };
      for (const [k, v] of Object.entries(defaults)) {
        if (body[k] === undefined || body[k] === null || body[k] === '') body[k] = v;
      }

      const { AXS_TENANT_NAME, AXS_USER_ID } = body;

      // 一步到位：CLI 创建 + symlink + env
      const result = ensureAgentFull(AXS_TENANT_NAME, AXS_USER_ID, {
        AXS_API_TOKEN: body.AXS_API_TOKEN,
        AXS_BASE_URL: body.AXS_BASE_URL,
        AXS_TENANT: body.AXS_TENANT || '',
        AXS_TENANT_UUID: body.AXS_TENANT_UUID || '',
        AXS_TENANT_NAME: AXS_TENANT_NAME,
        AXS_USER_ID: AXS_USER_ID,
        AXS_USER_UUID: body.AXS_USER_UUID || '',
        AXS_STATION_ID: body.AXS_STATION_ID,
        AXS_VERSION: body.AXS_VERSION,
        AXS_SORT_SERVICE_URL: body.AXS_SORT_SERVICE_URL,
        AXS_SUBSPATIAL_CREATE_URL: body.AXS_SUBSPATIAL_CREATE_URL,
        AXS_SPATIAL_ROUTE_URL: body.AXS_SPATIAL_ROUTE_URL,
        APIFOX_API_TOKEN: body.APIFOX_API_TOKEN,
        APIFOX_RIDS_PROJECT_ID: body.APIFOX_RIDS_PROJECT_ID,
        APIFOX_OTHER_PROJECT_ID: body.APIFOX_OTHER_PROJECT_ID,
        APIFOX_RIDS_BRANCH_ID: body.APIFOX_RIDS_BRANCH_ID,
        APIFOX_OTHER_BRANCH_ID: body.APIFOX_OTHER_BRANCH_ID,
        AXS_CACHE_DIR: body.AXS_CACHE_DIR,
        AXS_CACHE_TTL: body.AXS_CACHE_TTL,
        AXS_DEBUG: body.AXS_DEBUG
      });

      return sendJson(res, 200, result);
    }

    // ========== GET /api/menes/workspaces ==========
    if (method === 'GET' && pathname === '/api/menes/workspaces') {
      const result = await listWorkspaces();
      return sendJson(res, result.success ? 200 : 500, result);
    }

    // ========== GET /api/menes/env ==========
    if (method === 'GET' && pathname === '/api/menes/env') {
      const tenant_name = url.searchParams.get('tenant-name');
      const user_id = url.searchParams.get('user-id');
      const show_sensitive = url.searchParams.get('show_sensitive') === 'true';

      if (!tenant_name || !user_id) {
        return sendJson(res, 400, {
          success: false,
          error: 'Missing parameters: tenant-name and user-id'
        });
      }

      const result = await getEnvVars(tenant_name, user_id, show_sensitive);
      return sendJson(res, result.success ? 200 : 404, result);
    }

    // ========== PUT /api/menes/env ==========
    if (method === 'PUT' && pathname === '/api/menes/env') {
      const body = await readBody(req);
      const { tenant_name, user_id, vars } = body;

      if (!tenant_name || !user_id || !vars || typeof vars !== 'object') {
        return sendJson(res, 400, {
          success: false,
          error: 'Missing fields: tenant_name, user_id, vars (object)'
        });
      }

      const envPath = envFilePathFor(tenant_name, user_id);
      if (!fs.existsSync(path.dirname(envPath))) {
        return sendJson(res, 404, {
          success: false,
          error: 'Workspace not found. Call POST /api/menes/ensure first.'
        });
      }

      upsertEnvFileExports(envPath, vars);
      return sendJson(res, 200, { success: true, env_path: envPath, updated_keys: Object.keys(vars) });
    }

    // ========== DELETE /api/menes/agent ==========
    if (method === 'DELETE' && pathname === '/api/menes/agent') {
      const tenant_name = url.searchParams.get('tenant-name');
      const user_id = url.searchParams.get('user-id');

      if (!tenant_name || !user_id) {
        return sendJson(res, 400, {
          success: false,
          error: 'Missing parameters: tenant-name and user-id'
        });
      }

      const result = await deleteAgent(tenant_name, user_id);
      return sendJson(res, result.success ? 200 : 404, result);
    }

    // ========== GET /api/menes/agents ==========
    if (method === 'GET' && pathname === '/api/menes/agents') {
      try {
        const output = execSync('openclaw agents list --json 2>/dev/null', {
          encoding: 'utf8',
          timeout: 15000
        });
        const agents = JSON.parse(output.trim());
        return sendJson(res, 200, { success: true, agents });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e.message });
      }
    }

    // 404 Not Found
    sendJson(res, 404, {
      success: false,
      error: `Not found: ${method} ${pathname}`,
      available_endpoints: {
        'GET  /api/menes/health': 'Health check',
        'GET  /api/menes/agents': 'List all registered agents (via openclaw CLI)',
        'GET  /api/menes/workspaces': 'List all workspace directories',
        'GET  /api/menes/env?tenant-name=<n>&user-id=<id>': 'Get environment variables',
        'PUT  /api/menes/env': 'Update environment variables',
        'POST /api/menes/ensure': 'Create/ensure agent + workspace (full init)',
        'DELETE /api/menes/agent?tenant-name=<n>&user-id=<id>': 'Delete agent + workspace'
      }
    });

  } catch (error) {
    console.error('[API] Unhandled error:', error);
    sendJson(res, 500, { success: false, error: error.message });
  }
}

// ==================== 启动 / 进程管理 ====================

function showHelp() {
  console.log(`
AXS Environment API Server v2.0
================================

Usage:
  node axs-env-api-server.js              # Start on default port (18999)
  node axs-env-api-server.js --port 9000  # Custom port
  node axs-env-api-server.js start        # Start in background (daemon)
  node axs-env-api-server.js stop         # Stop background server
  node axs-env-api-server.js status       # Check if running

Environment Variables:
  PORT              Server port (default: 18999)
  OPENCLAW_BASE     OpenClaw data directory (default: /openclaw/data)
  SHARED_FILES_DIR  Directory with shared SOUL.md/IDENTITY.md (default: OPENCLAW_BASE/skills)

API Endpoints:
  GET    /api/menes/health       Health check
  GET    /api/menes/agents       List registered agents (openclaw CLI)
  GET    /api/menes/workspaces   List workspace directories
  GET    /api/menes/env          Get env vars (?tenant-name=&user-id=)
  PUT    /api/menes/env          Update env vars (body: {tenant_name, user_id, vars})
  POST   /api/menes/ensure       Full agent init (workspace + env + symlinks)
  DELETE /api/menes/agent        Delete agent + workspace (?tenant-name=&user-id=)

POST /api/menes/ensure body:
  Required: AXS_TENANT_NAME, AXS_USER_ID, AXS_API_TOKEN
  Optional: AXS_BASE_URL, AXS_STATION_ID, AXS_VERSION, ... (see defaults in code)

What 'ensure' does:
  1. openclaw agents add user_admin_{AXS_USER_ID} --workspace ... --non-interactive
     → Creates workspace with AGENTS.md, TOOLS.md, USER.md, HEARTBEAT.md, .git, etc.
  2. Replaces SOUL.md / IDENTITY.md with symlinks to shared versions
  3. Writes .env.axs with all AXS environment variables
  4. Idempotent: safe to call multiple times (updates env, skips if agent exists)
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  if (args[0] === 'start') {
    const server = spawn('node', [__filename], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });
    server.unref();
    console.log(`[Server] Started in background (PID ${server.pid}) on port ${DEFAULT_PORT}`);
    process.exit(0);
  }

  if (args[0] === 'stop') {
    const pids = [];
    try {
      const psOutput = execSync(`pgrep -f "${path.basename(__filename)}"`).toString();
      psOutput.split('\n').forEach(line => {
        const pid = parseInt(line.trim());
        if (pid && pid !== process.pid) pids.push(pid);
      });
    } catch (e) {}

    if (pids.length === 0) {
      console.log('[Server] No running instance found');
    } else {
      pids.forEach(pid => {
        try { process.kill(pid, 'SIGTERM'); console.log(`[Server] Killed PID ${pid}`); }
        catch (e) {}
      });
      console.log('[Server] Stopped');
    }
    process.exit(0);
  }

  if (args[0] === 'status') {
    try {
      const psOutput = execSync(`pgrep -f "${path.basename(__filename)}"`).toString();
      const pids = psOutput.trim().split('\n').filter(l => parseInt(l) !== process.pid);
      if (pids.length > 0) {
        console.log(`[Server] Running (PIDs: ${pids.join(', ')}) on port ${DEFAULT_PORT}`);
      } else {
        console.log('[Server] Not running');
      }
    } catch (e) {
      console.log('[Server] Not running');
    }
    process.exit(0);
  }

  // 解析 --port
  const portIdx = args.findIndex(a => a === '--port' || a === '-p');
  const port = portIdx >= 0 && args[portIdx + 1]
    ? parseInt(args[portIdx + 1])
    : DEFAULT_PORT;

  // 启动前检查
  console.log(`\n📋 Pre-flight checks:`);
  console.log(`   OPENCLAW_BASE: ${OPENCLAW_BASE}`);
  console.log(`   SHARED_FILES_DIR: ${SHARED_FILES_DIR}`);

  if (!fs.existsSync(OPENCLAW_BASE)) {
    console.warn(`   ⚠️  OPENCLAW_BASE does not exist, will create on first ensure`);
  }

  for (const file of SHARED_FILES) {
    const p = path.join(SHARED_FILES_DIR, file);
    console.log(`   ${fs.existsSync(p) ? '✅' : '⚠️ '} ${file}: ${p}`);
  }

  // 检查 openclaw CLI 可用性
  try {
    execSync('which openclaw', { encoding: 'utf8' });
    console.log(`   ✅ openclaw CLI: available`);
  } catch (e) {
    console.error(`   ❌ openclaw CLI: NOT FOUND — agent creation will fail!`);
  }

  // 创建 HTTP 服务器
  const server = require('http').createServer(handleRequest);

  server.listen(port, '0.0.0.0', () => {
    console.log(`\n🚀 AXS Environment API Server v2.0`);
    console.log(`   Port: ${port}`);
    console.log(`   PID: ${process.pid}`);
    console.log(`\n   Endpoints:`);
    console.log(`   GET    /api/menes/health`);
    console.log(`   GET    /api/menes/agents`);
    console.log(`   GET    /api/menes/workspaces`);
    console.log(`   GET    /api/menes/env?tenant-name=<n>&user-id=<id>`);
    console.log(`   PUT    /api/menes/env`);
    console.log(`   POST   /api/menes/ensure`);
    console.log(`   DELETE /api/menes/agent?tenant-name=<n>&user-id=<id>`);
    console.log('');
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('\n[Server] SIGTERM received, shutting down...');
    server.close(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    console.log('\n[Server] SIGINT received, shutting down...');
    server.close(() => process.exit(0));
  });
}

main();