#!/usr/bin/env bash
# orchestra-dsh 开发实例（前台，Ctrl-C 停止；重跑即重启）。
#
# ⚠️ 2026-09-12：~/.dsh/profiles/dev 现在是与 dsh-web-search-chained 项目
# **共享**的 profile（bundles 同时含 dsh-trinity 与 orchestra-dsh），且
# 端口 4600 自 2026-09-15 起由用户指派给 orchestra（见 docs/adr/0009）。
#
# 用法：
#   scripts/dev-instance.sh          # 启动（默认 4600）
#   scripts/dev-instance.sh 4700     # 指定端口
set -euo pipefail
PORT="${1:-4600}"
PROFILE="$HOME/.dsh/profiles/dev"

if [ ! -d "$PROFILE" ]; then
  echo "dev profile 不存在：$PROFILE" >&2
  exit 1
fi

# 重新 pack 后同步一次（幂等，通常 <1s）。删掉插件目录本身，否则 pnpm 对
# 同路径 file: tgz 的内容变化可能不重新解包。
cd "$PROFILE"
rm -rf node_modules/orchestra-dsh
rm -f node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json node_modules/.pnpm/lock.yaml
pnpm install >/dev/null 2>&1 || true

echo "orchestra-dsh dev instance -> http://127.0.0.1:$PORT (Ctrl-C 停止；端口归属见 docs/adr/0009)"
# --no-open: this script is run repeatedly while iterating, and every start
# without it opens ANOTHER tab in the user's own browser (DSH's web command
# opens the default browser by default). The dev instance is reached on purpose
# with its printed token URL, so the auto-open is pure noise.
exec dsh --profile dev --port "$PORT" --no-open
