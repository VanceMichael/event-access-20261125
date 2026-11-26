import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';
import { createCore } from '../core.mjs';
import { createPeer } from '../support/peer.mjs';
import { readFile } from 'node:fs/promises';

const fixtures = JSON.parse(await readFile(new URL('../fixtures/records.json', import.meta.url)));
const partnerConfig = JSON.parse(await readFile(new URL('../fixtures/partner.json', import.meta.url)));

const DAY = '2026-11-27T10:00:00Z';
const SYNC_AT = '2026-11-28T00:00:30Z';
const T1 = '2026-11-28T00:01:00Z';
const T2 = '2026-11-28T00:02:00Z';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const closeServer = server => new Promise(resolve => server.close(resolve));

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'event-access-'));
  const stateFile = join(dir, 'app.json');
  const server = createServer({ stateFile, fixtures });
  const base = await listen(server);
  async function api(path, options = {}) {
    const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET');
    const headers = { 'Content-Type': 'application/json' };
    if (options.actor) headers['X-Actor'] = options.actor;
    const res = await fetch(base + path, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json };
  }
  async function worker(person, n = 1) {
    // 完整的“身份确认 + 培训核准 + 岗位核准 + 发证”链条。
    await api(`/people/${person}/confirm-identity`, { actor: 'credential', body: { at: DAY } });
    const tr = await api('/training', { actor: 'credential', body: { person, kind: 'ice-safety', until: '2026-12-01' } });
    await api(`/training/${tr.json.id}/review`, { actor: 'credential', body: { decision: 'allow', at: DAY } });
    const asg = await api('/assignments', { actor: 'operations', body: { person, dutyId: 'DUTY-1', role: 'equipment' } });
    await api(`/assignments/${asg.json.id}/approve`, { actor: 'operations', body: { at: DAY } });
    await api('/badges/issue', { actor: 'credential', body: { person, at: DAY } });
    return asg.json.id;
  }
  return {
    dir, server, base, api, worker,
    async cleanup() { await closeServer(server); await rm(dir, { recursive: true, force: true }); },
  };
}

test('同名身份不合并；申报、身份确认与代表团范围受限', async () => {
  const h = await harness();
  try {
    assert.equal((await h.api('/health')).status, 200);
    const people = (await h.api('/people')).json;
    const sameName = people.filter(p => p.name === '沈安');
    assert.equal(sameName.length, 2);
    assert.notEqual(sameName[0].id, sameName[1].id);

    // 新建第三个“沈安”，仍然是独立身份。
    const created = await h.api('/declarations', {
      body: { category: 'media', person: { name: '沈安', delegation: 'DG-B' } },
    });
    assert.equal(created.status, 201);
    const newId = created.json.person.id;
    assert.ok(!['PE-1', 'PE-2'].includes(newId));
    assert.equal((await h.api('/people')).json.filter(p => p.name === '沈安').length, 3);

    // 代表团角色不能申报其他团。
    const cross = await h.api('/declarations', {
      actor: 'delegation-a',
      body: { category: 'delegation', personId: 'PE-2', delegation: 'DG-B' },
    });
    assert.equal(cross.status, 403);

    // 未提供操作人 → 401；代表团不能确认身份；证件中心可以。
    assert.equal((await h.api('/people/PE-1/confirm-identity', { body: {} })).status, 401);
    const del = await h.api('/people/PE-1/confirm-identity', { actor: 'delegation-a', body: {} });
    assert.equal(del.status, 403);
    const ok = await h.api('/people/PE-1/confirm-identity', { actor: 'credential', body: { at: DAY } });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.person.identityStatus, 'confirmed');
  } finally { await h.cleanup(); }
});

