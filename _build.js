#!/usr/bin/env node
/**
 * _build.js — 把 MiMo API Key 以 XOR + hex 混淆后注入 index.html
 *
 * 安全三不原则：不硬编码 / 不入仓库 / 不打印
 *
 * 用法：
 *   node _build.js           从 .env 或环境变量 MIMO_API_KEY 读取并注入
 *   node _build.js --check   只检查注入状态，不做修改
 *
 * 与 index.html 中 _rK() 的约定：
 *   盐值必须与 index.html 的 _SALT 完全一致
 *   编码：key 的每个字节 XOR 盐值字节 → 两位 hex
 *   解码：hex → 字节 → 再 XOR 同一盐值 → 字符
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const TARGET = path.join(HERE, 'index.html');
const SALT = 'vipthink-cn-lp-objection';   // 必须与 index.html 的 _SALT 一致
const PLACEHOLDER = "'__MIMO_API_KEY__'";

function loadKey() {
  if (process.env.MIMO_API_KEY) return process.env.MIMO_API_KEY.trim();
  const envPath = path.join(HERE, '.env');
  if (fs.existsSync(envPath)) {
    const txt = fs.readFileSync(envPath, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*MIMO_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

function xorHex(key) {
  const buf = Buffer.from(key, 'utf8');
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i] ^ SALT.charCodeAt(i % SALT.length);
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  if (!fs.existsSync(TARGET)) {
    console.error('找不到 index.html，请先运行 python _build.py');
    process.exit(1);
  }
  let html = fs.readFileSync(TARGET, 'utf8');

  if (checkOnly) {
    const injected = !html.includes(PLACEHOLDER);
    const hasPlain = /sk-[A-Za-z0-9]{20,}/.test(html);
    console.log('index.html 存在：是');
    console.log('密钥已注入：' + (injected ? '是' : '否（仍是占位符）'));
    console.log('明文密钥计数：' + (hasPlain ? '⚠️ 发现' : '0（正常）'));
    process.exit(injected && !hasPlain ? 0 : 2);
  }

  const key = loadKey();
  if (!key) {
    console.error('未找到 MIMO_API_KEY（请检查 .env 或环境变量）。已跳过注入。');
    process.exit(1);
  }
  if (!/^sk-/.test(key)) {
    console.error('MIMO_API_KEY 格式异常（应以 sk- 开头）。已跳过注入。');
    process.exit(1);
  }

  const hex = xorHex(key);
  if (html.includes(PLACEHOLDER)) {
    html = html.replace(PLACEHOLDER, "'" + hex + "'");
  } else {
    // 已注入过：用新 hex 覆盖旧值（支持轮换密钥）
    const re = /const _HEX_KEY = '[0-9a-fA-F]+';/;
    if (!re.test(html)) {
      console.error('未找到 _HEX_KEY 注入点，请检查 index.html 是否被改动。');
      process.exit(1);
    }
    html = html.replace(re, "const _HEX_KEY = '" + hex + "';");
  }
  fs.writeFileSync(TARGET, html, { encoding: 'utf8' });
  // 绝不打印 key 或 hex
  console.log('✅ 密钥已混淆注入 index.html（长度 ' + hex.length + ' hex 字符）');
  console.log('   XOR+hex 混淆 ≠ 加密；公开仓库下仍可被还原，建议配合域名白名单与限流，或切换到 Worker 代理模式。');
}

main();
