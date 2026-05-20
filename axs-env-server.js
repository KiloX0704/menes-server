#!/usr/bin/env node
/**
 * AXS Environment Management HTTP API Server v2.2
 *
 * 通过 docker exec 调用 openclaw 容器的 CLI 完成 agent 初始化
 * 优化：直接读写本地 openclaw.json 减少 docker exec 调用
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
const OPENCLAW_CONTAINER = process.env.OPENCLAW_CONTAINER || 'openclaw';
const OPENCLAW_BASE = process.env.OPENCLAW_BASE || '/root/.openclaw';
const SHARED_FILES_DIR = process.env.SHARED_FILES_DIR || path.join(OPENCLAW_BASE, 'skills');
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_BASE, 'openclaw.json');

// 敏感变量列表
const SENSITIVE_VARS = [
  'AXS_API_TOKEN',
  'APIFOX_API_TOKEN',
  'AXS_USER_UUID'
];

// 共享文件列表
const SHARED_FILES = ['AGENTS.md', 'IDENTITY.md', 'SOUL.md'];

// ==================== 工具函数 ====================

function agentIdFor(user_id) {
  return `user_admin_${user_id}`;
}

function agentNameFor(tenant_name, user_id) {
  return `${tenant_name}_${user_id}`;
}

function workspacePathFor(tenant_name, user_id) {
  return path.join(OPENCLAW_BASE, `workspace_${tenant_name}_${user_id}`);
}

function envFilePathFor(tenant_name, user_id) {
  return path.join(workspacePathFor(tenant_name, user_id), '.env.axs');
}

/**
 * 在 openclaw 容器内执行命令
 */