test('媒体身份不能代替冰区培训；代表团不能批准后台岗位；资格与岗位独立', async () => {
  const h = await harness();
  try {
    await h.api('/people/PE-1/confirm-identity', { actor: 'credential', body: { at: DAY } });
    // 媒体申请获批，只构成媒体类身份。
    const app = await h.api('/declarations', { body: { category: 'media', personId: 'PE-1' } });
    await h.api(`/applications/${app.json.application.id}/decision`, { actor: 'credential', body: { decision: 'approve', at: DAY } });

    let eval0 = (await h.api('/access/evaluate', {
      body: { person: 'PE-1', gate: 'GATE-A', badgeGeneration: 1, at: T1 },
    })).json;
    assert.equal(eval0.allowed, false);
    assert.ok(eval0.reasons.includes('no_badge'));
    assert.ok(eval0.reasons.includes('training_missing'));
    assert.ok(eval0.reasons.some(r => r === 'assignment_missing' || r === 'access_grant_missing'));

    // 仅核准培训：仍然没有岗位。
    await h.api('/training/TRAIN-1/review', { actor: 'credential', body: { decision: 'allow', at: DAY } });
    let eval1 = (await h.api('/access/evaluate', {
      body: { person: 'PE-1', gate: 'GATE-A', badgeGeneration: 1, at: T1 },
    })).json;
    assert.ok(eval1.reasons.includes('assignment_missing'));
    assert.equal(eval1.checks.trainingCurrent, true);

    // 岗位指派后，代表团批准必须被拒绝。
    const asg = await h.api('/assignments', { actor: 'operations', body: { person: 'PE-1', dutyId: 'DUTY-1', role: 'equipment' } });
    const delApprove = await h.api(`/assignments/${asg.json.id}/approve`, { actor: 'delegation-a', body: {} });
    assert.equal(delApprove.status, 403);
    assert.equal(delApprove.json.code, 'delegation_cannot_approve');

    await h.api(`/assignments/${asg.json.id}/approve`, { actor: 'operations', body: { at: DAY } });
    await h.api('/badges/issue', { actor: 'credential', body: { person: 'PE-1', at: DAY } });
    const eval2 = (await h.api('/access/evaluate', {
      body: { person: 'PE-1', gate: 'GATE-A', badgeGeneration: 1, at: T1 },
    })).json;
    assert.equal(eval2.allowed, true, JSON.stringify(eval2.reasons));

    // 同名的 PE-2 没有任何链条，不能通行——证明姓名相同不会合并资格。
    const evalPe2 = (await h.api('/access/evaluate', {
      body: { person: 'PE-2', gate: 'GATE-A', badgeGeneration: 1, at: T1 },
    })).json;
    assert.equal(evalPe2.allowed, false);
    assert.ok(evalPe2.reasons.includes('identity_unconfirmed'));
  } finally { await h.cleanup(); }
});

test('换证后旧证被在线拒绝，但已在场事实不消失；出场再进按新代次', async () => {
  const h = await harness();
  try {
    await h.worker('PE-1');
    const enter = await h.api('/events', { body: { gate: 'GATE-A', sequence: 1, person: 'PE-1', badgeGeneration: 1, event: 'enter', at: T1, receivedAt: '2026-11-28T00:01:05Z' } });
    assert.equal(enter.json.allowed, true);
    assert.equal((await h.api('/zones/Z-ICE/occupancy')).json.insideCount, 1);

    // 人在场内时挂失换证。
    const re = await h.api('/badges/reissue', { actor: 'credential', body: { person: 'PE-1', reason: '挂失', at: '2026-11-28T00:05:00Z' } });
    assert.equal(re.json.oldGenerationInvalid, 1);
    assert.equal(re.json.newGeneration, 2);
    // 在场事实不变。
    assert.equal((await h.api('/zones/Z-ICE/occupancy')).json.insideCount, 1);

    // 旧证在线扫描 → 403。
    const scanOld = await h.api('/gates/GATE-B/scan', { actor: 'gate', body: { sequence: 2, person: 'PE-1', badgeGeneration: 1, event: 'enter', at: '2026-11-28T00:06:00Z', receivedAt: '2026-11-28T00:06:02Z' } });
    assert.equal(scanOld.status, 403);
    assert.ok(scanOld.json.reasons.includes('badge_generation_invalid'));
    assert.equal((await h.api('/zones/Z-ICE/occupancy')).json.insideCount, 1);

    // 重复入场（未出场）即使新证也拒绝并提示 already_in_zone。
    const reEnter = await h.api('/events', { body: { gate: 'GATE-B', sequence: 3, person: 'PE-1', badgeGeneration: 2, event: 'enter', at: '2026-11-28T00:06:30Z', receivedAt: '2026-11-28T00:06:32Z' } });
    assert.equal(reEnter.json.allowed, false);
    assert.ok(reEnter.json.reasons.includes('already_in_zone'));

    // 正常出场后，新代次可以再进；总数保持 1。
    await h.api('/events', { body: { gate: 'GATE-A', sequence: 4, person: 'PE-1', badgeGeneration: 2, event: 'exit', at: '2026-11-28T00:07:00Z', receivedAt: '2026-11-28T00:07:02Z' } });
    assert.equal((await h.api('/zones/Z-ICE/occupancy')).json.insideCount, 0);
    const enterNew = await h.api('/events', { body: { gate: 'GATE-B', sequence: 5, person: 'PE-1', badgeGeneration: 2, event: 'enter', at: '2026-11-28T00:08:00Z', receivedAt: '2026-11-28T00:08:02Z' } });
    assert.equal(enterNew.json.allowed, true, JSON.stringify(enterNew.json.reasons));
    assert.equal((await h.api('/zones/Z-ICE/occupancy')).json.insideCount, 1);

    const status = (await h.api('/people/PE-1/status?at=2026-11-28T00:09:00Z')).json;
    assert.equal(status.presence.inside, true);
    assert.equal(status.badge.currentGeneration, 2);
    assert.match(status.summaryZh, /实际到场：Z-ICE/);
  } finally { await h.cleanup(); }
});

