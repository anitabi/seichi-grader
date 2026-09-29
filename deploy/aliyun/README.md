# 阿里云国内模型线路

网页本身仍放在 GitHub Pages（compose.anitabi.cn），只把 **AI 模型** 和 **onnxruntime-web 运行时** 多放一份到阿里云。
浏览器第一次需要下载模型时，会对每条线路实测一小段（约 1.5MB、最多 4 秒）的下载速度，
按快慢排好顺序交给 Service Worker；之后哪条快走哪条，一条失败自动换另一条。

- 国内直连的访客：多半阿里云更快，自动走阿里云。
- 挂了日本代理、或在海外的访客：多半日本 CF 更快，自动走 CF。
- 阿里云带宽被占满、测速变慢时：新来的访客自然分到 CF。测速结果 12 小时后过期重测。

线路定义在仓库根目录的 `model-mirrors.js`，页面和 `sw.js` 共用。

## 一、准备域名与证书

1. 选一个子域名，例如 `models.anitabi.cn`，DNS 加一条 A 记录指向服务器公网 IP。
2. 大陆服务器用域名对外提供 80/443 访问，域名必须在阿里云有 ICP 备案接入。
   如果 anitabi.cn 的备案是在别家做的，需要在阿里云做一次「新增接入」。
   没有备案接入时，阿里云会直接拦截这个域名的 HTTP/HTTPS 访问。
3. 网页是 HTTPS 的，模型地址也必须是 HTTPS。阿里云「数字证书管理服务」可以申请免费证书，
   下载 **Nginx** 版本，放到 `/etc/nginx/ssl/`。
4. 安全组放行 TCP 80、443。

## 二、配置 Nginx

```bash
# Alibaba Cloud Linux / CentOS
yum install -y nginx rsync
# Ubuntu / Debian：apt install -y nginx rsync

cp nginx-seichi-models.conf /etc/nginx/conf.d/
# 编辑：把三处 models.example.cn 换成你的域名，确认证书路径
vi /etc/nginx/conf.d/nginx-seichi-models.conf
mkdir -p /srv/seichi
nginx -t && systemctl enable --now nginx && systemctl reload nginx
```

这份配置做了三件网页离不开的事：

- `Access-Control-Allow-Origin`：只放行调色站点跨域读取。
- `Cross-Origin-Resource-Policy: cross-origin`：网页为了多线程推理开启了 COEP，缺了这个头浏览器会拒收。
- `.mjs` 以 `text/javascript`、`.wasm` 以 `application/wasm` 下发：运行时要当模块加载、流式编译。

## 三、上传模型与运行时

在本机仓库根目录运行（需要能 ssh 登录服务器）：

```bash
ALIYUN_HOST=root@你的服务器IP ./tools/sync-models-aliyun.sh
```

脚本会上传网页实际用到的 8 个模型文件（约 160MB），并从 npm 镜像取对应版本的 onnxruntime-web
运行时（约 35MB）一起传上去。断线后重跑会接着传。

上传完用脚本最后提示的两条 `curl -sI` 确认响应头。

## 四、启用线路

把 `model-mirrors.js` 里阿里云那一项的 `base` 改成你的域名（末尾不要斜杠）：

```js
{ id: 'aliyun', name: '阿里云武汉', base: 'https://models.anitabi.cn', ort: true },
```

提交并推到 main，GitHub Pages 部署后生效。

## 五、测速对比

手机或电脑打开网站 →「AI 离线包 · 抠图 / 找图模型下载」→「检测模型下载线路」，会列出：

```
✓ 日本 CF · 模型下载 1.8 MB/s · 首包 420ms
✓ 阿里云武汉 · 模型下载 4.6 MB/s · 首包 38ms
→ 自动选择：阿里云武汉
```

多找几个网络环境测一下（家里宽带、手机 4G/5G、挂代理/不挂代理），就能看出两条线路各自适合谁。
同一面板里的「下载线路」下拉框可以手动固定走某一条，方便单独对比。
「导出诊断信息」里的 `modelRoute` 和 `modelDownloadProbe` 也记录了每次测速结果。

如果测下来阿里云对所有人都更快，可以把阿里云那一项挪到数组第一位：
测速还没跑的时候（例如 Service Worker 尚未接管的首次访问），就会先用阿里云。

## 带宽与流量

- 一位访客下载完整自动抠图包约 85MB（含运行时）；SAM 兜底包、找图匹配包按需另下。
- 固定带宽的 ECS（例如 5Mbps）实际只有约 0.6MB/s，多人同时下载时平分；
  这种情况下测速会把拥挤时段的访客分到 CF，不会全堵在阿里云上。
- 按流量计费时，每位新访客约 0.1GB。页面把模型缓存进浏览器，同一台设备不会重复下载。
