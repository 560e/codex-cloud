# BT Panel deployment

[简体中文](../BAOTA.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

For servers where BT Panel already owns Nginx, domains and certificates. Deploy only the Node backend and retain panel-managed HTTPS; an additional Caddy instance is unnecessary.

## 1. Bring up the backend

Follow [manual Linux deployment](LINUX.md) for files, account, dependencies/build and service. Set `.env`:

```dotenv
HOST=127.0.0.1
PORT=18474
PUBLIC_ORIGIN=https://codex.example.com
COOKIE_SECURE=true
TRUST_PROXY=true
```

Configure remaining paths/resources for your machine. If Node comes from the panel's version manager, use that installation's actual executable in systemd `ExecStart` and a PATH usable by the service account. Do not copy another server's version-specific path.

Check locally:

```bash
curl --fail http://127.0.0.1:18474/api/auth/status
```

Proceed only after receiving JSON with `configured: true`; otherwise inspect service logs first.

## 2. Domain and HTTPS

Create/select the site in the panel, point DNS to the host, install/import a certificate and enable HTTPS. Replace the example domain and align `PUBLIC_ORIGIN`.

Use the panel reverse proxy to `http://127.0.0.1:18474`, or merge this into the site's HTTPS `server`. Replace an existing `location /` rather than duplicating it.

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

The same template is in `deploy/baota-nginx.conf`. Run the panel's configuration check before reloading. Preserve panel-managed certificate paths, ACME validation locations and other sites.

## 3. Acceptance and troubleshooting

After login, test streaming replies, tool-state updates, attachments and reconnection. For a healthy backend with a public 502, inspect the proxy target/port. If replies arrive in large delayed chunks, check buffering/caching. For login/WS origin errors, compare the actual URL, `PUBLIC_ORIGIN` and forwarded headers.

Ordinary attachments are limited to 20 MiB. Migration archives can exceed the example's 32 MiB proxy limit. For large online imports, adjust the site's body limit to your resource budget or use [offline migration](OPERATIONS.md).

The source repository contains no deployed site's private configuration. If using the installer here, choose `--mode=manual` so the panel continues to own the domain, SSL and Nginx configuration.
