// 生产 nginx 模板的渲染产物检查。
//
// 跑法（仓库根）：
//   node --test infra/nginx/prod-conf.render.test.mjs
//
// 检查四件事：
//   1. 结构：metrics 端点默认 deny all、白名单按 METRICS_ALLOW_CIDR 展开、
//      没有「注释掉的 allow」这种形态；
//   2. 限流（P2-3 / P3-2）：限流落在真实流量入口（三个前端的 location /）、
//      阈值可配且非法值回落默认、拒绝码统一 429 + Retry-After、
//      支付回调不被限流；
//   3. 双栈：每个 server 块的 IPv4 监听都有参数逐字一致的 `[::]` 监听，
//      80 / 443 的 default_server 在 IPv4 与 IPv6 上都是我们；镜像自带的
//      default.conf 被覆盖成不含 server 块的占位文件（否则 Host: localhost /
//      IP 直访会拿到镜像欢迎页 200，且 `[::]:80` 兜底隐式依赖 default_server）；
//   4. 语法/行为：渲染产物喂给 nginx -t；再真起一个 nginx:1.27-alpine 容器，
//      用低阈值打满请求，证明真实返回的是 429 **而不是 503**；另起一个按生产
//      挂载（含 default.conf 覆盖）的容器，证明 IPv6 的 http/https/合法 Host
//      与 IPv4 行为一致、未知 Host 不再返回欢迎页。
//      （用本机已有的镜像，不引入新依赖；没有 docker 时跳过并打印说明）。
//
// ⚠️ 本文件由 CI 的 `nginx` job 跑（`.github/workflows/ci.yml`），命令就是上面那行，
//    失败会让 CI 变红。CI 的 ubuntu runner 有 docker，所以第 2、3 项在 CI 上是
//    **真跑**（只有本地没 docker 时才跳过）。它不参与 npm test / jest / vitest。

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// ⚠️ 必须用 fileURLToPath：仓库路径里含中文，URL.pathname 会给出百分号编码
//    的路径（%E7%94%B5...），直接读文件会 ENOENT。
const HERE = fileURLToPath(new URL('.', import.meta.url));
const TEMPLATE_PATH = join(HERE, 'templates', 'prod.conf.template');
const EXPAND_SCRIPT = join(HERE, 'render-metrics-allow.sh');
const RATE_SCRIPT = join(HERE, 'render-rate-limit.sh');

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

/**
 * 构造限流脚本的环境：**先删掉进程里已有的 RATE_LIMIT_\***，再叠加用例给的值。
 * 否则开发机 shell 里残留的 RATE_LIMIT_FRONT_RATE 会让「默认值」用例假绿/假红。
 */
function rateEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('RATE_LIMIT_')) delete env[key];
  }
  return { ...env, ...overrides };
}

/**
 * 渲染模板 + 按官方 entrypoint 的顺序跑两个展开脚本，返回最终产物。
 *   - `stderr`：metrics 白名单脚本的日志（断言「跳过非法条目」）
 *   - `rateStderr`：限流脚本的日志（断言「回落默认值并点名」）
 */
function renderProdConf(metricsAllowCidr, rateOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prod-conf-'));
  const confPath = join(dir, 'prod.conf');
  const rendered = renderTemplate(readFileSync(TEMPLATE_PATH, 'utf8'), {
    BASE_DOMAIN: 'example.com',
  });
  writeFileSync(confPath, rendered);
  // ⚠️ 必须用 spawnSync 分开取流：execFileSync 只返回 stdout，
  //    「跳过非法条目」的日志写在 stderr 上。
  const metricsResult = spawnSync('sh', [EXPAND_SCRIPT, confPath], {
    env: { ...process.env, METRICS_ALLOW_CIDR: metricsAllowCidr ?? '' },
    encoding: 'utf8',
  });
  if (metricsResult.status !== 0) {
    throw new Error(`白名单展开脚本失败：${metricsResult.stderr || metricsResult.stdout}`);
  }
  const rateResult = spawnSync('sh', [RATE_SCRIPT, confPath], {
    env: rateEnv(rateOverrides),
    encoding: 'utf8',
  });
  if (rateResult.status !== 0) {
    throw new Error(`限流展开脚本失败：${rateResult.stderr || rateResult.stdout}`);
  }
  return {
    confPath,
    dir,
    conf: readFileSync(confPath, 'utf8'),
    stderr: metricsResult.stderr,
    rateStderr: rateResult.stderr,
  };
}

/**
 * 解析出所有 `server { ... }` 块（按花括号深度切，不靠正则跨行匹配）。
 *
 * ⚠️ 数花括号前先去掉 `#` 注释：模板注释里会写 `RATE_LIMIT_{FRONT,API,AUTH}_...`
 *    这种带花括号的举例，不剥掉会把块的边界算歪。
 */
