# 宝塔面板部署

[English](en/BAOTA.md) · [文档目录](INDEX.md) · [项目首页](../README.md)

本页适用于宝塔已经管理 Nginx、域名和证书的服务器。工作台只需要一个 Node 后端；继续由面板管理网站和 SSL，无需再部署 Caddy。

## 1. 先启动后端

按[Linux 手动部署](LINUX.md)准备程序、服务账户、依赖与构建，配置 `.env`：

```dotenv
HOST=127.0.0.1
PORT=18474
PUBLIC_ORIGIN=https://codex.example.com
COOKIE_SECURE=true
TRUST_PROXY=true
```

其余路径和资源配置按实际环境填写。若 Node 来自面板版本管理器，把该版本的实际可执行路径写入 systemd `ExecStart`，并设置服务账户可用的 PATH；不要直接复制其他服务器的版本路径。

启动后在服务器本机检查：

```bash
curl --fail http://127.0.0.1:18474/api/auth/status
```

只有返回 JSON 且 `configured: true`，才继续接入网站；后端不可达时先查 systemd 日志。

## 2. 配置域名与 HTTPS

在面板创建或选择目标站点，将 DNS 指向服务器，申请或导入证书并启用 HTTPS。示例域名必须替换成自己的域名，同时保持 `PUBLIC_ORIGIN` 一致。

使用面板反向代理功能指向 `http://127.0.0.1:18474`，或将下面内容合并到该站点的 HTTPS `server` 中。已有 `location /` 时应替换其内容，不要添加重复块。

```nginx
location / {
    proxy_pass http://127.0.0.1:18474;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
    proxy_cache off;
    client_max_body_size 32m;
}
```

同一模板位于 `deploy/baota-nginx.conf`。保存前使用面板的配置检查功能，确认通过再重载。现有证书路径、ACME 验证目录和其他站点配置由面板保留。

## 3. 验收与常见故障

浏览器登录后验证流式回复、工具状态更新、附件和断线重连。健康接口正常但页面 502，通常需核对反代目标端口；回复延迟成整段出现，检查缓冲或缓存；登录/WS 来源错误，核对实际 URL、`PUBLIC_ORIGIN` 和转发头。

普通附件上限为 20 MiB。在线迁移包可大于示例中的 32 MiB 反代限制；需要在线导入大包时，按自己的资源预算调整该站点请求体限制，或使用[离线迁移](OPERATIONS.md)。

源码仓库不包含任何已部署站点的专用配置。安装器若用于这类机器，应选择 `--mode=manual`，让面板继续拥有域名、SSL 和 Nginx 配置。
