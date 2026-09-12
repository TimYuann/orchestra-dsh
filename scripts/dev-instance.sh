#!/usr/bin/env bash
# orchestra-dsh 开发实例（前台，Ctrl-C 停止；重跑即重启）。
#
# ⚠️ 2026-09-12：~/.dsh/profiles/dev 现在是与 dsh-web-search-chained 项目
# **共享**的 profile（bundles 同时含 dsh-trinity 与 orchestra-dsh），且
# **4600 端口属于该项目的运行实例**——所以本脚本默认改用 4601。
#
# 用法：
#   scripts/dev-instance.sh          # 启动（默认 4601）
#   scripts/dev-instance.sh 4700     # 指定端口
set -euo pipefail
PORT="${1:-4601}"
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

echo "orchestra-dsh dev instance -> http://127.0.0.1:$PORT (Ctrl-C 停止；4600 与其他项目不受影响)"
exec dsh --profile dev --port "$PORT"
