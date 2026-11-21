// 生产 nginx 模板的渲染产物检查。
//
// 跑法（仓库根）：
//   node --test infra/nginx/prod-conf.render.test.mjs
//
// 检查两件事：
//   1. 结构：metrics 端点默认 deny all、白名单按 METRICS_ALLOW_CIDR 展开、
//      没有「注释掉的 allow」这种形态；
//   2. 语法：把渲染产物喂给 nginx -t（用本机已有的 nginx:1.27-alpine 镜像，
//      不引入新依赖；没有 docker 时跳过语法检查并打印说明）。
//
// ⚠️ 本文件是**人工/CI 手动跑**的检查（infra 下没有测试基建），
//    它不参与 npm test / jest / vitest。

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// ⚠️ 必须用 fileURLToPath：仓库路径里含中文，URL.pathname 会给出百分号编码
//    的路径（%E7%94%B5...），直接读文件会 ENOENT。
const HERE = fileURLToPath(new URL('.', import.meta.url));
const TEMPLATE_PATH = join(HERE, 'templates', 'prod.conf.template');
const EXPAND_SCRIPT = join(HERE, 'render-metrics-allow.sh');

/**
 * 按官方 nginx 镜像的 envsubst 语义渲染模板：
 * **只替换环境里存在的 ${VAR}**，其余原样保留。
 * （无花括号的 $host / $tenant 等运行时变量不在替换范围内。）
 */
function renderTemplate(template, env) {
  return template.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (match, name) =>
      Object.prototype.hasOwnProperty.call(env, name) ? env[name] : match,
  );
}

/** 渲染模板 + 跑展开脚本，返回最终产物。 */
function renderProdConf(metricsAllowCidr) {
  const dir = mkdtempSync(join(tmpdir(), 'prod-conf-'));
  const confPath = join(dir, 'prod.conf');
  const rendered = renderTemplate(readFileSync(TEMPLATE_PATH, 'utf8'), {
    BASE_DOMAIN: 'example.com',
  });
  writeFileSync(confPath, rendered);
  execFileSync('sh', [EXPAND_SCRIPT, confPath], {
    env: { ...process.env, METRICS_ALLOW_CIDR: metricsAllowCidr ?? '' },
  });
  return { confPath, dir, conf: readFileSync(confPath, 'utf8') };
}

/** 取出所有 `location /api/v1/metrics { ... }` 块的正文行。 */
function metricsBlocks(conf) {
  const blocks = [];
  const lines = conf.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith('location /api/v1/metrics')) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j] === '    }') break;
      body.push(lines[j]);
    }
    blocks.push(body);
  }
  return blocks;
}

