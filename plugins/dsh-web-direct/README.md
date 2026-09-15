# dsh-web-direct

中文 | [English](#english)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）宿主插件：在 **fake-IP DNS** 环境下让内置 `web_fetch` / `web_search` 解析到真实公网地址并直连，而不是被 fake-ip 地址拦死。

## 它解决什么问题

有些机器（公司零信任 / SASE / Clash·Mihomo 透明代理）的系统解析器会把**所有**域名解析到 `198.18.0.0/15` 这类保留段（fake-ip），于是：

- `web_fetch` 的 SSRF 防护判定"非公网单播地址"，**确定性**地报错：
  `URL hostname "..." resolves to a non-public IP address`（`WEB_BLOCKED_URL`）；
- `web_search` 连 `api.deepseek.com` 时，隧道对**复用 keep-alive 连接**的转发会间歇性黑洞，请求卡到 60s 工具超时。

## 它怎么做

插件**不碰 VPN**，也**不使用**进程级出站代理（`HTTPS_PROXY` + `@deepseek-ai/dsh-http-proxy`）——那条路会把 LLM、MCP、插件流量一起接管，环境里若存在内网 LLM 端点就会连不上。它只在 web seam 上注册两个 provider：

| provider id | 作用 |
| --- | --- |
| `http-direct` | 复用官方 `@deepseek-ai/dsh-web-fetch-http` 的 `HttpFetchProvider`（公网校验、地址固定、同源重定向、字节/字符集上限），只把 `resolveAddresses` 换成**公共 DNS 解析** |
| `deepseek-direct` | 调 DeepSeek 的 Anthropic 兼容 Messages API（原生 `web_search_20250305`），连接**固定到端点的真实公网 IP** |

解析走 `dns.resolve4/6`（c-ares 通道），并在启动时 `dns.setServers(["223.5.5.5", "114.114.114.114"])`；其他组件使用的 `dns.lookup`（getaddrinfo）通道不受影响。

安全性：解析结果仍按"公网单播"校验（fake-ip 的 `198.18.0.0/15`→保留段被拒），连接只使用已验证地址，重定向逐跳复核——**没有**放宽 SSRF 边界，也没有把 `198.18.0.0/15` 加进白名单。

## 安装

```bash
dsh plugin --profile web add link:/Users/duankaiqiang/proj/moonshile-dsh-plugins/plugins/dsh-web-direct
```

安装后重启 `dsh web`（插件在启动时装载）。

## 验证

```bash
node --test lib/core.test.mjs   # 纯逻辑单测（地址判定 / pinned lookup / 响应映射）
```

运行时看日志会出现：

```
[web-direct] real-DNS web providers active (fetch=http-direct, search=deepseek-direct)
```

## 配置

无需配置。搜索端点/密钥沿用 DSH 既有约定：

- 端点：`DEEPSEEK_SEARCH_BASE_URL`（默认 `https://api.deepseek.com/anthropic/v1`）
- 密钥：credentials 服务里的 `DEEPSEEK_API_KEY`，否则回退到启动环境变量

若部署里显式配置了 `web.fetchProvider` / `web.searchProvider`（或 `DSH_WEB_FETCH_PROVIDER` / `DSH_WEB_SEARCH_PROVIDER`），插件会保留该选择并打印告警，不会强行覆盖。

## English

Host plugin for DeepSeek Harness that keeps the built-in `web_fetch` / `web_search`
working on a machine whose resolver is hijacked by a fake-IP tunnel (every
hostname in `198.18.0.0/15`). It registers two web-seam providers that resolve
through explicit public DNS (`223.5.5.5` / `114.114.114.114`) and connect to the
validated real address, reusing the stock `HttpFetchProvider` for fetch and a
pinned DeepSeek Messages call for search. It never touches the VPN, and unlike
the process-wide `HTTPS_PROXY` route it does not reroute LLM/MCP traffic. The
public-unicast validation is kept, so the SSRF boundary is not relaxed.
