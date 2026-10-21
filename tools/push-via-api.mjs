#!/usr/bin/env node
/**
 * 通过 GitHub REST API 推送分支（git push 的替代方案）。
 *
 * 为什么需要它：某些网络环境下 **github.com:443 不可达**（git push 走 smart-HTTP
 * 协议，需要直连该域名），但 **api.github.com 可达**（gh CLI 的所有调用都走它）。
 * 此时常规的 `git push` 会超时失败，但用 Git Data API 手工构造
 * tree / commit / ref 就能把内容推上去。
 *
 * 用法：
 *   export GH_TOKEN=$(gh auth token)
 *   node tools/push-via-api.mjs <本地分支> <远端分支>
 *
 * 例：
 *   node tools/push-via-api.mjs "feat/商品中心" "feat/商品中心"
 *
 * 说明：
 * - 远端分支**不存在**时脚本会创建它，已存在则更新。
 * - 父提交取 BASE_COMMIT 环境变量（一般传远端 main 的 SHA），这样 PR 的 diff
 *   只包含本次新增的文件。
 * - 小文件（< 100KB 的非二进制）直接内联进 tree 请求；大文件与二进制文件
 *   单独走 blob 接口——Git Trees API 对内联内容有 100KB 的单文件上限。
 */
import { execFileSync } from 'node:child_process';

const REPO = process.env.GH_REPO ?? 'gztcode/multi-tenant-ecommerce-saas';
const INLINE_LIMIT = 100 * 1024;

const [, , localBranch, remoteBranch] = process.argv;

if (!localBranch || !remoteBranch) {
  console.error('用法：node tools/push-via-api.mjs <本地分支> <远端分支>');
  process.exit(1);
}

if (!process.env.GH_TOKEN) {
  console.error('缺少 GH_TOKEN。先执行：export GH_TOKEN=$(gh auth token)');
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
}

function gh(endpoint, payload) {
  const out = execFileSync(
    'gh',
    ['api', '--method', 'POST', `repos/${REPO}/${endpoint}`, '--input', '-'],
    { input: JSON.stringify(payload), maxBuffer: 64 * 1024 * 10264 },
  );
  return JSON.parse(out.toString());
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
    const blob = gh('git/blobs', {
      content: content.toString('base64'),
      encoding: 'base64',
    });
    tree.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha });
    blobCount++;
  }
}
console.log(`内联 ${inlineCount} 个，blob ${blobCount} 个`);

// 3. 创建 tree
const createdTree = gh('git/trees', { tree });
console.log(`tree: ${createdTree.sha}`);

// 4. 创建 commit
const baseCommit =
  process.env.BASE_COMMIT ??
  execFileSync('gh', ['api', `repos/${REPO}/commits/main`, '--jq', '.sha'])
    .toString()
    .trim();

const commit = gh('git/commits', {
  message: process.env.COMMIT_MESSAGE ?? `chore: 同步 ${localBranch}`,
  tree: createdTree.sha,
  parents: [baseCommit],
});
console.log(`commit: ${commit.sha}`);

// 5. 更新远端 ref（不存在则创建）
const refPath = `repos/${REPO}/git/refs/heads/${remoteBranch}`;
const existing = await fetch(`https://api.github.com/${refPath}`, {
  headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${process.env.GH_TOKEN}`,
  },
});

if (existing.ok) {
  const res = await fetch(`https://api.github.com/${refPath}`, {
    method: 'PATCH',
    headers: {
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.GH_TOKEN}`,
    },
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  console.log(`ref ${remoteBranch} 已更新：HTTP ${res.status}`);
} else {
  const res = await fetch(`https://api.github.com/${refPath}`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.GH_TOKEN}`,
    },
    body: JSON.stringify({ ref: `refs/heads/${remoteBranch}`, sha: commit.sha }),
  });
  console.log(`ref ${remoteBranch} 已创建：HTTP ${res.status}`);
}

if (!res.ok) {
  console.log(await res.text());
  process.exit(1);
}
console.log(`\n推送完成：${commit.sha}`);
