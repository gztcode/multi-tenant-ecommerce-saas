#!/usr/bin/env node
/**
 * 通过 GitHub REST API 推送分支（`tools/push-via-api.mjs` 的 curl 版）。
 *
 * ## 为什么不用 `tools/push-via-api.mjs`
 *
 * 那个脚本用 `gh api --method POST ... --input -` 传 body。**中文分支名**
 * （`gzt/电商项目`）会让 `gh` 的参数编码出错（报 422 / 打印字节数组），
 * 而分支名是本仓的既定命名，不能改。
 *
 * 本脚本改用 `curl` 直连 `api.github.com`：
 * - JSON body 由 `JSON.stringify` 生成，**UTF-8 原样**；
 * - 分支名走 URL 编码（`encodeURIComponent`），GitHub 认得。
 *
 * 用法：
 *   export GH_TOKEN=$(gh auth token)
 *   node tools/push-via-api-curl.mjs <本地分支> <远端分支>
 *
 * 说明：
 * - 远端分支不存在 → 创建；已存在 → 快进更新。
 * - 父提交优先接**远端同名分支当前的位置**（这才是 git push 的语义）；
 *   不存在则接 `BASE_COMMIT`（一般传远端 main 的 SHA）。
 */
import { execFileSync } from 'node:child_process';

const REPO = process.env.GH_REPO ?? 'gztcode/multi-tenant-ecommerce-saas';
const INLINE_LIMIT = 100 * 1024;
const API = `https://api.github.com/repos/${REPO}`;

const [, , localBranch, remoteBranch] = process.argv;

if (!localBranch || !remoteBranch) {
  console.error('用法：node tools/push-via-api-curl.mjs <本地分支> <远端分支>');
  process.exit(1);
}

if (!process.env.GH_TOKEN) {
  console.error('缺少 GH_TOKEN。先执行：export GH_TOKEN=$(gh auth token)');
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
}

/** 调 GitHub API（`body` 为空表示 GET） */
async function api(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      'user-agent': 'push-via-api-curl',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${method} ${endpoint} 返回的不是 JSON：${text.slice(0, 400)}`);
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${endpoint} → HTTP ${res.status}：${parsed.message ?? text.slice(0, 400)}`,
    );
  }
  return parsed;
}

// 1. 列出分支上的全部文件
const raw = git('ls-tree', '-r', '-z', localBranch).toString();
const files = raw
  .split('\0')
  .filter(Boolean)
  .map((line) => {
    const [meta, path] = line.split('\t');
    const [mode, type, sha] = meta.split(' ');
    return { mode, type, sha, path };
  });

console.log(`共 ${files.length} 个文件`);

// 2. 构造 tree：小文件内联内容，大文件与二进制走 blob
const tree = [];
let blobCount = 0;
let inlineCount = 0;

for (const file of files) {
  const content = git('cat-file', 'blob', file.sha);
  const isBinary = content.includes(0);

  if (!isBinary && content.length <= INLINE_LIMIT) {
    tree.push({
      path: file.path,
      mode: file.mode,
      type: 'blob',
      content: content.toString('utf8'),
    });
    inlineCount++;
  } else {
    const blob = await api('POST', '/git/blobs', {
      content: content.toString('base64'),
      encoding: 'base64',
    });
    tree.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha });
    blobCount++;
  }
}
console.log(`内联 ${inlineCount} 个，blob ${blobCount} 个`);

// 3. 创建 tree
const createdTree = await api('POST', '/git/trees', { tree });
console.log(`tree: ${createdTree.sha}`);

// 4. 读远端 ref 当前指向哪里——它决定新 commit 该接在谁后面
const encodedBranch = encodeURIComponent(remoteBranch);
let existingSha = null;
try {
  const existing = await api('GET', `/git/ref/heads/${encodedBranch}`);
  existingSha = existing.object.sha;
} catch {
  existingSha = null;
}

// 5. 创建 commit
const baseCommit =
  existingSha ??
  process.env.BASE_COMMIT ??
  (await api('GET', '/commits/main')).sha;

const commit = await api('POST', '/git/commits', {
  message: process.env.COMMIT_MESSAGE ?? `chore: 同步 ${localBranch}`,
  tree: createdTree.sha,
  parents: [baseCommit],
});
console.log(`commit: ${commit.sha}`);
console.log(`父提交: ${baseCommit}${existingSha ? '（接续远端分支）' : '（新建分支）'}`);

// 6. 更新远端 ref（不存在则创建）
//
// ⚠️ **创建与更新 ref 的端点不同**：
//   创建：POST /git/refs（body 里带完整的 ref 名）
//   更新：PATCH /git/refs/heads/{ref}（body 里只带 sha）
if (existingSha) {
  await api('PATCH', `/git/refs/heads/${encodedBranch}`, {
    sha: commit.sha,
    force: false,
  });
  console.log(`已更新 refs/heads/${remoteBranch}`);
} else {
  await api('POST', '/git/refs', {
    ref: `refs/heads/${remoteBranch}`,
    sha: commit.sha,
  });
  console.log(`已创建 refs/heads/${remoteBranch}`);
}
console.log(`→ ${commit.sha}`);
