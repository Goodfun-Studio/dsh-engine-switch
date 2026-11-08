#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { defaultRuntimes, piSession, promptAndWait } from '@botiverse/oar';

// 生成随机串（不写死）
const randomHex = randomBytes(8).toString('hex');
const token = `FWD-${randomHex}`;

console.log(`[GENERATE] Random token: ${token}`);

// 第 1 步：require('pi') 拿 runtime
const piRuntime = defaultRuntimes.require('pi');
console.log(`[RUNTIME] id="${piRuntime.id}", brand="${piRuntime.brand}"`);

// 第 2 步：installation()
const installation = await piRuntime.installation();
console.log(`[INSTALLATION] kind="${installation.kind}"`);

// 第 3 步：session(installation, {cwd, ...})
const cwd = process.cwd();
const session = await piSession(installation, { cwd });

console.log(`[SESSION] id="${session.id}"`);

// 读回实际使用的 runtime id 与 model id
const modelInfo = session.model();
console.log(`[MODEL] runtime id="${piRuntime.id}", model="${modelInfo.value}"`);

// 第 4 步：promptAndWait(session, text)
const prompt = `Reply with exactly this token: ${token}`;
console.log(`[PROMPT] Sending: "${prompt}"`);

const result = await promptAndWait(session, prompt);

console.log(`[RESULT] Outcome kind: ${result.outcome.kind}`);
console.log(`[RESULT] Text length: ${result.text?.length ?? 0}`);
console.log(`[RESULT] Full text:\n${result.text}`);

// 断言：返回文本必须包含该随机串
if (!result.text || !result.text.includes(token)) {
  console.error(`[FAIL] Token "${token}" NOT found in response!`);
  process.exit(1);
}

console.log(`[PASS] Token "${token}" found in response.`);

// 打印 OAR 返回的原始结果与事件摘要
console.log(`[RESULT_STRUCTURE] kind="${result.kind}", outcome.kind="${result.outcome.kind}"`);

// 从 session.records() 读事件流
const records = Array.from(session.records());
console.log(`[RECORDS] Total records: ${records.length}`);

// 提取所有事件类型
const allEvents = records
  .filter(r => r.body?.events && r.body.events.length > 0)
  .flatMap(r => r.body.events.map(e => e.kind || e.type));

if (allEvents.length > 0) {
  console.log(`[EVENTS] Total events: ${allEvents.length}`);
  console.log(`[EVENTS] Event kinds: ${allEvents.join(', ')}`);
} else {
  console.log(`[EVENTS] No events found in records.`);
}

await session.dispose();
console.log(`[DISPOSE] Session disposed.`);