function serverBlocks(conf) {
  const lines = conf.split('\n');
  const blocks = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const code = lines[i].replace(/#.*$/, '');
    if (depth === 0 && /^\s*server\s*\{/.test(code)) start = i;
    depth += (code.match(/\{/g) ?? []).length;
    depth -= (code.match(/\}/g) ?? []).length;
    if (start >= 0 && depth === 0) {
      const body = lines.slice(start, i + 1);
      const nameLine = body.find((line) => /^\s*server_name\s/.test(line)) ?? '';
      blocks.push({
        serverName: nameLine
          .trim()
          .replace(/^server_name\s+/, '')
          .replace(/;$/, ''),
        lines: body,
      });
      start = -1;
    }
  }
  return blocks;
}

/** 解析某个 server 块里的所有 `location ... { ... }`（head 已去掉 `{`）。 */
function locationBlocks(serverLines) {
  const blocks = [];
  // 从 1 开始：第 0 行是 `server {`，进入循环前已经在 server 体内。
  let depth = 1;
  let start = -1;
  for (let i = 1; i < serverLines.length; i += 1) {
    const code = serverLines[i].replace(/#.*$/, '');
    if (depth === 1 && /^\s*location\s/.test(code)) start = i;
    depth += (code.match(/\{/g) ?? []).length;
    depth -= (code.match(/\}/g) ?? []).length;
    if (start >= 0 && depth === 1) {
      blocks.push({
        head: serverLines[start].trim().replace(/\s*\{$/, ''),
        lines: serverLines.slice(start, i + 1),
      });
      start = -1;
    }
  }
  return blocks;
}

/** 按 server_name 找 server 块；match 收到去掉 `server_name ` 与结尾分号的字符串。 */
function findServer(conf, match) {
  return serverBlocks(conf).find((block) => match(block.serverName));
}

/** 在 server 块里按 location 头找块（如 `location /`）。 */
function findLocation(serverLines, head) {
  return locationBlocks(serverLines).find((block) => block.head === head);
}

/** 某个块里是否有某条指令（按行首匹配，忽略缩进）。 */
function hasDirective(lines, pattern) {
  return lines.some((line) => pattern.test(line.trim()));
}

/** 某个 server 块里所有 listen 指令（去掉缩进与行尾分号外的空白）。 */
function listenDirectives(serverLines) {
  return serverLines.map((line) => line.trim()).filter((line) => /^listen\s/.test(line));
}

/** 某个监听端口上的所有 server 块（`listen 80;` / `listen 443 ssl ...`）。 */
function serversOnPort(conf, port) {
  // `listen 80;` 后面直接是分号，没有参数，所以不能只认「端口 + 空格」。
  return serverBlocks(conf).filter((block) =>
    hasDirective(block.lines, new RegExp(`^listen ${port}(;|\\s)`)),
  );
}

/** server_name 匹配器：店铺块是正则，三个后台是精确域名。 */
const STOREFRONT_SERVER = (name) => name.startsWith('~^');
const ADMIN_SERVER = (name) => name === 'merchant.example.com' || name === 'admin.example.com';
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
  // ⚠️ `deadbeef` / `::` 是 IPv6 形状校验放过去的历史漏洞，nginx 都不认它们。
  const { conf, stderr } = renderProdConf(
    '10.0.0.0/8, 10.0.0.0/33, example.com, all, deadbeef, ::, 1.2.3.4',
  );

  const blocks = metricsBlocks(conf);
  assert.equal(blocks.length, 2, 'metrics 的 location 块应当出现两处');
  for (const body of blocks) {
    const allows = body
      .map((line) => line.trim())
      .filter((line) => line.startsWith('allow '));
    assert.deepEqual(allows, ['allow 10.0.0.0/8;', 'allow 1.2.3.4;']);
    assert.ok(body.some((line) => line.trim() === 'deny all;'));
  }

  // 「跳过并打日志」是运维排查的入口：每个被丢弃的条目都要在 stderr 里点名。
  for (const bad of ['10.0.0.0/33', 'example.com', 'all', 'deadbeef', '::']) {
    assert.match(stderr, new RegExp(`跳过非法条目：${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
});

test('IPv6 条目一律跳过（当前策略只放行 IPv4）', () => {
  // 保守策略：IPv6 只做形状校验挡不住 `deadbeef` / `::`，而它们会让 nginx 启动失败。
  // 所以只收 IPv4 —— 合法的 IPv6 网段（2001:db8::/32、fe80::1、::1）也一并跳过。
  const { conf, stderr } = renderProdConf(
    '2001:db8::/32, fe80::1, ::1, 10.0.0.0/8',
  );

  const blocks = metricsBlocks(conf);
  assert.equal(blocks.length, 2, 'metrics 的 location 块应当出现两处');
  for (const body of blocks) {
    const allows = body
      .map((line) => line.trim())
      .filter((line) => line.startsWith('allow '));
    assert.deepEqual(allows, ['allow 10.0.0.0/8;'], 'IPv6 条目不应写进配置');
    assert.ok(body.some((line) => line.trim() === 'deny all;'));
  }
  for (const v6 of ['2001:db8::/32', 'fe80::1', '::1']) {
    assert.match(stderr, new RegExp(`跳过非法条目：${v6.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
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

// ---- 裸根域名（P3-3） ----
//
// 审计 P3-3：裸根域名 `example.com` 匹配不到店铺正则块（正则要求 `<tenant>.`
// 前缀），只能落到 443 的 default_server；「落到哪里」取决于 server 块书写顺序，
// 任何人调整顺序都会静默改变根域名的行为。这里用断言钉住**显式**处置：
// 根域名自己一个块、明确拒绝、不代理后端、http/https 自洽、文档逐行对得上。

test('裸根域名有显式 443 块：return 444，不代理到任何后端，也不落到店铺正则块', () => {
  const { conf } = renderProdConf('');

  // 1) 443 上必须有一个 server_name 恰好是 example.com 的块。
  //    精确名优先于正则，所以根域名请求会命中它，而不是店铺子域名块。
  const root443 = serversOnPort(conf, 443).filter((block) => block.serverName === 'example.com');
  assert.equal(root443.length, 1, '443 上必须恰好有一个裸根域名 server 块');
  const [root] = root443;

  // 2) 它直接断开（444），既不是跳转也不是代理；没有 location 就没有被转发的可能。
  assert.ok(hasDirective(root.lines, /^return 444;$/), '裸根域名必须显式 return 444');
  assert.ok(!hasDirective(root.lines, /^return 301 /), '裸根域名不能被 301 到任何地方');
  assert.ok(!hasDirective(root.lines, /^proxy_pass /), '裸根域名不允许 proxy_pass');
  assert.equal(
    locationBlocks(root.lines).length,
    0,
    '裸根域名块不应有 location（有 location 就有被代理到后端的可能）',
  );

  // 3) 店铺块的正则确实匹配不到裸根域名（这是「不产生 $tenant 为空请求」的根因）。
  const storefront = findServer(conf, STOREFRONT_SERVER);
  assert.ok(storefront, '找不到店铺子域名 server 块');
  const storefrontRegex = new RegExp(storefront.serverName.replace(/^~/, ''));
  assert.doesNotMatch(
    'example.com',
    storefrontRegex,
    `店铺子域名正则不应匹配裸根域名：${storefront.serverName}`,
  );
});

test('443 的 default_server 与裸根域名块是两个独立块，且 default_server 是显式参数', () => {
  const { conf } = renderProdConf('');
  const all443 = serversOnPort(conf, 443);

  // default_server 由 listen 参数显式指定，不靠「谁写在最前」。
  const defaults = all443.filter((block) =>
    hasDirective(block.lines, /^listen 443 ssl default_server;$/),
  );
  assert.equal(defaults.length, 1, '443 上必须恰有一个显式 default_server');
  assert.equal(defaults[0].serverName, '_', 'default_server 应保留 server_name _ 兜底未知 Host');
  assert.ok(
    hasDirective(defaults[0].lines, /^ssl_reject_handshake on;$/),
    'default_server 应对未知 Host 拒绝握手',
  );

  // 根域名块必须靠显式 server_name 命中，不能兼任 default_server（那就退回「兜底」了）。
  const root = all443.filter((block) => block.serverName === 'example.com');
  assert.equal(root.length, 1, '443 上必须恰好有一个裸根域名 server 块');
  assert.ok(
    !hasDirective(root[0].lines, /default_server/),
    '裸根域名不能兼任 default_server：它必须被显式命名，而不是靠兜底',
  );
});

test('裸根域名 http 与 https 自洽：两侧都明确拒绝，不出现 301 → 断连的死循环', () => {
  const { conf } = renderProdConf('');

  // http 侧：裸根域名自己一个块，直接拒绝，不 301。
  const root80 = serversOnPort(conf, 80).filter((block) => block.serverName === 'example.com');
  assert.equal(root80.length, 1, '80 上必须恰好有一个裸根域名 server 块');
  assert.ok(hasDirective(root80[0].lines, /^return 444;$/), 'http 裸根域名必须显式拒绝（444）');
  assert.ok(!hasDirective(root80[0].lines, /^return 301 /), 'http 裸根域名不能被 301 到 https');

  // 80 → https 的 301 块不能把裸根域名写进 server_name（否则就是 301 到一个必然断连的地址）。
  const redirect = serversOnPort(conf, 80).find((block) =>
    hasDirective(block.lines, /^return 301 https:\/\/\$host\$request_uri;$/),
  );
  assert.ok(redirect, '找不到 80 → https 的 301 块');
  const redirectNames = redirect.serverName.split(/\s+/);
  assert.ok(!redirectNames.includes('example.com'), '80 → https 的 301 块不能包含裸根域名');
  for (const label of ['api', 'merchant', 'admin']) {
    assert.ok(
      redirectNames.includes(`${label}.example.com`),
      `80 → https 的 301 块应保留 ${label}.example.com`,
    );
  }
  assert.ok(redirectNames.includes('*.example.com'), '80 → https 的 301 块应保留泛域名');

  // https 侧与 http 侧动作一致（都是 444 断连），不存在「跳到 https 再断」的落差。
  const root443 = serversOnPort(conf, 443).filter((block) => block.serverName === 'example.com');
  assert.equal(root443.length, 1, '443 上必须恰好有一个裸根域名 server 块');
  assert.ok(hasDirective(root443[0].lines, /^return 444;$/), 'https 裸根域名必须显式拒绝（444）');
});

test('docs/deployment.md §1 DNS 表与实际行为一致：裸根域名写明不承载业务', () => {
  const deploy = readFileSync(join(HERE, '..', '..', 'docs', 'deployment.md'), 'utf8');
  const rows = deploy.split('\n').filter((line) => line.trim().startsWith('|'));

  // 裸根域名必须是独立一行，且用途写明「不承载业务 / 拒绝 / 444」，不能写成店铺前台。
  const rootRow = rows.find((line) => /^\|\s*`example\.com`\s*\|/.test(line));
  assert.ok(rootRow, 'deployment.md §1 DNS 表缺少裸根域名 example.com 的独立行');
  assert.match(rootRow, /不承载业务|拒绝|444/, `裸根域名行未写明真实行为：${rootRow}`);
  assert.doesNotMatch(rootRow, /店铺前台/, `裸根域名行不能写成店铺前台：${rootRow}`);

  // 店铺前台仍由泛域名承担，这条不能一起改坏。
  const wildcardRow = rows.find((line) => /^\|\s*`\*\.example\.com`\s*\|/.test(line));
  assert.ok(wildcardRow, 'deployment.md §1 DNS 表缺少 *.example.com 的独立行');
  assert.match(wildcardRow, /店铺前台/, '泛域名行仍应写明店铺前台');
});

// ---- 双栈（IPv4 + IPv6） ----
//
// 官方 nginx 镜像的 entrypoint 会把模板渲染成 /etc/nginx/conf.d/prod.conf，
// **不会**覆盖镜像自带的 /etc/nginx/conf.d/default.conf，而且
// 10-listen-on-ipv6-by-default.sh 还会给后者加上 `listen [::]:80;`。
// 历史配置里 prod.conf 全是 IPv4-only，于是 `:::80` 上唯一的 server 是镜像那块
// （root /usr/share/nginx/html）→ 走 IPv6 的任意 Host 返回欢迎页 200；
// 而 `[::]:443` 根本不存在 → IPv6 的 HTTPS 连不上。
//
// 这里钉住三件事：每个块都双栈且参数逐字一致、`[::]` 上的兜底是我们的块、
// 镜像那块不再参与（由 docker-compose.prod.yml 挂载的占位文件覆盖）。

test('双栈：每个 server 块的 IPv4 监听都有参数逐字一致的 [::] 监听', () => {
  const { conf } = renderProdConf('');
  const blocks = serverBlocks(conf);

  // 9 个块：80 三个（兜底 / 裸根 / 跳转）+ 443 六个（兜底 / 裸根 / 店铺 / api / 商家 / 平台）。
  // ⚠️ 先钉住块数：块数为 0 时下面的循环一次都不跑，用例会「假绿」。
  assert.equal(blocks.length, 9, `server 块数应为 9，实际 ${blocks.length}`);

  let pairs = 0;
  for (const block of blocks) {
    const listens = listenDirectives(block.lines);
    const v4 = listens.filter((line) => /^listen (80|443)(;|\s)/.test(line));
    const v6 = listens.filter((line) => /^listen \[::\]:(80|443)(;|\s)/.test(line));

    // 每个块至少有一条 IPv4 监听（本模板不用 IPv6-only 块）。
    assert.ok(v4.length >= 1, `${block.serverName}：找不到 IPv4 监听`);
    assert.equal(
      v6.length,
      v4.length,
      `${block.serverName}：IPv4 监听 ${v4.length} 条，[::] 监听 ${v6.length} 条，应一一对应`,
    );

    for (const line of v4) {
      // 逐字对应：`listen 443 ssl default_server;` → `listen [::]:443 ssl default_server;`
      const expected = line.replace(/^listen /, 'listen [::]:');
      assert.ok(
        listens.includes(expected),
        `${block.serverName}：缺少与「${line}」参数一致的「${expected}」`,
      );
      pairs += 1;
    }
  }
  // 3 + 6 = 9 条 IPv4 监听，也就应当有 9 条 [::] 监听。
  assert.equal(pairs, 9, `IPv4 监听应有 9 条，实际 ${pairs} 条`);
});

test('[::] 上的兜底是我们的块：80 / 443 各恰有一个 default_server，且与 IPv4 同块', () => {
  const { conf } = renderProdConf('');
  const blocks = serverBlocks(conf);

  for (const [port, v4, v6] of [
    [80, 'listen 80 default_server;', 'listen [::]:80 default_server;'],
    [443, 'listen 443 ssl default_server;', 'listen [::]:443 ssl default_server;'],
  ]) {
    const v4Blocks = blocks.filter((block) => listenDirectives(block.lines).includes(v4));
    const v6Blocks = blocks.filter((block) => listenDirectives(block.lines).includes(v6));

    // 同一个地址上只能有一个 default_server —— 多一个 nginx 直接启动失败。
    assert.equal(v4Blocks.length, 1, `${port}：IPv4 default_server 应恰好一个`);
    assert.equal(v6Blocks.length, 1, `${port}：IPv6 default_server 应恰好一个`);
    // 两个地址族的兜底必须是同一个 server 块，否则 IPv6 会落到另一套规则上。
    assert.equal(
      v4Blocks[0],
      v6Blocks[0],
      `${port}：IPv4 与 IPv6 的 default_server 必须是同一个 server 块`,
    );
    assert.equal(v6Blocks[0].serverName, '_', `${port}：兜底块的 server_name 应保持 _`);
  }

  // 443 的 [::] 兜底也要拒绝握手；80 的 [::] 兜底要 444 断连。
  const defaultV6 = blocks.filter((block) =>
    listenDirectives(block.lines).includes('listen [::]:443 ssl default_server;'),
  )[0];
  assert.ok(
    hasDirective(defaultV6.lines, /^ssl_reject_handshake on;$/),
    '443 的 [::] default_server 应对未知 Host 拒绝握手',
  );
  const default80V6 = blocks.filter((block) =>
    listenDirectives(block.lines).includes('listen [::]:80 default_server;'),
  )[0];
  assert.ok(
    hasDirective(default80V6.lines, /^return 444;$/),
    '80 的 [::] default_server 应 444 断连（不是返回欢迎页）',
  );
});

test('IPv4 监听不回退：80 仍 3 块、443 仍 6 块，且每块都先有 IPv4 监听', () => {
  const { conf } = renderProdConf('');

  // serversOnPort 只认 `listen 80...` / `listen 443...`（不认 `listen [::]:...`），
  // 所以这组断言就是「IPv4 侧一点没动」的证据。
  assert.equal(serversOnPort(conf, 80).length, 3, '80 上应有 3 个 IPv4 server 块');
  assert.equal(serversOnPort(conf, 443).length, 6, '443 上应有 6 个 IPv4 server 块');

  // 裸根域名 / 店铺 / 三个后台的 IPv4 监听必须原样保留（防止「换成 IPv6-only」）。
  for (const expected of [
    'listen 80;',
    'listen 443 ssl;',
    'listen 80 default_server;',
    'listen 443 ssl default_server;',
  ]) {
    const blocks = serverBlocks(conf).filter((block) =>
      listenDirectives(block.lines).includes(expected),
    );
    assert.ok(blocks.length >= 1, `IPv4 监听「${expected}」不应被删掉`);
  }
});

test('镜像自带的 default.conf 被覆盖成不含 server 块的占位文件，且 compose 真的挂了它', () => {
  // 只加 [::] 监听也能双栈一致（实测：未知 Host 两族都 444），但镜像那块仍是
  // `[::]:80` 上的第二个 server —— `Host: localhost` / IP 直访会拿到欢迎页 200，
  // 且 `[::]:80` 的兜底隐式依赖 prod.conf 的 default_server 那行。所以要覆盖掉。
  const override = readFileSync(join(HERE, 'conf.d', 'default.conf'), 'utf8');
  assert.doesNotMatch(override, /^\s*listen\s/m, '覆盖文件不能含任何 listen 指令');
  assert.doesNotMatch(override, /^\s*server\s*\{/m, '覆盖文件不能含任何 server 块');

  const compose = readFileSync(join(HERE, '..', 'docker-compose.prod.yml'), 'utf8');
  assert.match(
    compose,
    /\.\/nginx\/conf\.d\/default\.conf:\/etc\/nginx\/conf\.d\/default\.conf:ro/,
    'docker-compose.prod.yml 必须把覆盖文件挂到 /etc/nginx/conf.d/default.conf',
  );
});

// ---- 限流（P2-3 / P3-2） ----
//
// 这一组用例是「限流真的落在真实流量路径上」的唯一证据。真实路径是
// 浏览器 → 同源 BFF（Next.js 服务端）→ api 容器，**BFF 到 api 那一跳过 nginx**，
// 所以能被限流的只有三个前端的 location /（页面 + RSC + /api/**）。
// 历史配置只限了 /api/v1/（浏览器根本不走），属于「挂在没人走的道上」。

test('三个前端的 location / 都挂了 front_general 限流（真实流量入口）', () => {
  const { conf } = renderProdConf('');

  const fronts = [
    ['店铺前台', STOREFRONT_SERVER],
    ['商家后台', (name) => name === 'merchant.example.com'],
    ['平台后台', (name) => name === 'admin.example.com'],
  ];
  for (const [label, match] of fronts) {
    const server = findServer(conf, match);
    // ⚠️ 先断言找到块：找不到时下面会抛「不能读 undefined」，
    //    报错信息看不出是哪个入口漏了。
    assert.ok(server, `${label}：找不到 server 块`);
    const location = findLocation(server.lines, 'location /');
    assert.ok(location, `${label}：找不到 location /`);
    assert.ok(
      hasDirective(location.lines, /^limit_req zone=front_general /),
      `${label}：location / 必须有限流（浏览器真实流量全落在这一层）`,
    );
  }
});

test('直连 api 的入口仍各自限流：店铺 /api/v1/ 与中心域名 / 用 api 档、/auth/ 用 auth 档', () => {
  const { conf } = renderProdConf('');

  const storefront = findServer(conf, STOREFRONT_SERVER);
  assert.ok(storefront, '找不到店铺子域名 server 块');
  const storefrontApi = findLocation(storefront.lines, 'location /api/v1/');
  assert.ok(storefrontApi, '店铺块里找不到 location /api/v1/');
  assert.ok(hasDirective(storefrontApi.lines, /^limit_req zone=api_general /));

  const api = findServer(conf, (name) => name === 'api.example.com');
  assert.ok(api, '找不到 api 中心域名 server 块');
  const apiRoot = findLocation(api.lines, 'location /');
  assert.ok(apiRoot, '中心域名块里找不到 location /');
  assert.ok(hasDirective(apiRoot.lines, /^limit_req zone=api_general /));
  const auth = findLocation(api.lines, 'location /api/v1/auth/');
  assert.ok(auth, '中心域名块里找不到 location /api/v1/auth/');
  assert.ok(hasDirective(auth.lines, /^limit_req zone=api_auth /));
});

test('限流键是 $binary_remote_addr，不能用客户端可伪造的 X-Forwarded-For', () => {
  // $http_x_forwarded_for 是请求头，攻击者换个头就换一份配额 = 没有限流。
  const { conf } = renderProdConf('');
  const zones = conf
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('limit_req_zone'));

  assert.equal(zones.length, 3, '应当有三条 limit_req_zone（front / api / auth）');
  for (const zone of zones) {
    assert.match(
      zone,
      /^limit_req_zone \$binary_remote_addr zone=\w+:\d+m rate=\d+r\/s;$/,
      `限流区的键必须是 $binary_remote_addr：${zone}`,
    );
    assert.doesNotMatch(zone, /\$http_x_forwarded_for/);
  }
});

test('拒绝码统一 429（不是 503），且所有限流 location 都带 Retry-After', () => {
  // 503 会被客户端/网关当成「服务故障」而重试，反而放大压力；
  // 429 + Retry-After 才是「你太快了，等一会儿」的正确语义。
  const { conf } = renderProdConf('');

  assert.match(conf, /^limit_req_status 429;$/m, '必须全局设置 limit_req_status 429');
  assert.doesNotMatch(conf, /limit_req_status\s+503/, '不允许残留 503 的限流拒绝码');

  const limited = [];
  for (const server of serverBlocks(conf)) {
    for (const location of locationBlocks(server.lines)) {
      if (!hasDirective(location.lines, /^limit_req /)) continue;
      limited.push({ server: server.serverName, location, });
      assert.ok(
        hasDirective(location.lines, /^add_header Retry-After \d+ always;$/),
        `${server.serverName} ${location.head}：限流 location 必须带 Retry-After`,
      );
    }
  }
  assert.ok(limited.length >= 6, `限流 location 应当至少 6 处，实际 ${limited.length} 处`);
});

test('限流 location 的 add_header 不吞掉安全响应头', () => {
  // nginx 的继承规则：location 里一旦出现任何 add_header，就不再继承
  // server 级的响应头。为 Retry-After 付的代价必须把四条安全头补回来。
  const { conf } = renderProdConf('');
  const required = [
    /^add_header Strict-Transport-Security "max-age=\d+" always;$/,
    /^add_header X-Frame-Options SAMEORIGIN always;$/,
    /^add_header X-Content-Type-Options nosniff always;$/,
    /^add_header Referrer-Policy strict-origin-when-cross-origin always;$/,
  ];
  let checked = 0;
  for (const server of serverBlocks(conf)) {
    for (const location of locationBlocks(server.lines)) {
      if (!hasDirective(location.lines, /^limit_req /)) continue;
      checked += 1;
      for (const header of required) {
        assert.ok(
          hasDirective(location.lines, header),
          `${server.serverName} ${location.head}：补 Retry-After 后丢了安全头 ${header}`,
        );
      }
    }
  }
  assert.ok(checked >= 6, `应当检查到至少 6 个限流 location，实际 ${checked}`);
});

test('支付渠道回调不被限流打掉（两个入口都豁免）', () => {
  // 渠道把非 2xx 当投递失败会重投/告警，而大促集中支付正是限流最容易被触发的
  // 时刻。安全边界在 api 侧（验签 + (provider, eventId) 唯一索引幂等），不靠 IP 限流。
  const { conf } = renderProdConf('');

  const entries = [
    ['店铺子域名', findServer(conf, STOREFRONT_SERVER)],
    ['api 中心域名', findServer(conf, (name) => name === 'api.example.com')],
  ];
  for (const [label, server] of entries) {
    assert.ok(server, `${label}：找不到 server 块`);
    const webhook = findLocation(server.lines, 'location /api/v1/webhooks/');
    assert.ok(
      webhook,
      `${label}：必须有独立的 location /api/v1/webhooks/（前缀比 /api/v1/ 长才会优先匹配）`,
    );
    assert.ok(
      !hasDirective(webhook.lines, /^limit_req /),
      `${label}：/api/v1/webhooks/ 不能被限流`,
    );
    assert.ok(
      hasDirective(webhook.lines, /^proxy_pass http:\/\/api_backend;$/),
      `${label}：/api/v1/webhooks/ 必须转发到 api`,
    );
  }
});

test('阈值可通过环境变量配置（rate / burst 都进配置）', () => {
  const { conf, rateStderr } = renderProdConf('', {
    RATE_LIMIT_FRONT_RATE: '5',
    RATE_LIMIT_FRONT_BURST: '7',
    RATE_LIMIT_API_RATE: '30',
    RATE_LIMIT_API_BURST: '11',
    RATE_LIMIT_AUTH_RATE: '3',
    RATE_LIMIT_AUTH_BURST: '2',
  });

  for (const zone of [
    'limit_req_zone $binary_remote_addr zone=front_general:10m rate=5r/s;',
    'limit_req_zone $binary_remote_addr zone=api_general:10m rate=30r/s;',
    'limit_req_zone $binary_remote_addr zone=api_auth:10m rate=3r/s;',
  ]) {
    assert.ok(conf.split('\n').map((l) => l.trim()).includes(zone), `缺少：${zone}`);
  }
  for (const directive of [
    'limit_req zone=front_general burst=7 nodelay;',
    'limit_req zone=api_general burst=11 nodelay;',
    'limit_req zone=api_auth burst=2 nodelay;',
  ]) {
    assert.ok(
      conf.split('\n').map((l) => l.trim()).includes(directive),
      `缺少：${directive}`,
    );
  }
  // 配了就不该再抱怨
  assert.doesNotMatch(rateStderr, /回落到默认值/);
});

test('阈值非法 / 缺失时回落到安全默认值，并在日志里逐个点名', () => {
  // 阈值是运维手填的：`20r/s`、`-5`、空值都会渲染出 nginx 语法错误
  // （`rate=r/s`、`rate=-5r/s`）→ 整站起不来。宁可少限流，不能起不来。
  const { conf, rateStderr } = renderProdConf('', {
    RATE_LIMIT_FRONT_RATE: '20r/s', // 带单位，非法
    RATE_LIMIT_FRONT_BURST: '-5', // 负数，非法
    RATE_LIMIT_API_RATE: '0', // rate 下限是 1
    RATE_LIMIT_API_BURST: '1234567', // 超过 6 位
    RATE_LIMIT_AUTH_RATE: '', // 空 = 缺失
    // RATE_LIMIT_AUTH_BURST 整个不设
  });

  const lines = conf.split('\n').map((l) => l.trim());
  // 默认值：front 20/100、api 20/40、auth 10/20
  for (const zone of [
    'limit_req_zone $binary_remote_addr zone=front_general:10m rate=20r/s;',
    'limit_req_zone $binary_remote_addr zone=api_general:10m rate=20r/s;',
    'limit_req_zone $binary_remote_addr zone=api_auth:10m rate=10r/s;',
  ]) {
    assert.ok(lines.includes(zone), `非法值应当回落到默认值，缺少：${zone}`);
  }
  for (const directive of [
    'limit_req zone=front_general burst=100 nodelay;',
    'limit_req zone=api_general burst=40 nodelay;',
    'limit_req zone=api_auth burst=20 nodelay;',
  ]) {
    assert.ok(lines.includes(directive), `缺少：${directive}`);
  }
  // 每个回落都要点名，否则运维不知道自己的配置没生效
  for (const name of [
    'RATE_LIMIT_FRONT_RATE',
    'RATE_LIMIT_FRONT_BURST',
    'RATE_LIMIT_API_RATE',
    'RATE_LIMIT_API_BURST',
    'RATE_LIMIT_AUTH_RATE',
    'RATE_LIMIT_AUTH_BURST',
  ]) {
    assert.match(rateStderr, new RegExp(name), `日志里没有点名 ${name}`);
  }
});

test('限流占位行必须全部展开，不残留 #@RATE_LIMIT_', () => {
  // 占位行留在产物里不影响启动，但限流会**静默缺失** —— 正是审计发现的问题。
  const { conf } = renderProdConf('');
  // 只认「占位行」本身（行首可选缩进后紧跟 `#@RATE_LIMIT_`）；
  // 注释里提到这个占位符写法是文档，不算残留。
  const leftover = conf
    .split('\n')
    .filter((line) => /^\s*#@RATE_LIMIT_/.test(line));
  assert.deepEqual(leftover, [], '产物里仍有未展开的限流占位行');
});

test('nginx -t：默认 / 自定义 / 非法三档限流阈值都过语法检查', () => {
  const cases = [
    [{}, '默认值'],
    [
      {
        RATE_LIMIT_FRONT_RATE: '5',
        RATE_LIMIT_FRONT_BURST: '7',
        RATE_LIMIT_API_RATE: '30',
        RATE_LIMIT_API_BURST: '11',
        RATE_LIMIT_AUTH_RATE: '3',
        RATE_LIMIT_AUTH_BURST: '2',
      },
      '自定义值',
    ],
    [
      {
        RATE_LIMIT_FRONT_RATE: 'abc',
        RATE_LIMIT_FRONT_BURST: '-1',
        RATE_LIMIT_API_RATE: '0',
        RATE_LIMIT_API_BURST: '1234567',
        RATE_LIMIT_AUTH_RATE: '1;rm -rf /',
        RATE_LIMIT_AUTH_BURST: ' ',
      },
      '非法值回落',
    ],
  ];
  for (const [env, label] of cases) {
    const { confPath, dir } = renderProdConf('', env);
    const out = nginxSyntaxCheck(confPath, dir);
    if (out === null) continue;
    assert.match(out, /syntax is ok/, `nginx -t 未通过（${label}）`);
  }
});

test('nginx -t：默认拒绝与白名单两种配置都过语法检查', () => {
  // 最后一档混入死条目（deadbeef / ::）：它们被跳过，所以真 nginx 也必须过。
  for (const cidr of ['', '10.0.0.0/8', '10.0.0.0/8, deadbeef, ::']) {
    const { confPath, dir } = renderProdConf(cidr);
    const out = nginxSyntaxCheck(confPath, dir);
    if (out === null) continue;
    assert.match(out, /syntax is ok/, `nginx -t 未通过（METRICS_ALLOW_CIDR="${cidr}"）`);
  }
});

// ---- 真实容器行为：超阈值必须是 429，不能是 503 ----
//
// 前面的用例只能证明「配置里有 limit_req_status 429 这行字」；真正要否掉的是
// 「拿旧配置（503）上线」。这里按官方 entrypoint 的完整流程起一个容器
// （envsubst 渲染模板 + 两个 /docker-entrypoint.d 脚本），把阈值调到 1r/s，
// 打满请求后看真实响应码。
//
// 没有 docker 时跳过并打印说明（本地开发机可能没装；CI 的 ubuntu runner 有）。
function runLiveRateLimitCheck() {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
  } catch {
    console.log('  ↷ 跳过真实容器限流验证：本机没有可用的 docker');
    return null;
  }

  const dir = mkdtempSync(join(tmpdir(), 'rate-live-'));
  const templateDir = join(dir, 'templates');
  const certDir = join(dir, 'certs');
  mkdirSync(templateDir);
  mkdirSync(certDir);
  copyFileSync(TEMPLATE_PATH, join(templateDir, 'prod.conf.template'));
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
    '-addext',
    'subjectAltName=DNS:example.com,DNS:*.example.com',
  ]);

  const name = `nginx-rate-limit-test-${process.pid}`;
  const started = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      name,
      // 上游全部指向 127.0.0.1:3000（没有服务监听）→ 放行的请求得到 502，
      // 被限流的请求得到 429。两者都好区分，且不需要真起三个前端。
      '--add-host',
      'api:127.0.0.1',
      '--add-host',
      'storefront:127.0.0.1',
      '--add-host',
      'merchant-admin:127.0.0.1',
      '--add-host',
      'platform-admin:127.0.0.1',
      // 店铺子域名块按 Host 匹配，容器内要能解析这个名字才能发请求
      '--add-host',
      'demo.example.com:127.0.0.1',
      '-v',
      `${templateDir}:/etc/nginx/templates:ro`,
      '-v',
      `${certDir}:/etc/nginx/certs:ro`,
      '-v',
      `${EXPAND_SCRIPT}:/docker-entrypoint.d/25-metrics-allow.sh:ro`,
      '-v',
      `${RATE_SCRIPT}:/docker-entrypoint.d/26-rate-limit.sh:ro`,
      '-e',
      'BASE_DOMAIN=example.com',
      '-e',
      'METRICS_ALLOW_CIDR=',
      // 低到「几乎第二个请求就超」：1r/s + burst 1
      '-e',
      'RATE_LIMIT_FRONT_RATE=1',
      '-e',
      'RATE_LIMIT_FRONT_BURST=1',
      'nginx:1.27-alpine',
    ],
    { encoding: 'utf8' },
  );
  if (started.status !== 0) {
    throw new Error(`启动 nginx 容器失败：${started.stderr || started.stdout}`);
  }

  try {
    // 1) 入口脚本必须真的跑过：容器内产物应当已展开成 rate=1r/s
    const rendered = spawnSync(
      'docker',
      ['exec', name, 'cat', '/etc/nginx/conf.d/prod.conf'],
      { encoding: 'utf8' },
    );
    assert.equal(rendered.status, 0, `读容器内配置失败：${rendered.stderr}`);
    assert.match(
      rendered.stdout,
      /limit_req_zone \$binary_remote_addr zone=front_general:10m rate=1r\/s;/,
      '入口脚本没有把阈值展开进容器内配置（没挂载 / 没有执行位？）',
    );
    assert.doesNotMatch(
      rendered.stdout,
      /^\s*#@RATE_LIMIT_/m,
      '容器内仍有未展开的限流占位行',
    );

    // 2) 等 nginx 就绪：能拿到一个 HTTP 状态码即算起来（502 也算 —— 上游不在）
    //    ⚠️ 用 curl 而不是 busybox wget：wget 的 -S 只打状态行，看不到响应头，
    //       而本用例要断言 Retry-After。
    let probe = '';
    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      const result = spawnSync(
        'docker',
        [
          'exec',
          name,
          'curl',
          '-sk',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          'https://demo.example.com/',
        ],
        { encoding: 'utf8' },
      );
      probe = `${result.stdout}${result.stderr}`;
      if (/^[1-5]\d\d$/.test(probe.trim())) {
        ready = true;
        break;
      }
      spawnSync('sleep', ['0.25']);
    }
    assert.ok(ready, `nginx 容器未就绪：${probe}`);

    // 3) 打满：10 个连发请求，前两个（含就绪探测消耗的令牌）过去，
    //    其余必须被限流成 429
    const hammer = spawnSync(
      'docker',
      [
        'exec',
        name,
        'sh',
        '-c',
        'i=0; while [ $i -lt 10 ]; do ' +
          'curl -sk -o /dev/null -w "%{http_code}\\n" https://demo.example.com/; ' +
          'i=$((i+1)); done',
      ],
      { encoding: 'utf8' },
    );
    const out = `${hammer.stdout}\n${hammer.stderr}`;
    assert.match(out, /^429$/m, `超阈值没有返回 429，实际状态码：${out.slice(0, 500)}`);
    assert.doesNotMatch(out, /^503$/m, '限流拒绝码仍是 503（P3-2 未修复）');

    // 4) 429 必须带 Retry-After（此时配额已耗尽，下一条请求必然被限）
    const limited = spawnSync(
      'docker',
      ['exec', name, 'curl', '-sk', '-D', '-', '-o', '/dev/null', 'https://demo.example.com/'],
      { encoding: 'utf8' },
    );
    const limitedOut = `${limited.stdout}\n${limited.stderr}`;
    // HTTP/2 走 ALPN 协商（模板里有 `http2 on`），状态行是 `HTTP/2 429`
    // 且响应头是小写 —— 断言要同时容忍 h1 与 h2。
    assert.match(
      limitedOut,
      /^HTTP\/[12](?:\.\d)? 429/m,
      `配额耗尽后仍未被限流：${limitedOut.slice(0, 500)}`,
    );
    assert.match(
      limitedOut,
      /^Retry-After:\s*1\s*$/im,
      `429 响应缺少 Retry-After：${limitedOut.slice(0, 500)}`,
    );
  } finally {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }
  return true;
}

test('真实 nginx 容器：超阈值返回 429（带 Retry-After）而不是 503', () => {
  // 用例做成可跳过：没 docker 的本地机器打印说明后直接返回。
  if (runLiveRateLimitCheck() === null) return;
});

// ---- 真实容器行为：IPv6 与 IPv4 一致，未知 Host 不返回欢迎页 ----
//
// 前面的结构断言只能证明「配置里有 [::] 那行字」。真正要否掉的是
// 「IPv6 上端口根本没监听」「IPv6 落到镜像欢迎页」「覆盖文件没生效」。
// 这里按生产 compose 的挂载方式起容器（模板 + conf.d/default.conf 覆盖 + 证书 +
// 两个展开脚本），再从容器内分别用 -4 / -6 打请求。
//
// ⚠️ 排查坑：容器 /etc/hosts 只有 IPv4 映射（Docker 默认不给 /etc/hosts 写 IPv6），
//    `curl http://example.com/` 会走 DNS 并可能拿到 `::1`，测出来的是 IPv6 而
//    你自己以为是 IPv4。所以这里一律用 `--resolve` / `Host:` 头显式指定地址族。
function runLiveIpv6Check() {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
  } catch {
    console.log('  ↷ 跳过真实容器 IPv6 验证：本机没有可用的 docker');
    return null;
  }

  // 本用例声称「照生产 compose 的挂载方式起容器」——先钉住这个前提，
  // 否则 compose 漏挂覆盖文件时，这里照样能起容器并全绿（假绿）。
  assert.match(
    readFileSync(join(HERE, '..', 'docker-compose.prod.yml'), 'utf8'),
    /\.\/nginx\/conf\.d\/default\.conf:\/etc\/nginx\/conf\.d\/default\.conf:ro/,
    'docker-compose.prod.yml 没有挂载 default.conf 覆盖文件，容器用例无法代表生产',
  );

  const dir = mkdtempSync(join(tmpdir(), 'nginx-ipv6-'));
  const templateDir = join(dir, 'templates');
  const certDir = join(dir, 'certs');
  mkdirSync(templateDir);
  mkdirSync(certDir);
  copyFileSync(TEMPLATE_PATH, join(templateDir, 'prod.conf.template'));
  // 与 docker-compose.prod.yml 一致：用仓库里的占位文件覆盖镜像自带的 default.conf。
  const overridePath = join(HERE, 'conf.d', 'default.conf');
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
    '-addext',
    'subjectAltName=DNS:example.com,DNS:*.example.com',
  ]);

  const name = `nginx-ipv6-test-${process.pid}`;
  const started = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      name,
      '--add-host',
      'api:127.0.0.1',
      '--add-host',
      'storefront:127.0.0.1',
      '--add-host',
      'merchant-admin:127.0.0.1',
      '--add-host',
      'platform-admin:127.0.0.1',
      '-v',
      `${templateDir}:/etc/nginx/templates:ro`,
      '-v',
      `${overridePath}:/etc/nginx/conf.d/default.conf:ro`,
      '-v',
      `${certDir}:/etc/nginx/certs:ro`,
      '-v',
      `${EXPAND_SCRIPT}:/docker-entrypoint.d/25-metrics-allow.sh:ro`,
      '-v',
      `${RATE_SCRIPT}:/docker-entrypoint.d/26-rate-limit.sh:ro`,
      '-e',
      'BASE_DOMAIN=example.com',
      '-e',
      'METRICS_ALLOW_CIDR=',
      'nginx:1.27-alpine',
    ],
    { encoding: 'utf8' },
  );
  if (started.status !== 0) {
    throw new Error(`创建 nginx 容器失败：${started.stderr || started.stdout}`);
  }
  // docker run -d 只要创建成功就返回 0：配置有错（例如两块都声明
  // `[::]:80 default_server` → duplicate listen options）时容器会**秒退**。
  // 必须显式等它运行起来，否则后面 exec 只会报误导性的 "is not running"。
  let up = false;
  for (let i = 0; i < 50; i += 1) {
    const running = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name], {
      encoding: 'utf8',
    });
    if (running.stdout.trim() === 'true') {
      up = true;
      break;
    }
    spawnSync('sleep', ['0.1']);
  }
  if (!up) {
    const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    throw new Error(`nginx 容器没起来（配置错误？）：\n${logs.stdout}${logs.stderr}`);
  }
  // 容器 running 不等于 nginx 已建好监听（entrypoint 还要渲染模板 + 跑两个脚本）。
  spawnSync('sleep', ['1']);

  /** 在容器内用 curl 打一次，返回真实 http_code 与 curl 退出码。 */
  const probe = (args) => {
    const result = spawnSync('docker', ['exec', name, 'curl', ...args], { encoding: 'utf8' });
    return { code: `${result.stdout}`.trim(), exit: result.status };
  };
  const CURL = ['-s', '-o', '/dev/null', '-w', '%{http_code}'];

  try {
    // 1) 容器内实际生效的 default.conf 必须是我们的占位文件（镜像那块不再监听任何端口）。
    const defaultConf = spawnSync('docker', ['exec', name, 'cat', '/etc/nginx/conf.d/default.conf'], {
      encoding: 'utf8',
    });
    assert.equal(defaultConf.status, 0, `读容器内 default.conf 失败：${defaultConf.stderr}`);
    assert.doesNotMatch(
      defaultConf.stdout,
      /^\s*listen\s/m,
      '容器内 default.conf 仍有 listen（镜像欢迎页块还在，Host: localhost / IP 直访会 200）',
    );

    // 2) 两个地址族都真的在监听 80 / 443（0x0050 / 0x01BB，状态 0A = LISTEN）。
    const tcp6 = spawnSync('docker', ['exec', name, 'cat', '/proc/net/tcp6'], { encoding: 'utf8' });
    assert.equal(tcp6.status, 0, `读 /proc/net/tcp6 失败：${tcp6.stderr}`);
    for (const [port, hex] of [
      [80, '0050'],
      [443, '01BB'],
    ]) {
      assert.match(
        tcp6.stdout,
        new RegExp(`:${hex}\\s+\\S+\\s+0A`),
        `没有监听在 [::]:${port}（IPv6 上该端口不可达）`,
      );
    }

    // 3) 四条主行为 + IPv4 对照。
    //    - 未知 Host / 裸根域名：444 断连 → curl 退出码 52（握手/请求后空回复）、http_code 000。
    //    - 合法店铺 Host：转发到未启动的 storefront → 502。
    const ipv6RootHttp = probe(['-g', '-6', ...CURL, '-H', 'Host: example.com', 'http://[::1]/']);
    const ipv6RootHttps = probe([
      '-g', '-6', '-k', ...CURL,
      '--resolve', 'example.com:443:[::1]', 'https://example.com/',
    ]);
    const ipv6Store = probe([
      '-g', '-6', '-k', ...CURL,
      '--resolve', 'demo.example.com:443:[::1]', 'https://demo.example.com/',
    ]);
    const ipv4RootHttp = probe(['-4', ...CURL, '-H', 'Host: example.com', 'http://127.0.0.1/']);
    const ipv4RootHttps = probe([
      '-4', '-k', ...CURL,
      '--resolve', 'example.com:443:127.0.0.1', 'https://example.com/',
    ]);
    const ipv4Store = probe([
      '-4', '-k', ...CURL,
      '--resolve', 'demo.example.com:443:127.0.0.1', 'https://demo.example.com/',
    ]);
    // Host: localhost 是覆盖文件的直接收益：不覆盖时镜像那块 server_name localhost
    // 会精确命中它，两个地址族都返回欢迎页 200（实测确认，不是猜测）。
    const ipv6Localhost = probe(['-g', '-6', ...CURL, '-H', 'Host: localhost', 'http://[::1]/']);
    const ipv4Localhost = probe(['-4', ...CURL, '-H', 'Host: localhost', 'http://127.0.0.1/']);

    // IPv6 裸根 http：绝不能是镜像欢迎页（200），必须是 444（空回复）。
    assert.notEqual(
      ipv6RootHttp.code,
      '200',
      `IPv6 裸根 http 返回了 ${ipv6RootHttp.code}（多半落到镜像欢迎页）`,
    );
    assert.equal(ipv6RootHttp.exit, 52, `IPv6 裸根 http 未 444 断连（curl exit=${ipv6RootHttp.exit}）`);
    // IPv6 裸根 https：能连上 [::]:443 并完成握手后 444。
    // curl 在 TLS 上的「空回复」是 exit 56（不是 http 的 52）；可区分的坏结果：
    // 7 = 连接被拒（[::]:443 根本没监听）、35 = TLS 握手失败（走了 ssl_reject_handshake）。
    assert.equal(ipv6RootHttps.exit, 56, `IPv6 裸根 https 未 444 断连（curl exit=${ipv6RootHttps.exit}）`);
    // IPv6 合法店铺 Host：被转发到 storefront（502 = 上游未起，说明路由正确）。
    assert.equal(ipv6Store.code, '502', `IPv6 店铺子域未转发到 storefront：${JSON.stringify(ipv6Store)}`);
    assert.equal(ipv6Store.exit, 0, `IPv6 店铺子域请求异常：${JSON.stringify(ipv6Store)}`);

    // Host: localhost / IP 直访：覆盖生效后也必须 444，不能是欢迎页 200。
    assert.notEqual(
      ipv6Localhost.code,
      '200',
      'IPv6 上 Host: localhost 拿到了镜像欢迎页（覆盖文件没生效）',
    );
    assert.equal(ipv6Localhost.exit, 52, `IPv6 Host: localhost 未 444 断连（exit=${ipv6Localhost.exit}）`);
    assert.notEqual(
      ipv4Localhost.code,
      '200',
      'IPv4 上 Host: localhost 拿到了镜像欢迎页（覆盖文件没生效）',
    );
    assert.equal(ipv4Localhost.exit, 52, `IPv4 Host: localhost 未 444 断连（exit=${ipv4Localhost.exit}）`);

    // IPv4 回退检查：同样的请求在 IPv4 上必须得到同样的结果。
    assert.equal(ipv4RootHttp.exit, 52, `IPv4 裸根 http 行为变了（exit=${ipv4RootHttp.exit}）`);
    assert.equal(ipv4RootHttps.exit, 56, `IPv4 裸根 https 行为变了（exit=${ipv4RootHttps.exit}）`);
    assert.equal(ipv4Store.code, '502', `IPv4 店铺子域行为变了：${JSON.stringify(ipv4Store)}`);

    // 两个地址族逐条对齐 —— 这才是「IPv6 行为与 IPv4 一致」的可证伪断言。
    assert.deepEqual(
      [ipv6RootHttp.code, ipv6RootHttp.exit],
      [ipv4RootHttp.code, ipv4RootHttp.exit],
      '裸根 http 在 IPv4 / IPv6 上行为不一致',
    );
    assert.deepEqual(
      [ipv6RootHttps.code, ipv6RootHttps.exit],
      [ipv4RootHttps.code, ipv4RootHttps.exit],
      '裸根 https 在 IPv4 / IPv6 上行为不一致',
    );
    assert.deepEqual(
      [ipv6Store.code, ipv6Store.exit],
      [ipv4Store.code, ipv4Store.exit],
      '店铺子域 https 在 IPv4 / IPv6 上行为不一致',
    );
    assert.deepEqual(
      [ipv6Localhost.code, ipv6Localhost.exit],
      [ipv4Localhost.code, ipv4Localhost.exit],
      'Host: localhost 在 IPv4 / IPv6 上行为不一致',
    );
  } finally {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }
  return true;
}

test('真实 nginx 容器：IPv6 与 IPv4 行为一致（未知 Host 不再返回欢迎页）', () => {
  if (runLiveIpv6Check() === null) return;
});