test('替班：接班人未核准/未到岗不能完成，原岗位不受影响；到岗后原子交接并满足最低在岗', async () => {
  const h = await harness();
  try {
    const asg1 = await h.worker('PE-1');
    // PE-3 有培训原始记录 TRAIN-2，但尚未核准；先确认身份并建立岗位。
    await h.api('/people/PE-3/confirm-identity', { actor: 'credential', body: { at: DAY } });
    await h.api('/training/TRAIN-2/review', { actor: 'credential', body: { decision: 'allow', at: DAY } });
    const asg3 = await h.api('/assignments', { actor: 'operations', body: { person: 'PE-3', dutyId: 'DUTY-1', role: 'equipment' } });
    await h.api(`/assignments/${asg3.json.id}/approve`, { actor: 'operations', body: { at: DAY } });
    await h.api('/badges/issue', { actor: 'credential', body: { person: 'PE-3', at: DAY } });

    // PE-1 已在岗。
    await h.api('/events', { body: { gate: 'GATE-A', sequence: 1, person: 'PE-1', badgeGeneration: 1, event: 'enter', at: T1, receivedAt: '2026-11-28T00:01:05Z' } });

    // 先让培训失效一次？不——资格已齐，但 PE-3 未到岗：建单 awaiting_arrival。
    const rep = await h.api('/replacements', { actor: 'operations', body: { duty: 'DUTY-1', outgoing: 'PE-1', incoming: 'PE-3', at: '2026-11-28T00:03:00Z' } });
    assert.equal(rep.json.status, 'awaiting_arrival');
    assert.equal(rep.json.checks.qualified, true);
    assert.equal(rep.json.checks.arrived, false);

    // 强行完成 → 409，且 PE-1 岗位仍 active。
    const fail = await h.api(`/replacements/${rep.json.id}/complete`, { actor: 'operations', body: { at: '2026-11-28T00:03:30Z' } });
    assert.equal(fail.status, 409);
    assert.equal(fail.json.code, 'incoming_not_on_site');
    const pe1Still = (await h.api('/assignments')).json.find(a => a.id === asg1);
    assert.equal(pe1Still.active, true);
    assert.equal(pe1Still.endedAt, null);

    // 场次岗位视图在 PE-3 到岗前只认 PE-1。
    const staffingBefore = (await h.api('/sessions/SS-1/staffing?at=2026-11-28T00:03:30Z')).json;
    assert.equal(staffingBefore.duties[0].presentCount, 1);
    assert.equal(staffingBefore.allCorePostsMet, true); // PE-1 仍在岗，最低人数满足

    // PE-3 入场到岗。
    const arrive = await h.api('/events', { body: { gate: 'GATE-B', sequence: 2, person: 'PE-3', badgeGeneration: 1, event: 'enter', at: '2026-11-28T00:04:00Z', receivedAt: '2026-11-28T00:04:05Z' } });
    assert.equal(arrive.json.allowed, true, JSON.stringify(arrive.json.reasons));

    const ok = await h.api(`/replacements/${rep.json.id}/complete`, { actor: 'zone-chief', body: { at: '2026-11-28T00:05:00Z' } });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.status, 'completed');

    const after = (await h.api('/assignments')).json;
    const out = after.find(a => a.id === asg1);
    assert.equal(out.active, false);
    assert.match(out.endReason, /REP-/);
    const incoming = after.find(a => a.id === asg3.json.id);
    assert.equal(incoming.active, true);

    // 00:05 之后：PE-1 岗位已结束，PE-3 在岗 → 仍满足最低 1 人。
    const staffingAfter = (await h.api('/sessions/SS-1/staffing?at=2026-11-28T00:06:00Z')).json;
    assert.equal(staffingAfter.duties[0].presentCount, 1);
    assert.deepEqual(staffingAfter.duties[0].present.map(p => p.person), ['PE-3']);
    assert.equal(staffingAfter.releaseAllowed, true);

    const release = await h.api('/sessions/SS-1/release', { actor: 'operations', body: { at: '2026-11-28T00:06:30Z' } });
    assert.equal(release.status, 201);
    assert.ok(release.json.releasedAt);
  } finally { await h.cleanup(); }
});

