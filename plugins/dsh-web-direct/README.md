# dsh-web-direct

中文 | [English](#english)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）宿主插件：在 **fake-IP DNS** 环境下让内置 `web_fetch` / `web_search` 解析到真实公网地址并直连，而不是被 fake-ip 地址拦死。

## 兼容性

DeepSeek Harness **0.1.5-rc.1+** 与 **0.2.0-rc.x**（`peerDependencies` 同时声明两条线）。
0.2 的 web 接缝与 stock provider 行为未变，插件只为绕过本机 fake-ip 解析：实测未装插件时 `web_fetch` 返回
`resolves to a non-public IP address`，装载后同一请求返回 `Fetched <url> (HTTP 200)`。

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
- 凭证，按优先级：
  1. **DeepSeek 账号登录**：仅当发起搜索的会话路由是 `deepseek-account`（即对话模型用 DeepSeek 账号那条线）时，向 `ctx.deepseekAccount` 换一个 token，只发 `x-dsh-auth-token`；
  2. `DEEPSEEK_API_KEY`：credentials 服务里的值，否则回退到启动环境变量。

密钥每次搜索都重新解析，所以在 credentials 里换 key 不需要重启。

## 搜索失败时的错误信息（0.1.2+）

搜索是**独立的一次 DeepSeek Messages 调用**，不经过对话模型的接入点（opencode / 中转站 / 自建网关都无关）。0.1.2 起错误信息会把这件事直接说出来，并带上可操作的信息：

| 场景 | 错误信息里包含 |
| --- | --- |
| 两个凭证都没有 | `WEB_PROVIDER_CREDENTIAL_MISSING`，说明该会话不在账号路由上、`DEEPSEEK_API_KEY` 为空，并给出端点 |
| API key 被拒（401/403） | 实际 HTTP 状态与 DeepSeek 返回的 detail、端点、`DEEPSEEK_API_KEY` 的修补方式 |
| 账号 token 被拒（401） | 提示重新登录 DeepSeek，并说明端点不需要改 |
| 连接层失败（`TypeError: fetch failed`） | 展平后的 cause 链（如 `UND_ERR_CONNECT_TIMEOUT: … <- ETIMEDOUT`）+ 端点，并说明这是可达性问题而不是凭证问题 |

若部署里显式配置了 `web.fetchProvider` / `web.searchProvider`（或 `DSH_WEB_FETCH_PROVIDER` / `DSH_WEB_SEARCH_PROVIDER`），插件会保留该选择并打印告警，不会强行覆盖。

## English

Compatible with DeepSeek Harness **0.1.5-rc.1+** and **0.2.0-rc.x** (`peerDependencies` declares both lines).

Host plugin for DeepSeek Harness that keeps the built-in `web_fetch` / `web_search`
working on a machine whose resolver is hijacked by a fake-IP tunnel (every
hostname in `198.18.0.0/15`). It registers two web-seam providers that resolve
through explicit public DNS (`223.5.5.5` / `114.114.114.114`) and connect to the
validated real address, reusing the stock `HttpFetchProvider` for fetch and a
pinned DeepSeek Messages call for search. It never touches the VPN, and unlike
the process-wide `HTTPS_PROXY` route it does not reroute LLM/MCP traffic. The
public-unicast validation is kept, so the SSRF boundary is not relaxed.

Search authenticates with a DeepSeek Account token when the initiating Session
routed through `deepseek-account`, and otherwise with `DEEPSEEK_API_KEY` — never
with the conversation model's access point, which is why changing that route
cannot break or fix a search. Since 0.1.2 every search failure names the
endpoint: a rejected credential says which credential to replace, and a
transport failure reports the flattened cause chain
(`UND_ERR_CONNECT_TIMEOUT: … <- ETIMEDOUT`) instead of a bare
`TypeError: fetch failed`.