/** 用 nginx 镜像做语法检查（没 docker 就跳过）。 */
function nginxSyntaxCheck(confPath, dir) {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
  } catch {
    console.log('  ↷ 跳过语法检查：本机没有可用的 docker');
    return null;
  }

  const certDir = join(dir, 'certs');
  execFileSync('mkdir', ['-p', certDir]);
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(certDir, 'privkey.pem'),
    '-out',
    join(certDir, 'fullchain.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=example.com',
  ]);

  // ⚠️ nginx 把 "syntax is ok" 写到 stderr，stdout 是空的 —— 两个流都要看。
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      // upstream 里的服务名在裸容器里解析不到 → nginx -t 会以
      // "host not found in upstream" 失败（那是环境问题，不是配置语法问题）。
      '--add-host',
      'api:127.0.0.1',
      '--add-host',
      'storefront:127.0.0.1',
      '--add-host',
      'merchant-admin:127.0.0.1',
      '--add-host',
      'platform-admin:127.0.0.1',
      '-v',
      `${dir}:/work:ro`,
      'nginx:1.27-alpine',
      'sh',
      '-c',
      'mkdir -p /etc/nginx/certs /etc/nginx/conf.d && ' +
        'cp /work/prod.conf /etc/nginx/conf.d/default.conf && ' +
        'cp /work/certs/fullchain.pem /work/certs/privkey.pem /etc/nginx/certs/ && ' +
        'nginx -t',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`nginx -t 失败：${result.stderr || result.stdout}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

test('metrics 端点：默认 deny all，且没有任何 allow', () => {
  const { conf } = renderProdConf('');

  const blocks = metricsBlocks(conf);
  // 中心域名 + 店铺子域名各一处 —— 少一处就意味着换个 Host 能绕过。
  assert.equal(blocks.length, 2, 'metrics 的 location 块应当出现两处');
  for (const body of blocks) {
    assert.ok(
      body.some((line) => line.trim() === 'deny all;'),
      'metrics 的 location 块必须含 deny all;',
    );
    assert.equal(
      body.filter((line) => line.trim().startsWith('allow ')).length,
      0,
      '未配置 METRICS_ALLOW_CIDR 时不应出现任何 allow 语句',
    );
  }
});

test('metrics 端点：白名单按 METRICS_ALLOW_CIDR 逗号列表展开', () => {
  const { conf } = renderProdConf('10.0.0.0/8, 192.168.1.0/24');

  const blocks = metricsBlocks(conf);
  // ⚠️ 先断言块存在：块为 0 时下面的循环一次都不跑，用例会「假绿」。
  assert.equal(blocks.length, 2, 'metrics 的 location 块应当出现两处');
  for (const body of blocks) {
    const allows = body
      .map((line) => line.trim())
      .filter((line) => line.startsWith('allow '));
    assert.deepEqual(allows, ['allow 10.0.0.0/8;', 'allow 192.168.1.0/24;']);
    assert.ok(body.some((line) => line.trim() === 'deny all;'));
  }
});

test('白名单里的非法条目被跳过，不会让 nginx 起不来', () => {
  // 一条非法 allow 语句会让 nginx 启动失败 → 整站不可用。
  // 代价应该只是「少放行一个网段」，所以非法项跳过并打日志。
  const { conf } = renderProdConf('10.0.0.0/8, 10.0.0.0/33, example.com, all');

  const blocks = metricsBlocks(conf);
  assert.equal(blocks.length, 2, 'metrics 的 location 块应当出现两处');
  for (const body of blocks) {
    const allows = body
      .map((line) => line.trim())
      .filter((line) => line.startsWith('allow '));
    assert.deepEqual(allows, ['allow 10.0.0.0/8;']);
    assert.ok(body.some((line) => line.trim() === 'deny all;'));
  }
});

test('没有「注释掉的 allow/deny」这种形态', () => {
  const { conf } = renderProdConf('10.0.0.0/8');

  // 只认「注释掉的**指令**」（形如 `# allow 10.0.0.0/8;` / `# deny all;`），
  // 注释里提到 allow 这个词不算。
  const commented = conf
    .split('\n')
    .find((line) => /^\s*#\s*(allow|deny)\s+[^;]*;/.test(line));
  assert.equal(commented, undefined, '模板里不该有被注释掉的 allow/deny 指令');
});

test('渲染产物不残留未定义的 ${VAR} 字面量', () => {
  const { conf } = renderProdConf('');

  // 只看**指令行**：注释里写 `${VAR}` 举例是允许的（不参与 nginx 解析），
  // 但真留在指令里的 ${...} 会让 nginx 启动直接语法错误。
  const leftover = conf
    .split('\n')
    .find((line) => !line.trim().startsWith('#') && line.includes('${'));
  assert.equal(leftover, undefined, '产物里出现了 envsubst 没替换掉的 ${...}');
});

test('nginx -t：默认拒绝与白名单两种配置都过语法检查', () => {
  for (const cidr of ['', '10.0.0.0/8']) {
    const { confPath, dir } = renderProdConf(cidr);
    const out = nginxSyntaxCheck(confPath, dir);
    if (out === null) continue;
    assert.match(out, /syntax is ok/, `nginx -t 未通过（METRICS_ALLOW_CIDR="${cidr}"）`);
  }
});