test('核心岗位缺人时不能放行下一场', async () => {
  const h = await harness();
  try {
    await h.worker('PE-3'); // 唯一合格人员，但不到场
    const staffing = (await h.api('/sessions/SS-1/staffing?at=2026-11-28T00:10:00Z')).json;
    assert.equal(staffing.duties[0].presentCount, 0);
    assert.equal(staffing.allCorePostsMet, false);
    const release = await h.api('/sessions/SS-1/release', { actor: 'operations', body: { at: '2026-11-28T00:10:00Z' } });
    assert.equal(release.status, 409);
    assert.equal(release.json.code, 'core_posts_short');
  } finally { await h.cleanup(); }
});

test('多闸机额度分配不共享全部剩余；离线超额度记录保留并暴露超员/离场名单', async () => {
  const h = await harness();
  try {
    const ids = [];
    for (let i = 0; i < 7; i += 1) {
      const id = `PE-Q${i}`;
      await h.api('/people', { actor: 'operations', body: { id, name: `额度测试${i}`, delegation: 'DG-A' } });
      await h.worker(id);
      ids.push(id);
    }
    const a = await h.api('/gates/GATE-A/sync', { body: { at: SYNC_AT, session: 'SS-1', quota: 6 } });
    assert.equal(a.json.sync.quota, 6);
    assert.equal(a.json.sync.permits.length, 7);
    // 第二台闸机看到 GATE-A 已预留 6 个未用额度，可分配为 0，而不是容量 6。
    const b = await h.api('/gates/GATE-B/sync', { body: { at: SYNC_AT, session: 'SS-1', quota: 6 } });
    assert.equal(b.json.sync.quota, 0);
    assert.match(b.json.quotaNoteZh, /可分配 0/);

    // GATE-A 离线实际产生 7 条入场（闸机超出自己额度 1 人）。
    const times = [
      '2026-11-28T00:01:00Z', '2026-11-28T00:01:10Z', '2026-11-28T00:01:20Z',
      '2026-11-28T00:01:30Z', '2026-11-28T00:01:40Z', '2026-11-28T00:01:50Z',
      '2026-11-28T00:02:00Z',
    ];
    for (let i = 0; i < 7; i += 1) {
      const at = times[i];
      const ev = await h.api('/events', {
        body: { gate: 'GATE-A', sequence: i + 1, person: ids[i], badgeGeneration: 1, event: 'enter', at, receivedAt: at, offline: true },
      });
      assert.equal(ev.json.allowed, true, JSON.stringify(ev.json));
      if (i === 6) assert.ok(ev.json.event.flags.includes('over_quota'));
    }
    const occ = (await h.api('/zones/Z-ICE/occupancy')).json;
    assert.equal(occ.insideCount, 7); // 补账不能把已发生的人“补”没
    assert.equal(occ.capacityExceeded, true);
    assert.equal(occ.overCapacityBy, 1);
    assert.ok(occ.mustLeave.some(p => p.reasons.includes('capacity_full')));
    const cov = (await h.api('/gates/GATE-A/sync')).json;
    assert.equal(cov.snapshots[0].quota.used, 7);
  } finally { await h.cleanup(); }
});

