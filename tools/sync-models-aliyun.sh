#!/usr/bin/env bash
# 把网页实际用到的 AI 模型与 onnxruntime-web 运行时同步到阿里云服务器（国内下载线路）。
#
# 用法（在仓库根目录或任意位置运行均可）：
#   ALIYUN_HOST=root@你的服务器IP ./tools/sync-models-aliyun.sh
# 可选环境变量：
#   ALIYUN_DIR  服务器上的站点根目录，默认 /srv/seichi（与 deploy/aliyun/nginx-seichi-models.conf 的 root 一致）
#   SSH_PORT    默认 22
# 依赖：本机 bash、ssh、rsync、curl、tar；服务器上装有 rsync（Alibaba Cloud Linux：yum install -y rsync）。
set -euo pipefail
cd "$(dirname "$0")/.."

: "${ALIYUN_HOST:?请设置 ALIYUN_HOST，例如 ALIYUN_HOST=root@1.2.3.4}"
ALIYUN_DIR="${ALIYUN_DIR:-/srv/seichi}"
SSH_PORT="${SSH_PORT:-22}"
ORT_VER="$(sed -n "s/^const ORT_VER = '\(.*\)';/\1/p" ort-env.js)"
[[ -n "$ORT_VER" ]] || { echo "没能从 ort-env.js 读到 ORT_VER" >&2; exit 1; }

# 与 app.js 的离线包清单一致（ISNet 是分块文件；iPhone/iPad 用 512 版）
MODELS=(
  person-detect.onnx
  isnet-anime-w8.onnx.part00 isnet-anime-w8.onnx.part01
  isnet-anime-512-w8.onnx.part00 isnet-anime-512-w8.onnx.part01
  sam-encoder.onnx sam-decoder.onnx
  scene-embed-int8.onnx
)
RUNTIME=(
  ort.webgpu.mjs
  ort-wasm-simd-threaded.jsep.mjs ort-wasm-simd-threaded.jsep.wasm
  ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm
)

for f in "${MODELS[@]}"; do
  [[ -f "models/$f" ]] || { echo "缺少 models/$f——先 git pull 拿到完整模型" >&2; exit 1; }
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "== 下载 onnxruntime-web@$ORT_VER 运行时（先试 npmmirror，再试 npmjs）"
TGZ="$STAGE/ort.tgz"
curl -fL --retry 3 -o "$TGZ" "https://registry.npmmirror.com/onnxruntime-web/-/onnxruntime-web-$ORT_VER.tgz" \
  || curl -fL --retry 3 -o "$TGZ" "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-$ORT_VER.tgz"
PATHS=()
for f in "${RUNTIME[@]}"; do PATHS+=("package/dist/$f"); done
tar xzf "$TGZ" -C "$STAGE" "${PATHS[@]}"
mkdir -p "$STAGE/ort/$ORT_VER"
mv "$STAGE/package/dist/"* "$STAGE/ort/$ORT_VER/"

echo "== 上传到 $ALIYUN_HOST:$ALIYUN_DIR"
SSH="ssh -p $SSH_PORT"
$SSH "$ALIYUN_HOST" "mkdir -p '$ALIYUN_DIR/models' '$ALIYUN_DIR/ort'"
# --partial：大文件传到一半断线，重跑脚本会接着传。不用 --delete，避免误删服务器上的其他文件。
printf '%s\n' "${MODELS[@]}" > "$STAGE/models.txt"
rsync -av --partial --progress -e "$SSH" --files-from="$STAGE/models.txt" models/ "$ALIYUN_HOST:$ALIYUN_DIR/models/"
rsync -av --partial --progress -e "$SSH" "$STAGE/ort/" "$ALIYUN_HOST:$ALIYUN_DIR/ort/"

cat <<MSG

== 完成。用下面两条命令确认响应头（把域名换成你的）：
  curl -sI -H 'Origin: https://compose.anitabi.cn' https://models.example.cn/models/person-detect.onnx
  curl -sI -H 'Origin: https://compose.anitabi.cn' https://models.example.cn/ort/$ORT_VER/ort-wasm-simd-threaded.jsep.mjs
应看到 200、access-control-allow-origin: https://compose.anitabi.cn、cross-origin-resource-policy: cross-origin，
第二条的 content-type 是 text/javascript。
MSG
