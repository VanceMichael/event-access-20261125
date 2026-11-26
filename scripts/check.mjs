// 本地核对剧本：换证、替班、离线迟到入场相遇，以及额度/撤销覆盖。
// 全部使用合成身份与本地闸机协议，不连接真实设备、不绕过门禁。
// 运行：npm run check
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';
import { createPeer } from '../support/peer.mjs';

const fixtures = JSON.parse(await readFile(new URL('../fixtures/records.json', import.meta.url)));
const partnerConfig = JSON.parse(await readFile(new URL('../fixtures/partner.json', import.meta.url)));

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ✅ ${label}`);
  else { failures += 1; console.error(`  ❌ ${label}`); }
};
const section = title => console.log(`\n━━ ${title} ━━`);
const info = label => console.log(`  · ${label}`);

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const closeServer = server => new Promise(resolve => server.close(resolve));

const dir = await mkdtemp(join(tmpdir(), 'event-access-check-'));
const partner = createPeer(partnerConfig, join(dir, 'partner.json'));
const pbase = await listen(partner);
const server = createServer({ stateFile: join(dir, 'app.json'), fixtures, partnerUrl: pbase });
const base = await listen(server);
console.log(`业务服务：${base}（临时状态目录 ${dir}）`);
console.log(`本地闸机同步方协议服务：${pbase}`);

async function api(path, options = {}) {
  const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET');
  const headers = { 'Content-Type': 'application/json' };
  if (options.actor) headers['X-Actor'] = options.actor;
  const res = await fetch(base + path, {
    method, headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (options.expect && res.status !== options.expect) {
    failures += 1;
    console.error(`  ❌ ${path} 期望 ${options.expect}，实际 ${res.status}：${text}`);
  }
  return { status: res.status, json };
}
const DAY = '2026-11-27T10:00:00Z';

try {
  section('序幕：同名是两个身份，不能合并');
  const people = (await api('/api/people')).json;
  const shen = people.filter(p => p.name === '沈安');
  ok(shen.length === 2 && shen[0].id !== shen[1].id, `资料中两个“沈安”是 ${shen.map(p => p.id).join(' 与 ')}`);
  await api('/api/declarations', { body: { category: 'media', personId: 'PE-1' } });
  const apps = (await api('/api/applications')).json;
  const mediaApp = apps[apps.length - 1];
  await api(`/api/applications/${mediaApp.id}/decision`, { actor: 'credential', body: { decision: 'approve', at: DAY } });
  ok(mediaApp.status === 'pending', '媒体申请初始为待核准，文件存在不等于批准');

  section('第一幕：身份确认 + 培训核准 + 岗位核准（三件事互相独立）');
  await api('/api/people/PE-1/confirm-identity', { actor: 'credential', body: { at: DAY }, expect: 201 });
  await api('/api/people/PE-3/confirm-identity', { actor: 'credential', body: { at: DAY }, expect: 201 });
  await api('/api/source-changes/TRAIN-REVIEW/execute', { body: {}, expect: 201 });
  info('TRAIN-2（PE-3 的 ice-safety）经 credential 办理 TRAIN-REVIEW：allow');
  await api('/api/training/TRAIN-1/review', { actor: 'credential', body: { decision: 'allow', at: DAY }, expect: 201 });

  const asg1 = (await api('/api/assignments', { actor: 'operations', body: { person: 'PE-1', dutyId: 'DUTY-1', role: 'equipment' } })).json;
  const asg3 = (await api('/api/assignments', { actor: 'operations', body: { person: 'PE-3', dutyId: 'DUTY-1', role: 'equipment' } })).json;
  const forbid = await api(`/api/assignments/${asg1.id}/approve`, { actor: 'delegation-a', body: {} });
  ok(forbid.status === 403 && forbid.json.code === 'delegation_cannot_approve', '代表团批准后台岗位被拒绝（不能自己批准自己的后台通行）');
  await api(`/api/assignments/${asg1.id}/approve`, { actor: 'operations', body: { at: DAY }, expect: 201 });
  await api(`/api/assignments/${asg3.id}/approve`, { actor: 'operations', body: { at: DAY }, expect: 201 });
  await api('/api/badges/issue', { actor: 'credential', body: { person: 'PE-1', at: DAY }, expect: 201 });
  await api('/api/badges/issue', { actor: 'credential', body: { person: 'PE-3', at: DAY }, expect: 201 });
  ok(true, 'PE-1、PE-3 已签发合成通行证（第 1 代）');

  section('第二幕：离线同步先发生，许可快照与额度明确下发');
  const syncA = (await api('/api/gates/GATE-A/sync', { body: { at: '2026-11-28T00:00:20Z', session: 'SS-1', quota: 2 }, expect: 201 })).json;
  ok(syncA.sync.quota === 2 && syncA.sync.permits.some(p => p.person === 'PE-1' && p.badgeGeneration === 1),
    `GATE-A 快照含 PE-1 第 1 代许可，明确离线额度 ${syncA.sync.quota}，有效至 ${syncA.sync.offlineUntil}`);
  const syncB = (await api('/api/gates/GATE-B/sync', { body: { at: '2026-11-28T00:00:25Z', session: 'SS-1', quota: 5 }, expect: 201 })).json;
  ok(syncB.sync.quota === 4, `容量 6、GATE-A 已预留 2 → GATE-B 只能拿到 ${syncB.sync.quota}，不是全部剩余 5`);

  section('第三幕：替班必须“接班人有资格且已到岗”，原岗不得先撤');
  const rep = (await api('/api/replacements', { actor: 'operations', body: { duty: 'DUTY-1', outgoing: 'PE-1', incoming: 'PE-3', at: '2026-11-28T00:00:30Z' }, expect: 201 })).json;
  ok(rep.status === 'awaiting_arrival' && rep.checks.qualified && !rep.checks.arrived, 'PE-3 资格齐备但尚未到岗 → 替班单 awaiting_arrival');
  const premature = await api(`/api/replacements/${rep.id}/complete`, { actor: 'operations', body: { at: '2026-11-28T00:00:35Z' } });
  ok(premature.status === 409 && premature.json.code === 'incoming_not_on_site', 'PE-3 未到岗时完成替班 → 409');
  const pe1Untouched = (await api('/api/assignments')).json.find(a => a.id === asg1.id);
  ok(pe1Untouched.active === true && pe1Untouched.endedAt === null, '原岗位 PE-1 仍然在岗负责，没有被提前撤掉');

  await api('/api/events', { body: { gate: 'GATE-B', sequence: 2, person: 'PE-3', badgeGeneration: 1, event: 'enter', at: '2026-11-28T00:00:40Z', receivedAt: '2026-11-28T00:00:44Z' }, expect: 201 });
  info('PE-3 00:00:40 从 GATE-B 入场，完成到岗');
  const done = await api(`/api/replacements/${rep.id}/complete`, { actor: 'zone-chief', body: { at: '2026-11-28T00:00:50Z' }, expect: 201 });
  ok(done.json.status === 'completed', '区域负责人确认后替班原子完成（出班岗位结束、接班岗位保持有效）');
  const staffing = (await api('/api/sessions/SS-1/staffing?at=2026-11-28T00:01:10Z')).json;
  ok(staffing.duties[0].presentCount === 1 && staffing.duties[0].present[0].person === 'PE-3' && staffing.allCorePostsMet,
    `场次岗位齐备：${staffing.summaryZh}`);

  section('第四幕：挂失换证后的撤销覆盖（在线立即生效，离线如实显示缺口）');
  const re = (await api('/api/badges/reissue', { actor: 'credential', body: { person: 'PE-1', reason: '挂失', at: '2026-11-28T00:00:45Z' }, expect: 201 })).json;
  ok(re.oldGenerationInvalid === 1 && re.newGeneration === 2, '挂失补发：PE-1 第 1 代失效、第 2 代生效；已在场事实不因换证消失');
  await api('/api/gates/GATE-A/mode', { actor: 'operations', body: { mode: 'offline' } });

  const coverage = (await api('/api/sync-coverage?at=2026-11-28T00:01:10Z')).json;
  const badgeRev = coverage.revocations.find(r => r.revocation.kind === 'badge');
  ok(badgeRev.offlineExposedGates.includes('GATE-A'), badgeRev.globalRevokedZh);
  const scanOld = await api('/api/gates/GATE-B/scan', { body: { sequence: 100, person: 'PE-1', badgeGeneration: 1, event: 'enter', at: '2026-11-28T00:01:15Z', receivedAt: '2026-11-28T00:01:16Z' } });
  ok(scanOld.status === 403 && scanOld.json.reasons.includes('badge_generation_invalid'), '在线 GATE-B 按最新撤销立即拒绝旧证');

  section('第五幕：离线迟到的旧入场记录，与新证在另一区域相遇');
  await api('/api/gates', { actor: 'operations', body: { id: 'GATE-C', zone: 'Z-MEDIA', mode: 'offline' }, expect: 201 });
  await api('/api/gates/GATE-C/sync', { body: { at: '2026-11-28T00:01:30Z', session: 'SS-1' }, expect: 201 });

  // 先收到“新证、新区”的入场。
  const newRecv = await api('/api/events', { body: {
    gate: 'GATE-C', sequence: 1, person: 'PE-1', badgeGeneration: 2, event: 'enter',
    at: '2026-11-28T00:02:00Z', receivedAt: '2026-11-28T00:02:08Z', offline: true,
  }, expect: 201 });
  ok(newRecv.json.allowed === true, '先收到 GATE-C（Z-MEDIA）第 2 代新证入场');

  // 较旧的 GATE-A 补传记录晚到，且时钟误差超过 30 秒容差。
  const lateBody = {
    gate: 'GATE-A', sequence: 1, localSerial: 'LOCAL-JOURNAL-0001', person: 'PE-1', badgeGeneration: 1, event: 'enter',
    at: '2026-11-28T00:01:00Z', receivedAt: '2026-11-28T00:03:30Z', offline: true,
  };
  const late = await api('/api/events', { body: lateBody });
  ok(late.status === 202 && late.json.code === 'clock_skew', '迟到记录时钟误差 150 秒 > 30 秒 → 先进入待核实，不直接计人');

  // 重复补传：gate+sequence 幂等，不重复计人。
  const dup = await api('/api/events', { body: lateBody });
  ok(dup.status === 200 && dup.json.duplicate === true, '相同 gate+sequence 重复记录不重复计人');

  const pending = (await api('/api/events?status=pending')).json;
  ok(pending.length === 1, `待核实队列 ${pending.length} 条（闸机序号 ${pending[0]?.sequence} / 代次 G${pending[0]?.badgeGeneration} / 本地流水 ${pending[0]?.localSerial}）`);
  await api(`/api/events/${late.json.event.id}/verify`, { actor: 'operations', body: { decision: 'confirm' }, expect: 201 });

  const disputes = (await api('/api/disputes')).json;
  const conflict = disputes.find(d => d.kind === 'location_conflict' && d.status === 'open');
  ok(!!conflict && conflict.zones.join(',') === 'Z-ICE,Z-MEDIA', `核实时钟后出现跨区位置争议：${conflict?.zones.join(' ↔ ')}（原始记录全部保留，结论不按接收顺序替换事实）`);

  const personView = (await api('/api/people/PE-1/status?at=2026-11-28T00:04:00Z')).json;
  info(personView.summaryZh);
  ok(personView.presence.presumed === true && personView.disputes.some(d => d.status === 'open'), '按人查询同时给出有效许可、推定到场与未决争议（许可 ≠ 到场）');

  // 现场人员核实：人实际在 Z-ICE；作废的只是投影，不是原始流水。
  const resolved = await api(`/api/disputes/${conflict.key}/resolve`, {
    actor: 'zone-chief', body: { decision: 'actual_location', actualZone: 'Z-ICE', note: '现场监控与负责人确认' }, expect: 201,
  });
  ok(resolved.json.projection.zone === 'Z-ICE', '现场核实实际位置为 Z-ICE，投影更正');
  const rawEvents = (await api('/api/events?person=PE-1')).json;
  ok(rawEvents.length === 3 && rawEvents.some(e => e.voided && e.zone === 'Z-MEDIA'), `原始事件 ${rawEvents.length} 条一条未删，冲突的 Z-MEDIA 记录标记为核实作废`);

  // 从错误区域出场不能扣 Z-ICE 的数（此时 Z-ICE 内是 PE-1 与仍在岗的 PE-3）。
  const occBefore = (await api('/api/zones/Z-ICE/occupancy')).json;
  await api('/api/events', { body: { gate: 'GATE-C', sequence: 2, person: 'PE-1', badgeGeneration: 2, event: 'exit', at: '2026-11-28T00:05:00Z', receivedAt: '2026-11-28T00:05:06Z' }, expect: 200 });
  let occ = (await api('/api/zones/Z-ICE/occupancy')).json;
  ok(occ.insideCount === occBefore.insideCount && occ.insideCount === 2, `从 Z-MEDIA 出场不反向扣 Z-ICE，Z-ICE 实际人数仍为 ${occ.insideCount}（PE-1、PE-3）`);
  await api('/api/events', { body: { gate: 'GATE-A', sequence: 2, person: 'PE-1', badgeGeneration: 2, event: 'exit', at: '2026-11-28T00:06:00Z', receivedAt: '2026-11-28T00:06:04Z' }, expect: 200 });
  occ = (await api('/api/zones/Z-ICE/occupancy')).json;
  ok(occ.insideCount === 1, `PE-1 从 GATE-A 正确出场后只剩仍在岗的 PE-3（${occ.insideCount} 人）`);

  section('第六幕：岗位撤销也要进入撤销覆盖；同步转发本地闸机协议');
  const revoke = await api(`/api/assignments/${asg3.id}/revoke`, { actor: 'operations', body: { reason: '岗位调整', at: '2026-11-28T00:07:00Z' }, expect: 201 });
  ok(!!revoke.json.revocation && revoke.json.revocation.kind === 'access', '岗位撤销生成 access 类撤销版本');
  const fwd = await api('/api/gates/GATE-A/sync?forward=partner', { body: { at: '2026-11-28T00:08:00Z', quota: 1 }, expect: 201 });
  ok(fwd.json.sync.partner?.results?.[0]?.httpStatus === 202, `同步批次按合作方协议投递并被受理（Sync-Nonce=${fwd.json.sync.partner.results[0].nonce}）`);
  let matrix = (await api('/api/sync-coverage?at=2026-11-28T00:08:01Z')).json;
  ok(matrix.gates.some(g => g.snapshots[0]?.covered === false), '未重新同步的闸机如实显示撤销缺口，不声称已全场撤销');
  await api('/api/gates/GATE-B/sync', { body: { at: '2026-11-28T00:08:20Z' }, expect: 201 });
  await api('/api/gates/GATE-C/sync', { body: { at: '2026-11-28T00:08:25Z' }, expect: 201 });
  matrix = (await api('/api/sync-coverage?at=2026-11-28T00:08:30Z')).json;
  ok(matrix.gates.every(g => g.snapshots[0]?.covered === true), '逐台同步到最新撤销版本后，全部闸机显示 covered');

  section('现场三视图：按人 / 按场次 / 按闸机');
  const staffingFinal = (await api('/api/sessions/SS-1/staffing?at=2026-11-28T00:09:00Z')).json;
  info(staffingFinal.summaryZh);
  const occFinal = (await api('/api/zones/Z-ICE/occupancy?at=2026-11-28T00:09:00Z')).json;
  info(occFinal.summaryZh);
  const gateView = (await api('/api/gates/GATE-A/sync?at=2026-11-28T00:09:00Z')).json;
  info(gateView.summaryZh);
  ok(true, '交互式中文核对台：npm start 后打开 /ui');
} catch (error) {
  failures += 1;
  console.error('核对剧本执行异常：', error);
} finally {
  await closeServer(server);
  await closeServer(partner);
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '✅ 本地核对全部通过：换证、替班、离线迟到相遇、额度与撤销覆盖均符合规则。' : `❌ 有 ${failures} 项核对未通过。`}`);
process.exitCode = failures === 0 ? 0 : 1;