test('撤销覆盖：在线立即拒绝；离线闸机明确显示未同步与风险时限，重新同步后覆盖', async () => {
  const h = await harness();
  try {
    await h.worker('PE-1');
    await h.api('/gates/GATE-A/mode', { actor: 'operations', body: { mode: 'offline' } });
    const sync = await h.api('/gates/GATE-A/sync', { body: { at: SYNC_AT, quota: 2 } });
    assert.equal(sync.json.sync.revVersionAtSync, 0);

    await h.api('/badges/reissue', { actor: 'credential', body: { person: 'PE-1', reason: '挂失', at: '2026-11-28T00:01:00Z' } });

    const covSoon = (await h.api('/gates/GATE-A/sync?at=2026-11-28T00:01:20Z')).json;
    assert.equal(covSoon.snapshots[0].covered, false);
    assert.equal(covSoon.snapshots[0].mayStillHonorOldPermit, true);
    assert.equal(covSoon.snapshots[0].windowActive, true);
    assert.match(covSoon.summaryZh, /仍可能按旧许可放行/);

    const matrix = (await h.api('/sync-coverage?at=2026-11-28T00:01:20Z')).json;
    const row = matrix.revocations.find(r => r.revocation.kind === 'badge');
    assert.ok(row.unSyncedGates.includes('GATE-A'));
    assert.ok(row.offlineExposedGates.includes('GATE-A'));
    assert.match(row.globalRevokedZh, /不能声称已全场撤销/);

    // 超过 120 秒离线窗：不再可能放行。
    const covLate = (await h.api('/gates/GATE-A/sync?at=2026-11-28T00:03:00Z')).json;
    assert.equal(covLate.snapshots[0].windowActive, false);
    assert.equal(covLate.snapshots[0].mayStillHonorOldPermit, false);

    // 在线 GATE-B 不受离线传播限制，中央立即拒绝旧证。
    const scan = await h.api('/gates/GATE-B/scan', { body: { sequence: 1, person: 'PE-1', badgeGeneration: 1, event: 'enter', at: '2026-11-28T00:01:30Z', receivedAt: '2026-11-28T00:01:31Z' } });
    assert.equal(scan.status, 403);

    // 闸机重新同步后覆盖撤销。
    await h.api('/gates/GATE-A/sync', { body: { at: '2026-11-28T00:02:10Z', quota: 2 } });
    const covNew = (await h.api('/gates/GATE-A/sync?at=2026-11-28T00:02:11Z')).json;
    assert.equal(covNew.snapshots[0].covered, true);
  } finally { await h.cleanup(); }
});

