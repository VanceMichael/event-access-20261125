// 启动一个带合成演示数据的业务服务：npm run demo
// 演示状态默认写入 .local/demo.json；DEMO_RESET=1 或 --reset 可重建。
import { rmSync } from 'node:fs';
import { createServer } from '../server.mjs';

const stateFile = process.env.DEMO_STATE ?? '.local/demo.json';
if (process.argv.includes('--reset') || process.env.DEMO_RESET === '1') {
  rmSync(stateFile, { force: true });
}
const server = createServer({ stateFile });
const core = server.core;

if (core.state.applications.length === 0 && core.state.events.length === 0) {
  const DAY = '2026-11-27T10:00:00Z';
  // 身份 / 资格 / 岗位 / 证件
  core.confirmIdentity('PE-1', { actorId: 'credential', at: DAY });
  core.confirmIdentity('PE-3', { actorId: 'credential', at: DAY });
  core.reviewTraining('TRAIN-1', { actorId: 'credential', decision: 'allow', at: DAY });
  core.reviewTraining('TRAIN-2', { actorId: 'credential', decision: 'allow', at: DAY });
  const a1 = core.createAssignment({ actorId: 'operations', person: 'PE-1', dutyId: 'DUTY-1', role: 'equipment' });
  core.approveAssignment(a1.id, { actorId: 'operations', at: DAY });
  const a3 = core.createAssignment({ actorId: 'operations', person: 'PE-3', dutyId: 'DUTY-1', role: 'equipment' });
  core.approveAssignment(a3.id, { actorId: 'operations', at: DAY });
  const media = core.createDeclaration({ actorId: 'operations', category: 'media', personId: 'PE-1' });
  core.decideApplication(media.application.id, { actorId: 'credential', decision: 'approve', at: DAY });
  core.issueBadge({ actorId: 'credential', person: 'PE-1', at: DAY });
  core.issueBadge({ actorId: 'credential', person: 'PE-3', at: DAY });

  // 闸机与同步快照
  core.createGate({ actorId: 'operations', id: 'GATE-C', zone: 'Z-MEDIA', mode: 'offline' });
  core.gateSync('GATE-A', { at: '2026-11-28T00:00:20Z', quota: 2 });
  core.gateSync('GATE-B', { at: '2026-11-28T00:00:25Z', quota: 5 });
  core.setGateMode('GATE-A', { mode: 'offline' });

  // PE-3 已到岗
  core.ingestEvent({ gate: 'GATE-B', sequence: 2, person: 'PE-3', badgeGeneration: 1, type: 'enter', at: '2026-11-28T00:00:40Z', receivedAt: '2026-11-28T00:00:44Z' });

  // PE-1 挂失换证；GATE-A 快照仍停留在旧撤销版本
  core.reissueBadge({ actorId: 'credential', person: 'PE-1', reason: '挂失', at: '2026-11-28T00:00:45Z' });
  core.gateSync('GATE-C', { at: '2026-11-28T00:01:30Z' });

  // 新证新区入场先到
  core.ingestEvent({ gate: 'GATE-C', sequence: 1, person: 'PE-1', badgeGeneration: 2, type: 'enter', at: '2026-11-28T00:02:00Z', receivedAt: '2026-11-28T00:02:08Z', offline: true });
  // 旧证旧区记录晚到（时钟误差在容差内）→ 形成未决位置争议
  core.ingestEvent({ gate: 'GATE-A', sequence: 1, localSerial: 'LOCAL-JOURNAL-0001', person: 'PE-1', badgeGeneration: 1, type: 'enter', at: '2026-11-28T00:01:00Z', receivedAt: '2026-11-28T00:01:20Z', offline: true });
  // 一条时钟误差超标的补传，留在待核实队列
  core.ingestEvent({ gate: 'GATE-A', sequence: 8, localSerial: 'LOCAL-JOURNAL-0008', person: 'PE-2', badgeGeneration: 1, type: 'enter', at: '2026-11-28T00:10:00Z', receivedAt: '2026-11-28T01:00:00Z', offline: true });
  // 在线闸机拒绝旧证的审计记录
  core.ingestEvent({ gate: 'GATE-B', sequence: 99, person: 'PE-1', badgeGeneration: 1, type: 'enter', at: '2026-11-28T00:03:00Z', receivedAt: '2026-11-28T00:03:02Z' });
  core.save();
  console.log('已写入合成演示数据：PE-1 位置争议、PE-2 待核实时钟事件、GATE-A 撤销覆盖缺口。');
}

const port = Number(process.env.PORT ?? 4318);
server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(JSON.stringify({ message: '演示服务已启动', ui: `http://127.0.0.1:${port}/ui`, stateFile }));
});
