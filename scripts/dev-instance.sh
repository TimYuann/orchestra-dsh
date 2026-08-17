#!/usr/bin/env bash
# orchestra-dsh 开发实例：独立 profile（~/.dsh/profiles/dev）+ 独立端口。
# 重启 dev 实例即可刷新插件，主实例（4599）全程无感。
#
# 用法：
#   scripts/dev-instance.sh          # 启动（前台，Ctrl-C 停止；重跑即重启）
#   scripts/dev-instance.sh 4700     # 指定端口
set -euo pipefail
PORT="${1:-4600}"
PROFILE="$HOME/.dsh/profiles/dev"

if [ ! -d "$PROFILE" ]; then
  echo "dev profile 不存在：$PROFILE" >&2
  exit 1
fi

# 重新 pack 后同步一次（幂等，通常 <1s）
cd "$PROFILE"
rm -f node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json
pnpm install >/dev/null 2>&1 || true

echo "orchestra-dsh dev instance -> http://127.0.0.1:$PORT (Ctrl-C 停止；主实例不受影响)"
exec dsh --profile dev --port "$PORT"