test('事件幂等、时钟误差待核实、核实后入账；拒绝的事件不计人', async () => {
  const h = await harness();
  try {
    await h.worker('PE-1');
    const body = { gate: 'GATE-A', sequence: 7, person: 'PE-1', badgeGeneration: 1, event: 'enter', at: '2026-11-28T00:10:00Z', receivedAt: '2026-11-28T01:00:00Z' };
    const first = await h.api('/events', { body });
    assert.equal(first.status, 202);
    assert.equal(first.json.pending, true);
    assert.equal(first.json.code, 'clock_skew');

    const again = await h.api('/events', { body });
    assert.equal(again.status, 200);
    assert.equal(again.json.duplicate, true);
    assert.equal(again.json.event.id, first.json.event.id);
    assert.equal((await h.api('/zones/Z-ICE/occupancy')).json.insideCount, 0);

    const conflict = await h.api('/events', { body: { ...body, badgeGeneration: 2 } });
    assert.equal(conflict.status, 409);

    await h.api(`/events/${first.json.event.id}/verify`, { actor: 'operations', body: { decision: 'confirm' } });
    assert.equal((await h.api('/zones/Z-ICE/occupancy')).json.insideCount, 1);

    // 另一条时钟异常被核实拒绝。
    const bad = await h.api('/events', { body: { gate: 'GATE-B', sequence: 8, person: 'PE-3', badgeGeneration: 1, event: 'enter', at: '2026-11-28T00:11:00Z', receivedAt: '2026-11-29T00:00:00Z' } });
    assert.equal(bad.json.pending, true);
    await h.api(`/events/${bad.json.event.id}/verify`, { actor: 'operations', body: { decision: 'reject' } });
    assert.equal((await h.api('/zones/Z-ICE/occupancy')).json.insideCount, 1);
  } finally { await h.cleanup(); }
});

test('离线迟到入场与新证跨区记录相遇：原始记录保留、接收顺序不改变争议结论、核实后定位', () => {
  function world(reverseOrder) {
    const core = createCore({ fixtures });
    core.confirmIdentity('PE-1', { actorId: 'credential', at: DAY });
    core.reviewTraining('TRAIN-1', { actorId: 'credential', decision: 'allow', at: DAY });
    const asg = core.createAssignment({ actorId: 'operations', person: 'PE-1', dutyId: 'DUTY-1', role: 'equipment' });
    core.approveAssignment(asg.id, { actorId: 'operations', at: DAY });
    const app = core.createDeclaration({ actorId: 'operations', category: 'media', personId: 'PE-1' });
    core.decideApplication(app.application.id, { actorId: 'credential', decision: 'approve', at: DAY });
    core.issueBadge({ actorId: 'credential', person: 'PE-1', at: DAY });
    core.reissueBadge({ actorId: 'credential', person: 'PE-1', reason: '挂失', at: '2026-11-28T00:00:45Z' });
    core.createGate({ actorId: 'operations', id: 'GATE-C', zone: 'Z-MEDIA' });
    core.gateSync('GATE-A', { at: SYNC_AT });
    // GATE-C 在换证后同步，快照内是新代次；新记录同样作为离线补传事实处理。
    core.gateSync('GATE-C', { at: '2026-11-28T00:01:30Z' });

    const oldEvent = { gate: 'GATE-A', sequence: 1, person: 'PE-1', badgeGeneration: 1, type: 'enter', at: T1, receivedAt: '2026-11-28T00:01:20Z', offline: true };
    const newEvent = { gate: 'GATE-C', sequence: 1, person: 'PE-1', badgeGeneration: 2, type: 'enter', at: T2, receivedAt: '2026-11-28T00:02:10Z', offline: true };
    if (reverseOrder) { core.ingestEvent(oldEvent); core.ingestEvent(newEvent); }
    else { core.ingestEvent(newEvent); core.ingestEvent(oldEvent); }
    return core;
  }

  for (const reverse of [false, true]) {
    const core = world(reverse);
    const disputes = core.openDisputes();
    assert.equal(disputes.length, 1);
    assert.equal(disputes[0].kind, 'location_conflict');
    assert.deepEqual(disputes[0].zones, ['Z-ICE', 'Z-MEDIA']);
    const stay = core.currentProjection().stays['PE-1'];
    assert.equal(stay.zone, 'Z-MEDIA'); // 按事件时间更晚者推定，而非接收顺序
    assert.equal(stay.presumed, true);
  }

  // 在其中一个世界完成核实与出场核对。
  const core = world(false);
  const key = core.openDisputes()[0].key;
  const resolved = core.resolveDispute(key, { actorId: 'zone-chief', decision: 'actual_location', actualZone: 'Z-ICE' });
  assert.equal(resolved.projection.zone, 'Z-ICE');
  assert.ok(core.listDisputes().some(d => d.key === key && d.status === 'resolved'), '已解决争议保留为 resolved 档案');
  const allEvents = core.state.events;
  assert.equal(allEvents.length, 2); // 原始记录一条不少
  assert.ok(allEvents.some(e => e.voided === true && e.zone === 'Z-MEDIA'));

  // 从错误区域出场不能扣减 Z-ICE。
  core.ingestEvent({ gate: 'GATE-C', sequence: 2, person: 'PE-1', badgeGeneration: 2, type: 'exit', at: '2026-11-28T00:04:00Z', receivedAt: '2026-11-28T00:04:05Z' });
  let occIce = core.zoneOccupancy('Z-ICE');
  assert.equal(occIce.insideCount, 1);
  assert.ok(core.openDisputes().some(d => d.kind === 'exit_zone_mismatch'));

  // 正确区域出场后清零。
  core.ingestEvent({ gate: 'GATE-A', sequence: 2, person: 'PE-1', badgeGeneration: 2, type: 'exit', at: '2026-11-28T00:05:00Z', receivedAt: '2026-11-28T00:05:05Z' });
  occIce = core.zoneOccupancy('Z-ICE');
  assert.equal(occIce.insideCount, 0);
});