function execInOpenClaw(cmd, options = {}) {
  const escaped = cmd.replace(/'/g, "'\\''");
  const fullCmd = `docker exec ${OPENCLAW_CONTAINER} /bin/sh -c '${escaped}'`;
  console.log(`[docker] ${cmd}`);
  return execSync(fullCmd, {
    encoding: 'utf8',
    timeout: options.timeout || 30000
  });
}

function escapeEnvValue(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
}

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

// ==================== openclaw.json 操作（本地直接读写，无需 docker exec）====================

/**
 * 读取 openclaw.json
 */
function readOpenClawConfig() {
  if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
}

/**
 * 写入 openclaw.json
 */
function writeOpenClawConfig(config) {
  fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * 检查 agent 是否已注册（直接读本地文件，毫秒级）
 */
function isAgentRegistered(agentId) {
  try {
    const config = readOpenClawConfig();
    if (!config || !config.agents || !config.agents.list) return false;
    return config.agents.list.some(a => a.id === agentId);
  } catch (e) {
    console.warn(`[check] Failed to read config: ${e.message}`);
    return false;
  }
}

/**
 * 修补 agent 配置：添加 reasoningDefault、修正 name
 */
function patchAgentConfig(agentId, tenant_name, user_id) {
  try {
    const config = readOpenClawConfig();
    if (!config || !config.agents || !config.agents.list) return false;

    const agent = config.agents.list.find(a => a.id === agentId);
    if (!agent) return false;

    let changed = false;

    // 修正 name: 应为 {tenant_name}_{user_id}
    const correctName = agentNameFor(tenant_name, user_id);
    if (agent.name !== correctName) {
      agent.name = correctName;
      changed = true;
    }

    // 添加 reasoningDefault
    if (agent.reasoningDefault !== 'stream') {
      agent.reasoningDefault = 'stream';
      changed = true;
    }

    if (changed) {
      writeOpenClawConfig(config);
      console.log(`[patch] Updated agent config: name=${correctName}, reasoningDefault=stream`);
    }

    return changed;
  } catch (e) {
    console.error(`[patch] Failed to patch agent config: ${e.message}`);
    return false;
  }
}

/**
 * 确保 binding 存在
 * binding 格式:
 * {
 *   "agentId": "user_admin_xxx",
 *   "match": { "channel": "webchat", "peer": { "kind": "direct", "id": "admin_xxx" } }
 * }
 */
function ensureBinding(agentId, tenant_name, user_id) {
  try {
    const config = readOpenClawConfig();
    if (!config) return false;

    if (!config.bindings) config.bindings = [];

    const peerId = agentNameFor(tenant_name, user_id);

    // 检查是否已存在
    const exists = config.bindings.some(b =>
      b.agentId === agentId &&
      b.match &&
      b.match.channel === 'webchat' &&
      b.match.peer &&
      b.match.peer.id === peerId
    );

    if (exists) {
      console.log(`[binding] Already exists for ${agentId}`);
      return false;
    }

    // 添加 binding
    config.bindings.push({
      agentId: agentId,
      match: {
        channel: 'webchat',
        peer: {
          kind: 'direct',
          id: peerId
        }
      }
    });

    writeOpenClawConfig(config);
    console.log(`[binding] Added webchat binding: ${agentId} ← peer:${peerId}`);
    return true;
  } catch (e) {
    console.error(`[binding] Failed to ensure binding: ${e.message}`);
    return false;
  }
}

// ==================== 核心逻辑 ====================

/**
 * 通过 docker exec 在 openclaw 容器内创建 agent
 */
function createAgentViaCli(agentId, wsPath) {
  try {
    const cmd = `openclaw agents add "${agentId}" --workspace "${wsPath}" --non-interactive --json`;
    const result = execInOpenClaw(cmd, { timeout: 30000 });
    console.log(`[ensure] Created agent via CLI: ${agentId}`);
    return { success: true, output: result.trim() };
  } catch (e) {
    console.error(`[ensure] CLI agent creation failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * 设置共享文件 symlink
 */
function setupSharedSymlinks(wsPath) {
  const linked = [];
  const skipped = [];

  for (const file of SHARED_FILES) {
    const src = path.join(SHARED_FILES_DIR, file);
    const dest = path.join(wsPath, file);

    if (!fs.existsSync(src)) {
      console.warn(`[symlink] Shared source not found: ${src}`);
      skipped.push({ file, reason: 'source_not_found' });
      continue;
    }

    try {
      const stat = fs.lstatSync(dest);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(dest);
        if (target === src) {
          skipped.push({ file, reason: 'already_correct' });
          continue;
        }
      }
      fs.unlinkSync(dest);
    } catch (e) {
      // dest 不存在
    }

    fs.symlinkSync(src, dest);
    linked.push(file);
    console.log(`[symlink] ${file} → ${src}`);
  }

  return { linked, skipped };
}

/**
 * 完整的 agent 初始化流程（优化版）
 * - 已存在：跳过 docker exec，只更新 env（毫秒级）
 * - 新建：CLI 创建 + 本地 patch config + binding
 */
function ensureAgentFull(tenant_name, user_id, envVars) {
  const agentId = agentIdFor(user_id);
  const wsPath = workspacePathFor(tenant_name, user_id);
  const envPath = envFilePathFor(tenant_name, user_id);

  let created = false;
  let cliError = null;
  let configPatched = false;
  let bindingAdded = false;

  // Step 1: 检查 agent 是否已存在（本地文件读取，毫秒级）
  const alreadyExists = isAgentRegistered(agentId);

  // Step 2: 不存在则通过 CLI 创建
  if (!alreadyExists) {
    const result = createAgentViaCli(agentId, wsPath);
    if (result.success) {
      created = true;
    } else {
      cliError = result.error;
      if (!fs.existsSync(wsPath)) {
        fs.mkdirSync(wsPath, { recursive: true });
        console.log(`[ensure] Fallback: created workspace dir manually`);
      }
    }
  } else {
    if (!fs.existsSync(wsPath)) {
      fs.mkdirSync(wsPath, { recursive: true });
      console.log(`[ensure] Agent exists but workspace missing, created: ${wsPath}`);
    }
  }

  // Step 3: 修补 agent 配置（reasoningDefault + name）
  configPatched = patchAgentConfig(agentId, tenant_name, user_id);

  // Step 4: 确保 binding 存在
  bindingAdded = ensureBinding(agentId, tenant_name, user_id);

  // Step 5: 设置共享文件 symlink
  const symlinks = setupSharedSymlinks(wsPath);

  // Step 6: 写入 .env.axs
  upsertEnvFileExports(envPath, envVars);
  console.log(`[ensure] Wrote env file: ${envPath}`);

  return {
    success: true,
    agent_id: agentId,
    agent_name: agentNameFor(tenant_name, user_id),
    workspace_path: wsPath,
    env_path: envPath,
    created,
    already_existed: alreadyExists,
    config_patched: configPatched,
    binding_added: bindingAdded,
    symlinks,
    cli_error: cliError || undefined
  };
}

// ==================== API 处理函数 ====================

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

async function deleteAgent(tenant_name, user_id) {
  const agentId = agentIdFor(user_id);
  const wsPath = workspacePathFor(tenant_name, user_id);
  const results = { agent_deleted: false, workspace_deleted: false, binding_removed: false };

  // Step 1: 从 openclaw.json 删除 agent 和 binding
  try {
    const config = readOpenClawConfig();
    if (config) {
      // 删除 agent
      if (config.agents && config.agents.list) {
        const before = config.agents.list.length;
        config.agents.list = config.agents.list.filter(a => a.id !== agentId);
        results.agent_deleted = config.agents.list.length < before;
      }

      // 删除 binding
      if (config.bindings) {
        const before = config.bindings.length;
        config.bindings = config.bindings.filter(b => b.agentId !== agentId);
        results.binding_removed = config.bindings.length < before;
      }

      if (results.agent_deleted || results.binding_removed) {
        writeOpenClawConfig(config);
        console.log(`[delete] Removed from openclaw.json: agent=${results.agent_deleted}, binding=${results.binding_removed}`);
      }
    }
  } catch (e) {
    console.warn(`[delete] Config update failed: ${e.message}`);
  }

  // Step 2: 删除 workspace 目录
  if (fs.existsSync(wsPath)) {
    fs.rmSync(wsPath, { recursive: true, force: true });
    results.workspace_deleted = true;
    console.log(`[delete] Removed workspace: ${wsPath}`);
  }

  // Step 3: 删除 agent state 目录
  const agentStateDir = path.join(OPENCLAW_BASE, 'agents', agentId);
  if (fs.existsSync(agentStateDir)) {
    fs.rmSync(agentStateDir, { recursive: true, force: true });
    console.log(`[delete] Removed agent state: ${agentStateDir}`);
  }

  if (!results.agent_deleted && !results.workspace_deleted) {
    return { success: false, error: 'Agent and workspace not found' };
  }

  return { success: true, ...results, agent_id: agentId, workspace_path: wsPath };
}

// ==================== HTTP 服务器 ====================

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

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

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

async function handleRequest(req, res) {
  if (handleCors(req, res)) return;

  const url = new URL(req.url, `http://localhost:${DEFAULT_PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);

  try {
    // ========== GET /api/menes/health ==========
    if (method === 'GET' && pathname === '/api/menes/health') {
      let clawStatus = 'unknown';
      let clawVersion = null;
      try {
        const ver = execInOpenClaw('openclaw --version', { timeout: 10000 });
        clawStatus = 'reachable';
        clawVersion = ver.trim();
      } catch (e) {
        clawStatus = 'unreachable: ' + e.message;
      }

      return sendJson(res, 200, {
        status: 'OK',
        timestamp: new Date().toISOString(),
        version: '2.2.0',
        port: DEFAULT_PORT,
        openclaw_container: OPENCLAW_CONTAINER,
        openclaw_status: clawStatus,
        openclaw_version: clawVersion,
        openclaw_base: OPENCLAW_BASE,
        shared_files_dir: SHARED_FILES_DIR
      });
    }

    // ========== POST /api/menes/ensure ==========
    if (method === 'POST' && pathname === '/api/menes/ensure') {
      const body = await readBody(req);

      const required = ['AXS_TENANT_NAME', 'AXS_USER_ID', 'AXS_API_TOKEN'];
      for (const field of required) {
        if (!body[field]) {
          return sendJson(res, 400, {
            success: false,
            error: `Missing required field: ${field}`
          });
        }
      }

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
        const config = readOpenClawConfig();
        const agents = (config && config.agents && config.agents.list) || [];
        return sendJson(res, 200, { success: true, agents });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e.message });
      }
    }

    // 404
    sendJson(res, 404, {
      success: false,
      error: `Not found: ${method} ${pathname}`,
      available_endpoints: {
        'GET    /api/menes/health': 'Health check',
        'GET    /api/menes/agents': 'List registered agents',
        'GET    /api/menes/workspaces': 'List workspace directories',
        'GET    /api/menes/env': 'Get env vars (?tenant-name=&user-id=)',
        'PUT    /api/menes/env': 'Update env vars',
        'POST   /api/menes/ensure': 'Full agent init',
        'DELETE /api/menes/agent': 'Delete agent + workspace (?tenant-name=&user-id=)'
      }
    });

  } catch (error) {
    console.error('[API] Unhandled error:', error);
    sendJson(res, 500, { success: false, error: error.message });
  }
}

// ==================== 启动 ====================

function showHelp() {
  console.log(`
AXS Environment API Server v2.2 (optimized)
=============================================

Performance:
  - Agent existence check: reads local openclaw.json (~1ms)
  - Existing user ensure: no docker exec needed (~5ms total)
  - New user ensure: one docker exec for CLI creation (~3-5s)

Usage:
  node axs-env-api-server.js              # Start on port 18999
  node axs-env-api-server.js --port 9000  # Custom port
  node axs-env-api-server.js start        # Background daemon
  node axs-env-api-server.js stop         # Stop daemon
  node axs-env-api-server.js status       # Check status

Environment Variables:
  PORT               Server port (default: 18999)
  OPENCLAW_CONTAINER Docker container name (default: openclaw)
  OPENCLAW_BASE      Shared data path (default: /root/.openclaw)
  SHARED_FILES_DIR   Shared files dir (default: /root/.openclaw/skills)
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
    }
    process.exit(0);
  }

  if (args[0] === 'status') {
    try {
      const psOutput = execSync(`pgrep -f "${path.basename(__filename)}"`).toString();
      const pids = psOutput.trim().split('\n').filter(l => parseInt(l) !== process.pid);
      if (pids.length > 0) {
        console.log(`[Server] Running (PIDs: ${pids.join(', ')})`);
      } else {
        console.log('[Server] Not running');
      }
    } catch (e) {
      console.log('[Server] Not running');
    }
    process.exit(0);
  }

  const portIdx = args.findIndex(a => a === '--port' || a === '-p');
  const port = portIdx >= 0 && args[portIdx + 1]
    ? parseInt(args[portIdx + 1])
    : DEFAULT_PORT;

  // Pre-flight
  console.log(`\n📋 Pre-flight checks:`);
  console.log(`   OPENCLAW_CONTAINER: ${OPENCLAW_CONTAINER}`);
  console.log(`   OPENCLAW_BASE: ${OPENCLAW_BASE}`);
  console.log(`   SHARED_FILES_DIR: ${SHARED_FILES_DIR}`);
  console.log(`   CONFIG: ${OPENCLAW_CONFIG_PATH} (${fs.existsSync(OPENCLAW_CONFIG_PATH) ? '✅ exists' : '❌ missing'})`);

  for (const file of SHARED_FILES) {
    const p = path.join(SHARED_FILES_DIR, file);
    console.log(`   ${fs.existsSync(p) ? '✅' : '⚠️ '} ${file}: ${p}`);
  }

  try {
    const ver = execInOpenClaw('openclaw --version', { timeout: 10000 });
    console.log(`   ✅ openclaw container: ${ver.trim()}`);
  } catch (e) {
    console.error(`   ❌ Cannot reach openclaw container: ${e.message}`);
  }

  const server = require('http').createServer(handleRequest);

  server.listen(port, '0.0.0.0', () => {
    console.log(`\n🚀 AXS Environment API Server v2.2`);
    console.log(`   Port: ${port} | PID: ${process.pid}`);
    console.log(`   Container: ${OPENCLAW_CONTAINER}\n`);
  });

  process.on('SIGTERM', () => {
    console.log('\n[Server] Shutting down...');
    server.close(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    console.log('\n[Server] Shutting down...');
    server.close(() => process.exit(0));
  });
}

main();