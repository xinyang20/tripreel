#!/bin/zsh -l
cd -- "${0:A:h}" || exit 1
if ! command -v pnpm >/dev/null 2>&1; then
  print '未找到 pnpm，请先安装 Node.js 22+ 和 pnpm 10。'
  read -r '?按回车退出。'
  exit 1
fi
if curl --silent --fail --max-time 2 http://127.0.0.1:4173/ >/dev/null; then
  print '本地 4173 端口已有服务，请在浏览器打开 http://127.0.0.1:4173'
  read -r '?按回车关闭此窗口。'
  exit 0
fi
print '请在浏览器打开 http://127.0.0.1:4173；关闭此窗口将停止服务。'
pnpm run start