test('sourceChanges 是待办原料：可显式办理培训核准与事件入库，但不会自动生效', async () => {
  const h = await harness();
  try {
    const before = (await h.api('/training')).json.find(t => t.id === 'TRAIN-2');
    assert.equal(before.reviewStatus, 'pending');

    const tr = await h.api('/source-changes/TRAIN-REVIEW/execute', { body: {} });
    assert.equal(tr.status, 201);
    assert.equal(tr.json.result.reviewStatus, 'approved');
    const sc = (await h.api('/source-changes')).json.find(c => c.id === 'TRAIN-REVIEW');
    assert.equal(sc.processed, true);

    // 原始资料仍在，且重复办理被拒绝（除非 force）。
    const again = await h.api('/source-changes/TRAIN-REVIEW/execute', { body: {} });
    assert.equal(again.status, 409);

    const gate = await h.api('/source-changes/GATE-NEW/execute', {
      body: { receivedAt: '2026-11-28T00:02:05Z' },
    });
    // PE-1 尚未发证/确认，业务结论可以是 denied/pending，但资料已被接收办理。
    assert.ok(gate.json.result);
    assert.equal((await h.api('/events')).json.length, 1);
  } finally { await h.cleanup(); }
});

test('并发在线扫描：容量检查+入账原子，十名合格者恰好放行容量 6 人', async () => {
  const h = await harness();
  try {
    const ids = [];
    for (let i = 0; i < 10; i += 1) {
      const id = `PE-R${i}`;
      await h.api('/people', { actor: 'operations', body: { id, name: `并发${i}`, delegation: 'DG-A' } });
      await h.worker(id);
      ids.push(id);
    }
    const results = await Promise.all(ids.map((person, i) => {
      const gate = i % 2 === 0 ? 'GATE-A' : 'GATE-B';
      const sequence = Math.floor(i / 2) + 1;
      return h.api(`/gates/${gate}/scan`, {
        body: { sequence, person, badgeGeneration: 1, event: 'enter', at: T1, receivedAt: '2026-11-28T00:01:05Z' },
      });
    }));
    const allowed = results.filter(r => r.status === 200);
    const denied = results.filter(r => r.status === 403);
    assert.equal(allowed.length, 6, `allowed=${allowed.length} denied=${denied.length}`);
    assert.equal(denied.length, 4);
    assert.ok(denied.every(r => r.json.reasons.includes('capacity_full')));
    const occ = (await h.api('/zones/Z-ICE/occupancy')).json;
    assert.equal(occ.insideCount, 6);
    assert.equal(occ.capacityExceeded, false);
  } finally { await h.cleanup(); }
});

