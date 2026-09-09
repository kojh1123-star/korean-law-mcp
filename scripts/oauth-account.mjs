#!/usr/bin/env node
// Interactive administrator utility. Passwords never enter argv, logs, or files.
// Built-in modules only: no npm install or build required.
import { createInterface } from 'node:readline/promises';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
async function question(label) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return await rl.question(label); } finally { rl.close(); }
}
async function secret(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Run in an interactive terminal.');
  process.stderr.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error); else resolve(value);
      value = '';
    };
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') return finish(new Error('Cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') { value = Array.from(value).slice(0, -1).join(''); continue; }
        if (character >= ' ' && Buffer.byteLength(value + character) <= 256) value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}
try {
  const accounts = [];
  process.stderr.write('법령 MCP 직원 계정 발급 — 비밀번호는 화면에 표시하거나 저장하지 않습니다.\n');
  while (true) {
    const id = (await question('직원 아이디 (영문/숫자/._-, 3~64자): ')).trim();
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(id) || accounts.some(account => account.id === id)) throw new Error('Invalid or duplicate employee ID.');
    let password = await secret('비밀번호 (12자 이상, 화면에 표시되지 않음): ');
    let repeated = await secret('비밀번호 다시 입력: ');
    if (password !== repeated || password.length < 12) throw new Error('Passwords must match and contain at least 12 characters.');
    const salt = randomBytes(16).toString('hex');
    const hash = await scrypt(password, salt, 64);
    password = repeated = '';
    accounts.push({ id, passwordHash: `scrypt-v1$${salt}$${hash.toString('hex')}` });
    if ((await question('추가 직원도 등록할까요? (y/N): ')).trim().toLowerCase() !== 'y') break;
  }
  process.stderr.write('\n아래 JSON을 Railway OAUTH_USERS_JSON에 직접 붙여넣으세요.\n기존 직원이 있다면 배열 항목을 합치세요. 빠진 직원은 재배포 후 차단됩니다.\n');
  process.stdout.write(JSON.stringify(accounts) + '\n');
} catch (error) {
  process.stderr.write(`계정 발급 중단: ${error.message}\n`);
  process.exitCode = 1;
}
