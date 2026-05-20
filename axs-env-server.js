#!/usr/bin/env node
/**
 * AXS Environment Management HTTP API Server
 *
 * 独立运行的 HTTP API 服务器，与 OpenClaw 分离部署
 * 提供完整的环境变量管理能力，支持多租户 workspace
 *
 * 用法:
 *   node axs-env-api-server.js --port 18999
 *   node axs-env-api-server.js start/stop/status
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// 配置
const DEFAULT_PORT = parseInt(process.env.PORT) || 18999;
const OPENCLAW_BASE = process.env.OPENCLAW_BASE || '/root/.openclaw';

// 敏感变量列表 - 默认隐藏
const SENSITIVE_VARS = [
    'AXS_API_TOKEN',
    'APIFOX_API_TOKEN',
    'AXS_USER_UUID'
];

/**
 * 确保 workspace 目录和 .env.axs 文件存在
 * 不依赖 Python CLI，直接用 Node.js fs 操作
 */
function ensureWorkspaceDirect(tenant_name, user_id) {
  const wsPath = workspacePathFor(tenant_name, user_id);
  const envPath = envFilePathFor(tenant_name, user_id);

  // 创建目录（如果不存在）
  if (!fs.existsSync(wsPath)) {
    fs.mkdirSync(wsPath, { recursive: true });
    console.log(`[ensure] Created workspace: ${wsPath}`);
  }

  return { workspace_path: wsPath, env_path: envPath };
}

/**
 * 在 openclaw.json 中注册 agent（如未注册）
 * 返回 { registered: true/false, agent_name: string }
 */
function registerAgentInOpenclaw(tenant_name, user_id) {
  const configPath = path.join(OPENCLAW_BASE, 'openclaw.json');
  if (!fs.existsSync(configPath)) {
    console.log('[register] openclaw.json not found, skipping');
    return { registered: false, agent_name: null };
  }

  const agentName = `${tenant_name}_${user_id}`;
  const wsPath = workspacePathFor(tenant_name, user_id);
  const envPath = envFilePathFor(tenant_name, user_id);

  let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // 确保 agents.list 存在
  if (!config.agents) config.agents = {};
  if (!config.agents.list) config.agents.list = [];

  // 检查是否已注册
  const exists = config.agents.list.some(a => a.name === agentName);
  if (!exists) {
    config.agents.list.push({
      name: agentName,
      workspace: wsPath,
      env: {
        AXS_ENV_FILE: envPath
      }
    });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    console.log(`[register] Registered agent '${agentName}' in openclaw.json`);
    return { registered: true, agent_name: agentName };
  }

  console.log(`[register] Agent '${agentName}' already exists`);
  return { registered: false, agent_name: agentName };
}

function workspacePathFor(tenant_name, user_id) {
    return path.join(OPENCLAW_BASE, `workspace_${tenant_name}_${user_id}`);
}