test('同步后的离线闸机按最新撤销拒绝旧证；超过离线窗也拒绝；值勤资格查询可用', async () => {
  const h = await harness();
  try {
    await h.worker('PE-1');
    const duty = (await h.api('/api/duty?person=PE-1&date=2026-11-28')).json;
    assert.equal(duty.canDuty, true);
    const duty2 = (await h.api('/people/PE-2/duty?date=2026-11-28')).json;
    assert.equal(duty2.canDuty, false);
    assert.ok(duty2.summaryZh.includes('身份'));

    await h.api('/gates/GATE-A/mode', { actor: 'operations', body: { mode: 'offline' } });
    await h.api('/gates/GATE-A/sync', { body: { at: SYNC_AT, quota: 2 } });
    await h.api('/badges/reissue', { actor: 'credential', body: { person: 'PE-1', at: '2026-11-28T00:01:00Z' } });
    await h.api('/gates/GATE-A/sync', { body: { at: '2026-11-28T00:01:30Z', quota: 2 } });

    // 新快照已含撤销：旧代次在“同步后的离线闸机”也必须被拒绝，而不是待核实/放行。
    const oldGen = await h.api('/events', { body: {
      gate: 'GATE-A', sequence: 5, offline: true, person: 'PE-1', badgeGeneration: 1, event: 'enter',
      at: '2026-11-28T00:01:40Z', receivedAt: '2026-11-28T00:01:42Z',
    } });
    assert.equal(oldGen.json.allowed, false);
    assert.equal(oldGen.json.event.status, 'denied');
    assert.ok(oldGen.json.reasons.includes('badge_generation_invalid'));

    // 超过最后同步 + 120s 窗口：闸机应停止放行，记录被拒且不计人。
    const expired = await h.api('/events', { body: {
      gate: 'GATE-A', sequence: 6, offline: true, person: 'PE-1', badgeGeneration: 2, event: 'enter',
      at: '2026-11-28T00:04:00Z', receivedAt: '2026-11-28T00:04:05Z',
    } });
    assert.equal(expired.json.allowed, false);
    assert.ok(expired.json.reasons.includes('offline_window_expired'));
    assert.equal((await h.api('/zones/Z-ICE/occupancy')).json.insideCount, 0);
  } finally { await h.cleanup(); }
});

test('状态持久化：重启后决定、流水与自增序号都保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persist-'));
  const stateFile = join(dir, 'app.json');
  try {
    let server = createServer({ stateFile, fixtures });
    let base = await listen(server);
    const post = (p, b, a) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(a ? { 'X-Actor': a } : {}) }, body: JSON.stringify(b) }).then(r => r.json());
    await post('/people/PE-1/confirm-identity', { at: DAY }, 'credential');
    await new Promise(r => server.close(r));

    server = createServer({ stateFile, fixtures });
    base = await listen(server);
    const get = async p => (await fetch(base + p)).json();
    assert.equal((await get('/people/PE-1')).identityStatus, 'confirmed');
    // 自增序号已跳过夹具编号，新建人员不会再得到 PE-1。
    const created = await fetch(base + '/people', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Actor': 'operations' }, body: JSON.stringify({ name: '测试新增' }) }).then(r => r.json());
    assert.notEqual(created.id, 'PE-1');
    await new Promise(r => server.close(r));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('门禁同步可转发到本地合作方协议并保留受理流水', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'partner-int-'));
  const partnerState = join(dir, 'partner.json');
  const partner = createPeer(partnerConfig, partnerState);
  const pbase = await listen(partner);
  const h = await harness();
  // harness 未配置 partnerUrl，因此另起一个配置了 partnerUrl 的业务服务。
  const dir2 = await mkdtemp(join(tmpdir(), 'biz-int-'));
  const stateFile = join(dir2, 'app.json');
  const server2 = createServer({ stateFile, fixtures, partnerUrl: pbase });
  const base2 = await listen(server2);
  try {
    const res = await fetch(base2 + '/api/gates/GATE-A/sync?forward=partner', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at: SYNC_AT, quota: 1 }),
    });
    const json = await res.json();
    assert.equal(res.status, 201);
    assert.equal(json.sync.partner.results[0].httpStatus, 202);
    const nonce = json.sync.partner.results[0].nonce;
    const stateResp = await fetch(pbase + '/control/state');
    const stateJson = await stateResp.json();
    assert.ok(stateJson.batches[nonce]);
  } finally {
    await closeServer(server2); await closeServer(partner);
    await h.cleanup();
    await rm(dir, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  }
});
