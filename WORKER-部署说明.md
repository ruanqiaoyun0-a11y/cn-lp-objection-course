# Cloudflare Worker 代理部署说明（B 档：前端零密钥）

本目录提供把 API 密钥从**前端页面**迁移到**服务端 Worker** 的方案。部署完成后，`index.html` 源码中**不含任何密钥**，可提取的只有 Worker 域名。

> 什么时候需要这一步？
> 当你不接受「混淆后的密钥随公开仓库一起发布」时。当前课程用的是 A 档（混淆 + 域名白名单 + 限流），已能挡住随手复制和爬虫，但**混淆不是加密**。

---

## 一、前置条件

- 一个 Cloudflare 账号（免费版即可）
- 本机 Node.js 已安装

---

## 二、部署步骤

### 1. 安装并登录 wrangler

```bash
cd _worker
npx wrangler login
```

### 2. 配置密钥（不会写入任何文件）

```bash
npx wrangler secret put MIMO_API_KEY
# 粘贴你的 MiMo API Key，回车
```

> ⛔ 不要写进 `wrangler.toml`，不要写进任何会提交的文件。

### 3. 核对 Origin 白名单

打开 `mimo-proxy-worker.js`，确认文件顶部的 `ALLOWED_ORIGINS` 包含你的课程站点：

```js
const ALLOWED_ORIGINS = [
  'https://ruanqiaoyun0-a11y.github.io',
  'http://localhost:8123',
  'http://127.0.0.1:8123',
];
```

如果你换了 GitHub 账号或域名，请在这里补上。

### 4. 本地试跑（可选）

```bash
npx wrangler dev
# 默认监听 http://127.0.0.1:8787
```

试一下：

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:8123" \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

### 5. 正式部署

```bash
npx wrangler deploy
```

部署成功后会得到一个地址，形如：

```
https://mimo-proxy.<你的子域>.workers.dev
```

---

## 三、把课程切到 Worker

1. 编辑 `_content.py`，把 `aiBaseUrl` 改成你的 Worker 地址 + `/v1`：

```python
'aiBaseUrl': 'https://mimo-proxy.<你的子域>.workers.dev/v1',
```

> 前端会自动拼接 `/chat/completions`，所以这里只需要写到 `/v1`。

2. 重新组装页面（**不需要**再执行 `_build.js`）：

```bash
python _build.py
```

3. 用 `_build.js --check` 自查：前端应显示「密钥已注入：否（仍是占位符）」，这是**预期结果** —— 因为已不再需要前端密钥。

4. 本地实测 + 部署：

```bash
node _server.js &
node _cdp_test.js
# 部署到 GitHub Pages（见项目 README）
```

5. 上线验证：

```bash
curl -sIL "https://<你的worker>.workers.dev/v1/chat/completions" | head -1
# 期望 405（只允许 POST）或 403，说明 Worker 生效
```

6. **建议**：切换成功后，到小米 MiMo 平台把原密钥作废，并新建一把只给 Worker 使用的密钥。

---

## 四、Worker 已内置的安全能力

| 能力 | 实现 |
|---|---|
| Origin 白名单 | 非白名单来源直接 `403` |
| 单 IP 限流 | 60 次 / 小时滑动窗口，超出返回 `429` |
| 请求体上限 | 200 KB，超出返回 `413` |
| 路径收敛 | 只放行 `/v1/chat/completions`，其它 `404` |
| 模型锁定 | 强制 `model = mimo-v2.5-pro`，避免被当通用代理滥用 |
| 参数兜底 | 自动补 `thinking:{type:'disabled'}`，`max_tokens` → `max_completion_tokens` |
| 用量日志 | 记录时间 / IP / 来源 / 状态 / 耗时 / token 用量（**不含密钥**） |
| CORS | 只回显白名单内的 Origin |

> 限流基于 Worker 实例内存，跨实例不精确。如需精确限流，改用 Durable Objects 或 KV 计数。

---

## 五、回滚

把 `_content.py` 的 `aiBaseUrl` 改回 `https://api.xiaomimimo.com/v1`，重新 `python _build.py`，再执行一次 `node _build.js` 注入混淆密钥即可。
