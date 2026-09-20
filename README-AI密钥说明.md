# AI 密钥说明

本微课的终极考核与第 3 章模拟练习由**小米 MiMo**（`mimo-v2.5-pro`）提供 AI 能力。

**学员打开页面即可直接使用，不需要填写任何密钥。**

## 三不原则

| 原则 | 说明 |
|---|---|
| **不硬编码** | 源码中不出现明文密钥，只有构建期注入的 XOR + hex 混淆串 |
| **不入仓库** | 真实密钥只存在本地 `.env`，已被 `.gitignore` 排除，永不提交 |
| **不打印** | `_build.js` 全程不输出密钥或其 hex 值 |

## 密钥流转链路

```
本地 .env（MIMO_API_KEY=sk-...）
        │  node _build.js
        ▼
XOR(salt) + hex 混淆
        ▼
index.html  →  const _HEX_KEY = '<64-102位hex>';   ← 只有混淆串
        ▼
运行时 _rK() 解码  →  createOpenAIClient({ apiKey, baseURL })
```

## 常用命令

```bash
# 1) 配置密钥（首次）
cp .env.example .env
#    编辑 .env，填入 MIMO_API_KEY=sk-...

# 2) 组装页面（生成 index.html，此时密钥位仍是占位符）
python _build.py

# 3) 注入混淆密钥
node _build.js

# 4) 检查注入状态（不修改文件）
node _build.js --check

# 5) 轮换密钥后重新注入（直接覆盖旧值，幂等）
#    改完 .env 再执行：node _build.js
```

## 保护强度说明（重要）

本课程当前采用 **A 档保护**：

| 保护层 | 作用 | 局限 |
|---|---|---|
| XOR + hex 混淆 | 防止被随手复制、被搜索引擎/爬虫抓取明文 | **不是加密**。懂技术的人查看页面源码仍可还原 |
| 域名白名单 | 页面被搬运到其它站点后 AI 自动停用 | 可被伪造 Referer/Origin |
| 客户端限流 | 单浏览器 100 次/小时 | 换浏览器可绕过 |
| 异常降级 | 密钥无效/服务不可用时提示并降级为脚本回复 | — |

> ⚠️ **GitHub Pages 是公开仓库**，任何写在前端的密钥，无论怎样混淆，都无法做到绝对保密。若需要更强保护，请切换到下面的 **B 档**。

## 升级到 B 档（前端零密钥）

`_worker/` 目录已提供 Cloudflare Worker 代理代码，切换后 `index.html` 中**完全不含密钥**：

1. 按《WORKER-部署说明.md》部署 Worker，并在 Worker 环境变量里配置 `MIMO_API_KEY`；
2. 修改 `_content.py` 中的 `aiBaseUrl` 为你的 Worker 地址（形如 `https://mimo-proxy.xxx.workers.dev/v1`）；
3. 重新执行 `python _build.py`（**不需要**再跑 `_build.js`）；
4. （建议）同时到平台侧作废旧密钥。

切换后，前端可提取的只有 Worker 域名，密钥仅存在 Cloudflare 端。

## 安全建议

1. 在小米 MiMo 平台侧为该密钥**设置额度上限与告警**；
2. 若密钥曾出现在聊天记录、截图或公共渠道，**建议轮换一次**后在本地 `.env` 更新并重新注入；
3. 建议按季度轮换密钥；
4. `.env` 永远不要提交；提交前可用 `node _build.js --check` 自查。
