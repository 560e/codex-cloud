#!/usr/bin/env bash
set -euo pipefail
SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NODE_VERSION=24.21.0
NETWORK="${CODEX_CLOUD_INSTALL_NETWORK:-}"
CHECK=false
for arg in "$@"; do
  case "$arg" in --check|--dry-run|--help) CHECK=true ;; --network=*) NETWORK="${arg#*=}" ;; esac
 done
case "$(uname -s)" in Linux) PLATFORM=linux ;; Darwin) PLATFORM=darwin ;; *) echo '此脚本支持 Linux/macOS；Windows 请运行 install.ps1。'; exit 1 ;; esac
if [[ "$PLATFORM" == darwin && "$(id -u)" == 0 ]]; then echo "macOS 请用登录用户运行本脚本，不要使用 sudo bash install.sh。"; exit 1; fi
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo '暂不支持此 CPU 架构。'; exit 1 ;; esac
printf '系统：%s / %s\n' "$PLATFORM" "$ARCH"
if [[ "$PLATFORM" == linux && -f /etc/os-release ]]; then cat /etc/os-release | sed -n '/^PRETTY_NAME=/p'; fi
node_ready() { command -v node >/dev/null && command -v npm >/dev/null && node -e 'if(Number(process.versions.node.split(".")[0])<24 || (process.getuid?.()===0 && process.execPath.startsWith("/root/")))process.exit(1);require("node:sqlite")' >/dev/null 2>&1 && npm --version >/dev/null 2>&1; }
if [[ "$CHECK" == true ]]; then
  if node_ready; then exec node "$SCRIPT_ROOT/scripts/install/setup.mjs" "$@"; fi
  echo '需要安装 Node.js 24 LTS（含 npm）。检查模式未修改服务器。'
  echo '正常安装入口：bash install.sh；Windows：powershell -File install.ps1'
  exit 0
fi
if [[ -z "$NETWORK" ]]; then
  printf '下载网络：1 中国网络（默认）  2 海外网络  3 自定义\n'
  read -r -p '请选择 [1]：' choice
  case "${choice:-1}" in 1) NETWORK=cn ;; 2) NETWORK=global ;; 3) NETWORK=custom ;; *) echo '无效选择'; exit 1 ;; esac
fi
case "$NETWORK" in cn|global|custom) ;; *) echo '网络选项必须是 cn/global/custom'; exit 1 ;; esac
export CODEX_CLOUD_INSTALL_NETWORK="$NETWORK"
if [[ "$NETWORK" == custom && -z "${CODEX_CLOUD_NODE_MIRROR:-}" ]]; then read -r -p 'Node 下载地址（例如 https://nodejs.org/dist）：' CODEX_CLOUD_NODE_MIRROR; export CODEX_CLOUD_NODE_MIRROR; fi
if ! node_ready || [[ "${CODEX_CLOUD_FORCE_NODE:-0}" == 1 ]]; then
  if [[ "$PLATFORM" == linux ]]; then
    GLIBC="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)"
    if [[ -z "$GLIBC" ]] || ! awk -v v="$GLIBC" 'BEGIN {split(v,a,"."); exit !(a[1]>2 || (a[1]==2 && a[2]>=28))}'; then
      echo 'Node 24 官方二进制需要 glibc >= 2.28。CentOS 7 / Alpine 等环境请升级系统或使用兼容容器。'; exit 1
    fi
  fi
  admin() { if [[ "$(id -u)" == 0 ]]; then "$@"; else sudo "$@"; fi; }
  if ! command -v curl >/dev/null || ! command -v tar >/dev/null || { [[ "$PLATFORM" == linux ]] && ! command -v xz >/dev/null; }; then
    if [[ "$PLATFORM" == darwin ]]; then echo '请先安装系统自带的 curl、tar，然后重试。'; exit 1
    elif command -v apt-get >/dev/null; then admin apt-get update; admin apt-get install -y curl ca-certificates tar xz-utils
    elif command -v dnf >/dev/null; then admin dnf install -y curl ca-certificates tar xz
    elif command -v yum >/dev/null; then admin yum install -y curl ca-certificates tar xz
    elif command -v zypper >/dev/null; then admin zypper --non-interactive install curl ca-certificates tar xz
    elif command -v pacman >/dev/null; then admin pacman -S --needed --noconfirm curl ca-certificates tar xz
    else echo '无法识别包管理器，请安装 curl、tar、xz 后重试。'; exit 1; fi
  fi
  RUNTIME="${CODEX_CLOUD_RUNTIME_DIR:-${HOME}/.local/share/codex-cloud/runtime}"
  if [[ "$(id -u)" == 0 ]]; then RUNTIME="${CODEX_CLOUD_RUNTIME_DIR:-/var/lib/codex-cloud/runtime}"; fi
  mkdir -p "$RUNTIME"
  TEMP_DIR="$(mktemp -d)"; trap 'rm -rf "$TEMP_DIR"' EXIT
  FILE="node-v${NODE_VERSION}-${PLATFORM}-${ARCH}.tar.xz"
  # macOS official distributions use .tar.gz and need no xz.
  if [[ "$PLATFORM" == darwin ]]; then FILE="node-v${NODE_VERSION}-${PLATFORM}-${ARCH}.tar.gz"; fi
  MIRROR="${CODEX_CLOUD_NODE_MIRROR:-https://nodejs.org/dist}"
  if [[ "$NETWORK" == cn ]]; then MIRROR="${CODEX_CLOUD_NODE_MIRROR:-https://registry.npmmirror.com/-/binary/node}"; fi
  [[ "$MIRROR" == https://* && ! "$MIRROR" =~ ^https://[^/]*@ ]] || { echo 'Node 镜像必须是无内嵌凭据的 HTTPS 地址。'; exit 1; }
  download_node() { curl -fSL --retry 2 --connect-timeout 20 "$1/v${NODE_VERSION}/$FILE" -o "$TEMP_DIR/$FILE" && curl -fSL --retry 2 --connect-timeout 20 "$1/v${NODE_VERSION}/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"; }
  if ! download_node "$MIRROR"; then echo '下载源不可用，尝试 Node 官方源。'; download_node https://nodejs.org/dist; fi
  EXPECTED="$(awk -v file="$FILE" '$2==file {print $1}' "$TEMP_DIR/SHASUMS256.txt")"
  if command -v sha256sum >/dev/null; then ACTUAL="$(sha256sum "$TEMP_DIR/$FILE" | awk '{print $1}')"; else ACTUAL="$(shasum -a 256 "$TEMP_DIR/$FILE" | awk '{print $1}')"; fi
  [[ -n "$EXPECTED" && "$EXPECTED" == "$ACTUAL" ]] || { echo 'Node 下载校验失败。'; exit 1; }
  tar -xf "$TEMP_DIR/$FILE" -C "$RUNTIME" --strip-components=1
  export PATH="$RUNTIME/bin:$PATH"
fi
node_ready || { echo 'Node/npm 检查失败。'; exit 1; }
exec node "$SCRIPT_ROOT/scripts/install/setup.mjs" "$@"
