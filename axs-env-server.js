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
const PYTHON_CMD = process.env.AXS_PYTHON || 'python3';

/**
 * 在「当前进程所在容器」内解析 axs_env_manager.py。
 * 默认先找 OPENCLAW_BASE（与 OpenClaw 同盘挂载），再找与 axs-env-server.js 同级的 skills/（镜像内 COPY）。
 */
function resolveEnvManagerPython() {
    if (process.env.AXS_ENV_MANAGER_PYTHON) {
        return process.env.AXS_ENV_MANAGER_PYTHON;
    }
    const candidates = [
        path.join(OPENCLAW_BASE, 'skills', 'axs-env-manager', 'scripts', 'axs_env_manager.py'),
        path.join(__dirname, 'skills', 'axs-env-manager', 'scripts', 'axs_env_manager.py'),
        path.join(process.cwd(), 'skills', 'axs-env-manager', 'scripts', 'axs_env_manager.py')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    // 未找到时返回「服务目录下 skills」路径，便于报错提示与 Dockerfile 约定一致
    return candidates[1];
}

function resolveEnvManagerNode() {
    if (process.env.AXS_ENV_MANAGER_NODE) {
        return process.env.AXS_ENV_MANAGER_NODE;
    }
    const candidates = [
        path.join(OPENCLAW_BASE, 'skills', 'axs-env-manager', 'index.js'),
        path.join(__dirname, 'skills', 'axs-env-manager', 'index.js'),
        path.join(process.cwd(), 'skills', 'axs-env-manager', 'index.js')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return candidates[1];
}

const ENV_MANAGER_PYTHON = resolveEnvManagerPython();
const ENV_MANAGER_NODE = resolveEnvManagerNode();

function envManagerScriptMissingMessage() {
    return (
        `axs_env_manager.py not found at "${ENV_MANAGER_PYTHON}". ` +
        `The menes-server request runs inside the menes-server container — a path that exists in the OpenClaw container is not visible here unless you mount the same volume or COPY the skill into this image. ` +
        `Fix: set AXS_ENV_MANAGER_PYTHON to the script path inside this container, ` +
        `or place files at ${path.join(__dirname, 'skills', 'axs-env-manager', 'scripts', 'axs_env_manager.py')}, ` +
        `or mount OpenClaw data and set OPENCLAW_BASE.`
    );
}

// 敏感变量列表 - 默认隐藏
const SENSITIVE_VARS = [
    'AXS_API_TOKEN',
    'APIFOX_API_TOKEN',
    'AXS_USER_UUID'
];

/**
 * 调用 axs-env-manager Python CLI
 */
function callEnvManager(command, args = {}, extraArgs = []) {
    try {
        if (!fs.existsSync(ENV_MANAGER_PYTHON)) {
            throw new Error(envManagerScriptMissingMessage());
        }
        let cmd = `${PYTHON_CMD} "${ENV_MANAGER_PYTHON}" ${command}`;

        // 构建参数
        const params = [];
        for (const [key, value] of Object.entries(args)) {
            params.push(`--${key.replace('_', '-')} "${value}"`);
        }

        if (extraArgs.length > 0) {
            params.push(...extraArgs);
        }

        cmd += ' ' + params.join(' ');

        console.log(`[CLI] Executing: ${cmd}`);
        return execSync(cmd, { encoding: 'utf8', timeout: 10000 });
    } catch (error) {
        throw new Error(error.stderr || error.message || 'CLI execution failed');
    }
}

/**
 * 创建/更新 workspace
 */
async function ensureWorkspace(params) {
    try {
        const { tenant_name, user_id, token, base_url, tenant, tenant_uuid, station_id, version } = params;

        // 调用 Python CLI 确保 workspace 存在
        await callEnvManager('ensure', {
            'tenant-name': tenant_name,
            'user-id': user_id,
            token: token,
            'base-url': base_url,
            tenant: tenant,
            'tenant-uuid': tenant_uuid,
            'station-id': station_id,
            version: version
        });

        return { success: true };
    } catch (error) {
        console.error('[HTTP API] Ensure workspace error:', error.message);
        return { success: false, error: error.message };
    }
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
        // 先通过 Python CLI 检查 workspace 是否存在
        const result = await callEnvManager('info', {
            'tenant-name': tenant_name,
            'user-id': user_id
        });

        if (!result.includes('存在：是')) {
            return {
                success: false,
                error: 'Workspace not found',
                workspace_path: workspacePathFor(tenant_name, user_id)
            };
        }

        // 读取 .env.axs 文件
        const envFilePath = envFilePathFor(tenant_name, user_id);

        if (!fs.existsSync(envFilePath)) {
            return {
                success: false,
                error: 'Environment file not found'
            };
        }

        const content = fs.readFileSync(envFilePath, 'utf8');
        const lines = content.split('\n');
        const vars = {};

        for (const line of lines) {
            const match = line.match(/^export\s+(\w+)="([^"]*)"/);
            if (match) {
                vars[match[1]] = match[2];
            }
        }

        if (show_sensitive) {
            return { success: true, envVars: vars, hidden_count: 0 };
        }

        // 过滤敏感变量
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

            // 必填：tenant/user/token。其余字段若未传入则补默认值。
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
                APIFOX_API_TOKEN: 'y7pNL3qKOlD5Uy2QEEC2MyPx9qZIejoh',
                APIFOX_RIDS_PROJECT_ID: '1487279',
                APIFOX_OTHER_PROJECT_ID: '1487426',
                AXS_CACHE_DIR: '/root/.openclaw/cache/axs-api-doc',
                AXS_CACHE_TTL: '300',
                AXS_DEBUG: 'false'
            };

            for (const [k, v] of Object.entries(defaults)) {
                if (body[k] === undefined || body[k] === null || body[k] === '') body[k] = v;
            }

            const result = await ensureWorkspace({
                tenant_name: body.AXS_TENANT_NAME,
                user_id: body.AXS_USER_ID,
                token: body.AXS_API_TOKEN,
                base_url: body.AXS_BASE_URL,
                tenant: body.AXS_TENANT || '',
                tenant_uuid: body.AXS_TENANT_UUID || '',
                station_id: body.AXS_STATION_ID,
                version: body.AXS_VERSION
            });

            if (result.success) {
                const envPath = envFilePathFor(body.AXS_TENANT_NAME, body.AXS_USER_ID);
                try {
                    upsertEnvFileExports(envPath, {
                        AXS_STATION_ID: body.AXS_STATION_ID,
                        AXS_BASE_URL: body.AXS_BASE_URL,
                        AXS_VERSION: body.AXS_VERSION,
                        APIFOX_API_TOKEN: body.APIFOX_API_TOKEN,
                        APIFOX_RIDS_PROJECT_ID: body.APIFOX_RIDS_PROJECT_ID,
                        APIFOX_OTHER_PROJECT_ID: body.APIFOX_OTHER_PROJECT_ID,
                        AXS_CACHE_DIR: body.AXS_CACHE_DIR,
                        AXS_CACHE_TTL: body.AXS_CACHE_TTL,
                        AXS_DEBUG: body.AXS_DEBUG
                    });
                    result.env_written = true;
                    result.env_path = envPath;
                } catch (e) {
                    result.env_written = false;
                    result.env_write_error = e?.message || String(e);
                }
            }

            return sendJson(res, result.success ? 200 : 400, result);
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

        // ========== GET /api/menes/cli/test ========== (测试连接)
        if (method === 'GET' && pathname === '/api/menes/cli/test') {
            try {
                const result = await callEnvManager('info', {
                    'tenant-name': 'admin',
                    'user-id': 'test040801'
                });

                return sendJson(res, 200, {
                    status: 'connected',
                    python_path: ENV_MANAGER_PYTHON,
                    node_path: ENV_MANAGER_NODE,
                    output: result?.substring(0, 200) || 'OK'
                });
            } catch (error) {
                return sendJson(res, 500, {
                    status: 'disconnected',
                    error: error.message
                });
            }
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
                'DELETE /api/menes/workspace?tenant-name=<name>&user-id=<id>': 'Delete workspace',
                'GET /api/menes/cli/test': 'Test CLI connection'
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
  GET  /api/menes/cli/test               - Test CLI connection

Security:
  - AXS_API_TOKEN、APIFOX_API_TOKEN 等敏感变量会被自动隐藏
  - 使用 show_sensitive=true 可查看完整变量

Integration:
  - Uses axs-env-manager CLI for environment management
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

    // 验证 CLI 是否可用
    try {
        const result = execSync(`${PYTHON_CMD} "${ENV_MANAGER_PYTHON}" --help`, { encoding: 'utf8' });
        console.log('[Server] CLI verified successfully');
    } catch (error) {
        console.warn('[Server Warning] CLI might not be available:', error.message);
    }

    // 创建 HTTP 服务器
    const server = require('http').createServer(handleRequest);

    server.listen(port, '0.0.0.0', () => {
        console.log(`\n🚀 AXS Environment API Server`);
        console.log(`   Port: ${port}`);
        console.log(`   Base: ${OPENCLAW_BASE}`);
        console.log(`   CLI: ${ENV_MANAGER_PYTHON} (${fs.existsSync(ENV_MANAGER_PYTHON) ? 'ok' : 'MISSING'})`);
        if (!fs.existsSync(ENV_MANAGER_PYTHON)) {
            console.warn('[Server]', envManagerScriptMissingMessage());
        }
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