function envFilePathFor(tenant_name, user_id) {
    return path.join(workspacePathFor(tenant_name, user_id), '.env.axs');
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
    console.error('[HTTP API] Get env error:', error.message);
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
            .map(entry => entry.name);

        return { success: true, workspaces };
    } catch (error) {
        console.error('[HTTP API] List workspaces error:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * 删除 workspace
 */
async function deleteWorkspace(tenant_name, user_id) {
    try {
        const workspacePath = workspacePathFor(tenant_name, user_id);

        if (fs.existsSync(workspacePath)) {
            fs.rmSync(workspacePath, { recursive: true, force: true });
            console.log(`[HTTP API] Deleted workspace: ${workspacePath}`);
            return { success: true };
        }

        return { success: false, error: 'Workspace not found' };
    } catch (error) {
        console.error('[HTTP API] Delete workspace error:', error.message);
        return { success: false, error: error.message };
    }
}

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
 * CORS 中间件
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
 * 处理 API 请求
 */
async function handleRequest(req, res) {
    if (handleCors(req, res)) return;

    const url = new URL(req.url, `http://menes-server:${process.env.PORT || DEFAULT_PORT}`);
    const pathname = url.pathname;
    const method = req.method;

    console.log(`[${method}] ${pathname}`);

    try {
        // ========== GET /api/menes/health ==========
        if (method === 'GET' && pathname === '/api/menes/health') {
            return sendJson(res, 200, {
                status: 'OK',
                timestamp: new Date().toISOString(),
                version: '1.0.0',
                port: DEFAULT_PORT,
                openclaw_base: OPENCLAW_BASE
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
            APIFOX_RIDS_BRANCH_ID: "2427677",
            APIFOX_OTHER_BRANCH_ID: "2427814",
            AXS_CACHE_DIR: '/root/.openclaw/cache/axs-api-doc',
            AXS_CACHE_TTL: '300',
            AXS_DEBUG: 'false'
        };
        for (const [k, v] of Object.entries(defaults)) {
            if (body[k] === undefined || body[k] === null || body[k] === '') body[k] = v;
        }

        const { AXS_TENANT_NAME, AXS_USER_ID } = body;

        // Step 1: 确保目录和 .env.axs 文件
        const { workspace_path, env_path } = ensureWorkspaceDirect(AXS_TENANT_NAME, AXS_USER_ID);

        // Step 2: 写 .env.axs（含 AXS_TENANT_NAME 和 AXS_USER_ID）
        upsertEnvFileExports(env_path, {
            AXS_API_TOKEN: body.AXS_API_TOKEN,
            AXS_BASE_URL: body.AXS_BASE_URL,
            AXS_TENANT: body.AXS_TENANT || '',
            AXS_TENANT_UUID: body.AXS_TENANT_UUID || '',
            AXS_TENANT_NAME: AXS_TENANT_NAME,
            AXS_USER_ID: AXS_USER_ID,
            AXS_STATION_ID: body.AXS_STATION_ID,
            AXS_VERSION: body.AXS_VERSION,
            AXS_SORT_SERVICE_URL: body.AXS_SORT_SERVICE_URL,
            AXS_SUBSPATIAL_CREATE_URL: body.AXS_SUBSPATIAL_CREATE_URL,
            APIFOX_API_TOKEN: body.APIFOX_API_TOKEN,
            APIFOX_RIDS_PROJECT_ID: body.APIFOX_RIDS_PROJECT_ID,
            APIFOX_OTHER_PROJECT_ID: body.APIFOX_OTHER_PROJECT_ID,
            APIFOX_RIDS_BRANCH_ID: body.APIFOX_RIDS_BRANCH_ID,
            APIFOX_OTHER_BRANCH_ID: body.APIFOX_OTHER_BRANCH_ID,
            AXS_CACHE_DIR: body.AXS_CACHE_DIR,
            AXS_CACHE_TTL: body.AXS_CACHE_TTL,
            AXS_DEBUG: body.AXS_DEBUG
        });

        // Step 3: 注册到 openclaw.json
        const reg = registerAgentInOpenclaw(AXS_TENANT_NAME, AXS_USER_ID);

        return sendJson(res, 200, {
            success: true,
            workspace_path,
            env_path,
            agent_registered: reg.registered,
            agent_name: reg.agent_name
        });
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

        // ========== DELETE /api/menes/workspace ==========
        if (method === 'DELETE' && pathname === '/api/menes/workspace') {
            const tenant_name = url.searchParams.get('tenant-name');
            const user_id = url.searchParams.get('user-id');

            if (!tenant_name || !user_id) {
                return sendJson(res, 400, {
                    success: false,
                    error: 'Missing parameters: tenant-name and user-id'
                });
            }

            const result = await deleteWorkspace(tenant_name, user_id);
            return sendJson(res, result.success ? 200 : 404, result);
        }

        // 404 Not Found
        sendJson(res, 404, {
            success: false,
            error: `Not found: ${method} ${pathname}`,
            available_endpoints: {
                'GET /api/menes/health': 'Health check',
                'GET /api/menes/workspaces': 'List all workspaces',
                'GET /api/menes/env?tenant-name=<name>&user-id=<id>': 'Get environment variables',
                'POST /api/menes/ensure': 'Create/update workspace',
                'DELETE /api/menes/workspace?tenant-name=<name>&user-id=<id>': 'Delete workspace'
            }
        });

    } catch (error) {
        console.error('[HTTP API] Error handling request:', error);
        sendJson(res, 500, {
            success: false,
            error: error.message
        });
    }
}

/**
 * 显示帮助信息
 */
function showHelp() {
    console.log(`
AXS Environment API Server
==========================

Usage:
  node axs-env-api-server.js              # Default port 18999
  node axs-env-api-server.js --port 9000  # Custom port
  node axs-env-api-server.js start        # Start in background
  node axs-env-api-server.js stop         # Stop server
  node axs-env-api-server.js status       # Check status

API Endpoints:
  GET  /api/menes/health                 - Health check
  GET  /api/menes/workspaces             - List all workspaces
  GET  /api/menes/env?tenant-name=<n>&user-id=<i> - Get env vars (filters sensitive)
  POST /api/menes/ensure                 - Create/update workspace
  DELETE /api/menes/workspace?tenant-name=<n>&user-id=<i> - Delete workspace

Security:
  - AXS_API_TOKEN、APIFOX_API_TOKEN 等敏感变量会被自动隐藏
  - 使用 show_sensitive=true 可查看完整变量

Integration:
  - Direct file-based workspace management (no Python CLI dependency)
  - Works with multiple tenants/workspaces
  - Auto-filters sensitive information

Examples:
  curl http://menes-server:18999/api/menes/health

  curl "http://menes-server:18999/api/menes/env?tenant-name=admin&user-id=test040701"

  curl -X POST http://menes-server:18999/api/menes/ensure \\
    -H "Content-Type: application/json" \\
    -d '{"AXS_TENANT_NAME": "admin", "AXS_USER_ID": "test040701"}'
`);
}

/**
 * 主程序入口
 */
async function main() {
    const args = process.argv.slice(2);

    // 命令参数
    if (args[0] === '--help' || args[0] === '-h') {
        showHelp();
        process.exit(0);
    }

    if (args[0] === 'start') {
        // 后台启动
        const server = spawn('node', [path.join(__dirname, 'axs-env-server.js')], {
            detached: true,
            stdio: 'ignore'
        });
        server.unref();
        console.log('[Server] Started in background on port ' + (process.env.PORT || DEFAULT_PORT));
        process.exit(0);
    }

    if (args[0] === 'stop') {
        // 停止服务
        const pids = [];
        try {
            const psOutput = execSync('pgrep -f "axs-env-server.js"').toString();
            psOutput.split('\n').forEach(line => {
                if (line.trim()) pids.push(parseInt(line));
            });
        } catch (e) {}

        pids.forEach(pid => {
            try { process.kill(pid, 'SIGTERM'); console.log(`Killed PID ${pid}`); }
            catch (e) {}
        });

        if (pids.length === 0) {
            console.log('[Server] No running instance found');
        } else {
            console.log('[Server] Stopped');
        }
        process.exit(0);
    }

    if (args[0] === 'status') {
        // 查看状态
        try {
            const psOutput = execSync('pgrep -f "axs-env-server.js"').toString();
            if (psOutput.trim()) {
                console.log(`[Server] Running on port ${process.env.PORT || DEFAULT_PORT}`);
                console.log('PIDs:', psOutput.trim().split('\n'));
            } else {
                console.log('[Server] Not running');
            }
        } catch (e) {
            console.log('[Server] Not running');
        }
        process.exit(0);
    }

    // 解析参数
    const portArg = args.findIndex(a => a === '--port' || a === '-p');
    const port = portArg >= 0 && args[portArg + 1]
        ? parseInt(args[portArg + 1])
        : DEFAULT_PORT;

    // 创建 HTTP 服务器
    const server = require('http').createServer(handleRequest);

    server.listen(port, '0.0.0.0', () => {
        console.log(`\n🚀 AXS Environment API Server`);
        console.log(`   Port: ${port}`);
        console.log(`   Base: ${OPENCLAW_BASE}`);
        console.log(`\nAvailable endpoints:`);
        console.log(`   GET  /api/menes/health`);
        console.log(`   GET  /api/menes/workspaces`);
        console.log(`   GET  /api/menes/env?tenant-name=<name>&user-id=<id>`);
        console.log(`   POST /api/menes/ensure`);
        console.log(`   DELETE /api/menes/workspace?tenant-name=<name>&user-id=<id>\n`);
    });

    // Graceful shutdown
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
