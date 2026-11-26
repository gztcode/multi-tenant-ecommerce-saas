#!/usr/bin/env python3
"""检查仓库 Markdown 文档里的相对链接是否可达。

用法：
    python3 scripts/check-docs-links.py            # 检查默认范围
    python3 scripts/check-docs-links.py --all      # 检查仓库内所有 .md（跳过依赖/构建目录）

默认范围：根 README.md、docs/ 下所有 Markdown、以及各模块 README.md。
只检查相对路径链接与图片；外链（http/https/mailto）、纯锚点、模板占位跳过。
退出码：0 = 无死链，1 = 存在死链。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import unquote

REPO_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_TARGETS = [
    REPO_ROOT / "README.md",
    REPO_ROOT / "docs",
    REPO_ROOT / "backend" / "README.md",
    REPO_ROOT / "miniprogram" / "README.md",
    REPO_ROOT / "mobile" / "README.md",
]

SKIP_DIRS = {
    ".git",
    ".dart_tool",
    "build",
    "node_modules",
    "Pods",
    ".idea",
    ".gradle",
    "vendor",
}

# 匹配 ![alt](target) 与 [text](target)，允许 target 后跟 "title"
LINK_RE = re.compile(r"!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+[\"'][^\"']*[\"'])?\s*\)")
FENCE_RE = re.compile(r"^(```|~~~)")


def iter_markdown(targets: list[Path], scan_all: bool) -> list[Path]:
    """返回待检查的 Markdown 文件列表。"""
    files: list[Path] = []
    seen: set[Path] = set()

    def add(path: Path) -> None:
        resolved = path.resolve()
        if resolved in seen or not resolved.is_file():
            return
        seen.add(resolved)
        files.append(resolved)

    if scan_all:
        for path in REPO_ROOT.rglob("*.md"):
            if any(part in SKIP_DIRS for part in path.relative_to(REPO_ROOT).parts):
                continue
            add(path)
        return sorted(files)

    for target in targets:
        if target.is_file():
            add(target)
        elif target.is_dir():
            for path in sorted(target.rglob("*.md")):
                if any(part in SKIP_DIRS for part in path.relative_to(REPO_ROOT).parts):
                    continue
                add(path)
    return sorted(files)


def strip_fenced_blocks(lines: list[str]) -> list[tuple[int, str]]:
    """去掉围栏代码块，返回 (原始行号, 内容) 列表。"""
    kept: list[tuple[int, str]] = []
    in_fence = False
    for lineno, line in enumerate(lines, start=1):
        if FENCE_RE.match(line.lstrip()):
            in_fence = not in_fence
            continue
        if not in_fence:
            kept.append((lineno, line))
    return kept


def is_external(target: str) -> bool:
    lowered = target.lower()
    return (
        lowered.startswith(("http://", "https://", "mailto:", "tel:", "ftp://"))
        or lowered.startswith("#")
        or lowered.startswith("data:")
    )


def check_file(path: Path) -> list[tuple[int, str, str]]:
    """返回该文件的死链列表：(行号, 原始链接, 解析后的绝对路径)。"""
    dead: list[tuple[int, str, str]] = []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()

    for lineno, line in strip_fenced_blocks(lines):
        for match in LINK_RE.finditer(line):
            raw = match.group(1).strip("<>")
            if not raw or is_external(raw) or "{{" in raw or "<" in raw:
                continue

            # 去掉锚点与查询串，处理 URL 编码（如 %20）
            target = unquote(raw.split("#", 1)[0].split("?", 1)[0])
            if not target:
                continue

            if target.startswith("/"):
                resolved = REPO_ROOT / target.lstrip("/")
            else:
                resolved = (path.parent / target).resolve()

            if not resolved.exists():
                dead.append((lineno, raw, str(resolved)))
    return dead


def relative_to_repo(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="检查 Markdown 相对链接")
    parser.add_argument(
        "--all",
        action="store_true",
        help="扫描仓库内所有 Markdown（默认只扫根 README、docs/ 与各模块 README）",
    )
    args = parser.parse_args()

    files = iter_markdown(DEFAULT_TARGETS, args.all)
    total_links = 0
    all_dead: list[tuple[Path, int, str, str]] = []

    for md_file in files:
        lines = md_file.read_text(encoding="utf-8", errors="replace").splitlines()
        for _, line in strip_fenced_blocks(lines):
            for match in LINK_RE.finditer(line):
                if not is_external(match.group(1).strip("<>")):
                    total_links += 1
        for lineno, raw, resolved in check_file(md_file):
            all_dead.append((md_file, lineno, raw, resolved))

    print(f"扫描文件：{len(files)} 个")
    print(f"相对链接：{total_links} 条")
    print(f"死链：{len(all_dead)} 条")

    if all_dead:
        print("\n死链清单：")
        for md_file, lineno, raw, resolved in all_dead:
            print(f"  {relative_to_repo(md_file)}:{lineno}")
            print(f"    链接 -> {raw}")
            print(f"    解析 -> {relative_to_repo(Path(resolved))}")
        return 1

    print("\n✅ 无死链")
    return 0


if __name__ == "__main__":
    sys.exit(main())
