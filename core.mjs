// 赛事工作证业务核心：申报、身份确认、资格/岗位核准、替班、发证补证、
// 按场次区域许可、容量额度、闸机同步覆盖、事件流水与在场投影。
// 本模块不依赖第三方包，所有状态可持久化为单个 JSON 文件。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FIXTURES = fileURLToPath(new URL('./fixtures/records.json', import.meta.url));

export class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const REASON_ZH = {
  person_unknown: '人员不存在',
  identity_unconfirmed: '身份尚未经有权人员确认（同名不合并）',
  no_badge: '尚未签发通行证',
  badge_generation_invalid: '出示的证件代次已失效（补发新证后旧证无效）',
  training_missing: '缺少该区域要求且经核准、在有效期内的培训',
  assignment_missing: '没有经核准且在此时有效的对应岗位',
  access_grant_missing: '没有有效的区域通行依据',
  outside_session: '不在该场次时段（含入场预备窗）内',
  already_in_zone: '已有该区域的在场记录，不能重复计人',
  location_conflict: '与另一区域的未出场记录冲突，位置待核实',
  capacity_full: '区域容量已满',
  offline_snapshot_missing: '离线闸机缺少最后同步的许可快照',
  offline_window_expired: '已超过离线许可短期有效窗，闸机应停止放行',
  offline_permit_absent: '最后同步的许可快照中没有该人员/证件代次',
  offline_quota_exceeded: '超出同步时明确分配的离线可用额度',
  clock_skew: '事件时间与接收时钟误差超过协议容差，进入待核实',
  not_qualified: '接班人资格或岗位核准不满足要求',
  incoming_not_on_site: '接班人尚未完成到岗（无有效入场记录）',
  delegation_cannot_approve: '代表团不能批准本团或任何后台/敏感区域通行',
};

const clone = value => JSON.parse(JSON.stringify(value));

function parseTime(value, field = '时间') {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'bad_time', `${field}格式无效：${value}`);
  return d;
}
const ms = value => (value ? new Date(value).getTime() : null);
const iso = d => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const dayKey = value => iso(value).slice(0, 10);

function seedState(fixtures) {
  const fx = clone(fixtures);
  return {
    schema: 1,
    createdAt: new Date().toISOString(),
    protocol: fx.protocol ?? { offlineWindowSeconds: 120, clockToleranceSeconds: 30 },
    // 默认严格按场次时段判定；如现场需要入场预备窗，可在资料/状态中设置 entryLeadSeconds。
    entryLeadSeconds: fx.entryLeadSeconds ?? 0,
    actors: fx.actors ?? [],
    delegations: fx.delegations ?? [],
    people: (fx.people ?? []).map(p => ({
      identityStatus: 'unconfirmed',
      confirmedAt: null,
      confirmedBy: null,
      ...p,
    })),
    zones: (fx.zones ?? []).map(z => ({
      allowedCategories: z.training === null ? ['media'] : [],
      ...z,
    })),
    sessions: fx.sessions ?? [],
    duties: fx.duties ?? [],
    gates: (fx.gates ?? []).map(g => ({ mode: 'online', ...g })),
    training: (fx.training ?? []).map(t => ({
      reviewStatus: 'pending',
      decision: null,
      reviewedBy: null,
      reviewedAt: null,
      ...t,
    })),
    sourceChanges: (fx.sourceChanges ?? []).map(c => ({ ...c, processed: false, processResult: null })),
    applications: [],
    assignments: [],
    replacements: [],
    explicitGrants: [],
    badges: {},
    revocations: [],
    revVersion: 0,
    syncs: {},
    syncHistory: [],
    events: [],
    eventIndex: {},
    disputeResolutions: {},
    verifications: [],
    releases: {},
    partnerSubmissions: {},
    seq: {
      application: 0, assignment: 0, replacement: 0, grant: 0,
      revocation: 0, event: 0, dispute: 0, verification: 0, sync: 0, person: 0, gate: 0, training: 0,
    },
  };
}

export function createCore(options = {}, maybeStateFile) {
  // 兼容 createCore(fixtures, stateFile) 的位置参数习惯。
  if (typeof options === 'string') options = { stateFile: options };
  else if (options && Array.isArray(options.people)) {
    options = {
      fixtures: options,
      ...(typeof maybeStateFile === 'string' ? { stateFile: maybeStateFile } : (maybeStateFile ?? {})),
    };
  }
  const fixtures = options.fixtures
    ? clone(options.fixtures)
    : JSON.parse(readFileSync(options.fixturesFile ?? DEFAULT_FIXTURES, 'utf8'));
  const now = options.now ?? (() => new Date());
  const stateFile = options.stateFile ?? null;

  let state;
  if (options.state) {
    state = options.state;
  } else if (stateFile) {
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = seedState(fixtures);
      save();
    }
  } else {
    state = seedState(fixtures);
  }

  function save() {
    if (!stateFile) return;
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2));
    renameSync(stateFile + '.tmp', stateFile);
  }
  const commit = () => save();
  function nextId(key, prefix) {
    if (!state.seq[key]) state.seq[key] = 0;
    return `${prefix}-${++state.seq[key]}`;
  }

  // 让自增序号跳过夹具中已有的数字编号，避免生成 PE-1 / TRAIN-1 这类撞号。
  const SEQ_SOURCES = [
    ['person', 'PE', 'people'], ['training', 'TRAIN', 'training'],
    ['gate', 'GATE', 'gates'], ['application', 'APP', 'applications'],
    ['assignment', 'AS', 'assignments'], ['replacement', 'REP', 'replacements'],
    ['grant', 'GRANT', 'explicitGrants'], ['revocation', 'RV', 'revocations'],
    ['event', 'EVT', 'events'], ['sync', 'SYNC', 'syncHistory'],
    ['session', 'SS', 'sessions'], ['duty', 'DUTY', 'duties'], ['zone', 'ZONE', 'zones'],
  ];
  for (const [seqKey, prefix, collection] of SEQ_SOURCES) {
    const rows = state[collection] ?? [];
    let max = state.seq[seqKey] ?? 0;
    for (const row of rows) {
      const id = typeof row === 'string' ? row : row.id;
      const m = id && new RegExp(`^${prefix}-(\\d+)$`).exec(id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    state.seq[seqKey] = max;
  }

  // ---------- 基础查询与权限 ----------
  function findPerson(id) {
    const p = state.people.find(x => x.id === id);
    if (!p) throw new HttpError(404, 'person_not_found', `未找到人员 ${id}`);
    return p;
  }
  function findZone(id) {
    const z = state.zones.find(x => x.id === id);
    if (!z) throw new HttpError(404, 'zone_not_found', `未找到区域 ${id}`);
    return z;
  }
  function findSession(id) {
    const s = state.sessions.find(x => x.id === id);
    if (!s) throw new HttpError(404, 'session_not_found', `未找到场次 ${id}`);
    return s;
  }
  function findDuty(id) {
    const d = state.duties.find(x => x.id === id);
    if (!d) throw new HttpError(404, 'duty_not_found', `未找到岗位要求 ${id}`);
    return d;
  }
  function createZone(input) {
    const actor = input.actorId ? actorOf(input.actorId) : null;
    if (actor) requireRole(actor, ['operations']);
    if (input.capacity === undefined || !Number.isFinite(Number(input.capacity))) {
      throw new HttpError(400, 'capacity_required', '区域需要数字 capacity');
    }
    const zone = {
      id: input.id ?? nextId('zone', 'ZONE'),
      capacity: Number(input.capacity),
      training: input.training ?? null,
      allowedCategories: input.allowedCategories ?? (input.training === null ? ['media'] : []),
    };
    if (state.zones.some(z => z.id === zone.id)) throw new HttpError(409, 'zone_exists', `区域 ${zone.id} 已存在`);
    state.zones.push(zone);
    commit();
    return zone;
  }
  function createSession(input) {
    const actor = input.actorId ? actorOf(input.actorId) : null;
    if (actor) requireRole(actor, ['operations']);
    if (!input.start || !input.end) throw new HttpError(400, 'session_time_required', '场次需要 start 与 end');
    parseTime(input.start, 'start'); parseTime(input.end, 'end');
    const session = { id: input.id ?? nextId('session', 'SS'), start: new Date(input.start).toISOString(), end: new Date(input.end).toISOString() };
    if (state.sessions.some(s => s.id === session.id)) throw new HttpError(409, 'session_exists', `场次 ${session.id} 已存在`);
    if (ms(session.end) <= ms(session.start)) throw new HttpError(400, 'bad_window', 'end 必须晚于 start');
    state.sessions.push(session);
    commit();
    return session;
  }
  function createDuty(input) {
    const actor = input.actorId ? actorOf(input.actorId) : null;
    if (actor) requireRole(actor, ['operations']);
    findZone(input.zone); findSession(input.session);
    if (!input.role || input.minimum === undefined) throw new HttpError(400, 'duty_fields', '岗位要求需要 role 与 minimum');
    const duty = {
      id: input.id ?? nextId('duty', 'DUTY'),
      zone: input.zone, session: input.session, role: input.role, minimum: Number(input.minimum),
    };
    if (state.duties.some(d => d.id === duty.id)) throw new HttpError(409, 'duty_exists', `岗位要求 ${duty.id} 已存在`);
    state.duties.push(duty);
    commit();
    return duty;
  }
  function findGate(id) {
    const g = state.gates.find(x => x.id === id);
    if (!g) throw new HttpError(404, 'gate_not_found', `未找到闸机 ${id}`);
    return g;
  }
  function actorOf(actorId) {
    if (!actorId) {
      throw new HttpError(401, 'actor_required', '缺少操作人：请通过 X-Actor 请求头或 actor 字段提供合成角色（GET /api/actors 可查）');
    }
    const a = state.actors.find(x => x.id === actorId);
    if (!a) throw new HttpError(403, 'unknown_actor', `未知操作人 ${actorId}`);
    return a;
  }
  function requireRole(actor, roles, message) {
    if (!roles.includes(actor.role)) {
      throw new HttpError(403, 'forbidden_role', message ?? `角色 ${actor.role} 无权执行该操作`, {
        actor: actor.id, role: actor.role, allowedRoles: roles,
      });
    }
  }

  // ---------- 代表团申报 / 多身份申请 ----------
  function createDeclaration(input) {
    const actor = input.actorId ? actorOf(input.actorId) : null;
    const category = input.category ?? 'delegation';
    if (!['delegation', 'volunteer', 'media'].includes(category)) {
      throw new HttpError(400, 'bad_category', '申请类别必须是 delegation / volunteer / media');
    }
    let person;
    if (input.personId) {
      person = findPerson(input.personId);
    } else if (input.person && input.person.name) {
      // 同名绝不合并：一律新建独立身份。
      const delegation = input.delegation ?? input.person.delegation ?? null;
      person = {
        id: input.newPersonId ?? nextId('person', 'PE'),
        name: input.person.name,
        delegation,
        identityStatus: 'unconfirmed',
        confirmedAt: null,
        confirmedBy: null,
      };
      state.people.push(person);
    } else {
      throw new HttpError(400, 'person_required', '申报必须给出 personId 或新人员 {name, delegation}');
    }
    const delegation = input.delegation ?? person.delegation ?? null;
    if (actor && actor.role === 'delegation') {
      if (!actor.delegation || delegation !== actor.delegation) {
        throw new HttpError(403, 'delegation_scope', '代表团角色只能申报本团成员');
      }
    }
    const application = {
      id: nextId('application', 'APP'),
      person: person.id,
      category,
      delegation,
      claims: input.claims ?? {},
      status: 'pending',
      filedBy: actor?.id ?? input.filedBy ?? null,
      filedAt: iso(parseTime(input.at, '申报时间') ?? now()),
      decision: null,
      decidedBy: null,
      decidedAt: null,
    };
    state.applications.push(application);
    commit();
    return { application, person, noteZh: '申报已收件，身份与申请均需有权人员确认，文件存在不等于批准。' };
  }

  function decideApplication(id, input) {
    const actor = actorOf(input.actorId);
    requireRole(actor, ['credential', 'operations']);
    const app = state.applications.find(a => a.id === id);
    if (!app) throw new HttpError(404, 'application_not_found', `未找到申报 ${id}`);
    if (!['approve', 'reject'].includes(input.decision)) {
      throw new HttpError(400, 'bad_decision', 'decision 必须为 approve / reject');
    }
    app.status = input.decision === 'approve' ? 'approved' : 'rejected';
    app.decision = input.decision;
    app.decidedBy = actor.id;
    app.decidedAt = iso(parseTime(input.at) ?? now());
    commit();
    return app;
  }

  function confirmIdentity(personId, input) {
    const actor = actorOf(input.actorId);
    requireRole(actor, ['credential', 'operations'], '只有证件中心或组委会运营可以确认身份');
    const person = findPerson(personId);
    person.identityStatus = 'confirmed';
    person.confirmedBy = actor.id;
    person.confirmedAt = iso(parseTime(input.at) ?? now());
    commit();
    return { person, noteZh: '身份已确认；同名人员仍是彼此独立的身份，不会合并。' };
  }

  function createPerson(input) {
    const actor = input.actorId ? actorOf(input.actorId) : null;
    if (actor) requireRole(actor, ['credential', 'operations']);
    if (!input.name) throw new HttpError(400, 'name_required', '新建人员需要 name');
    const person = {
      id: input.id ?? nextId('person', 'PE'),
      name: input.name,
      delegation: input.delegation ?? null,
      identityStatus: 'unconfirmed',
      confirmedAt: null,
      confirmedBy: null,
    };
    if (state.people.some(p => p.id === person.id)) throw new HttpError(409, 'person_exists', `人员编号 ${person.id} 已存在`);
    state.people.push(person);
    commit();
    return person;
  }

  // ---------- 培训 / 资格核准（与岗位、身份相互独立） ----------
  function addTraining(input) {
    const person = findPerson(input.person);
    if (!input.kind) throw new HttpError(400, 'kind_required', '培训记录需要 kind');
    const row = {
      id: input.id ?? nextId('training', 'TRAIN'),
      person: person.id,
      kind: input.kind,
      until: input.until ?? null,
      reviewStatus: 'pending',
      decision: null,
      reviewedBy: null,
      reviewedAt: null,
    };
    state.training.push(row);
    commit();
    return row;
  }

  function reviewTraining(id, input) {
    const actor = actorOf(input.actorId);
    requireRole(actor, ['credential', 'operations'], '培训核准由证件中心或组委会运营负责');
    const row = state.training.find(t => t.id === id);
    if (!row) throw new HttpError(404, 'training_not_found', `未找到培训记录 ${id}`);
    if (!['allow', 'deny'].includes(input.decision)) {
      throw new HttpError(400, 'bad_decision', 'decision 必须为 allow / deny');
    }
    row.reviewStatus = input.decision === 'allow' ? 'approved' : 'denied';
    row.decision = input.decision;
    row.reviewedBy = actor.id;
    row.reviewedAt = iso(parseTime(input.at) ?? now());
    commit();
    return row;
  }

  function trainingSatisfied(personId, kind, at) {
    if (!kind) return { ok: true, records: [] };
    const day = dayKey(at ?? now());
    const records = state.training.filter(t => t.person === personId && t.kind === kind);
    const ok = records.some(t => t.reviewStatus === 'approved' && (!t.until || day <= t.until));
    return { ok, records };
  }

  // ---------- 岗位指派与核准 ----------
  function createAssignment(input) {
    const actor = actorOf(input.actorId);
    const person = findPerson(input.person);
    const duty = input.dutyId ? findDuty(input.dutyId) : null;
    const zoneId = input.zone ?? duty?.zone;
    const sessionId = input.session ?? duty?.session;
    if (!zoneId || !sessionId || !input.role) {
      throw new HttpError(400, 'assignment_fields', '指派需要 person、role，以及 dutyId 或 zone+session');
    }
    findZone(zoneId); findSession(sessionId);
    if (duty && input.role && duty.role !== input.role && !input.allowRoleMismatch) {
      throw new HttpError(422, 'role_mismatch', `岗位要求的角色是 ${duty.role}`, { expected: duty.role, got: input.role });
    }
    // 代表团可以提名本团人选，但不能完成核准（核准接口另行鉴权）。
    if (actor.role === 'delegation' && actor.delegation && person.delegation !== actor.delegation) {
      throw new HttpError(403, 'delegation_scope', '代表团只能提名本团成员');
    }
    if (!['delegation', 'operations', 'zonechief'].includes(actor.role)) {
      throw new HttpError(403, 'forbidden_role', '该角色不能建立岗位指派');
    }
    if (actor.role === 'zonechief' && actor.zone !== zoneId) {
      throw new HttpError(403, 'zone_scope', '区域负责人只能处理本区域岗位');
    }
    const asg = {
      id: input.id ?? nextId('assignment', 'AS'),
      person: person.id,
      duty: duty?.id ?? null,
      zone: zoneId,
      session: sessionId,
      role: input.role ?? duty?.role,
      status: 'pending_approval',
      active: false,
      approvedBy: null,
      approvedAt: null,
      endedAt: null,
      endReason: null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      nominatedBy: actor.id,
    };
    state.assignments.push(asg);
    commit();
    return asg;
  }

  function approveAssignment(id, input) {
    const actor = actorOf(input.actorId);
    if (actor.role === 'delegation') {
      throw new HttpError(403, 'delegation_cannot_approve', REASON_ZH.delegation_cannot_approve);
    }
    requireRole(actor, ['operations', 'zonechief']);
    const asg = state.assignments.find(a => a.id === id);
    if (!asg) throw new HttpError(404, 'assignment_not_found', `未找到岗位指派 ${id}`);
    if (actor.role === 'zonechief' && actor.zone !== asg.zone) {
      throw new HttpError(403, 'zone_scope', '区域负责人只能核准本区域岗位');
    }
    const person = findPerson(asg.person);
    if (person.identityStatus !== 'confirmed') {
      throw new HttpError(422, 'identity_unconfirmed', REASON_ZH.identity_unconfirmed);
    }
    const decision = input.decision ?? 'approve';
    if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'bad_decision');
    if (decision === 'reject') {
      asg.status = 'rejected';
      asg.active = false;
      asg.approvedBy = actor.id;
      asg.approvedAt = iso(parseTime(input.at) ?? now());
      commit();
      return asg;
    }
    asg.status = 'approved';
    asg.active = true;
    asg.approvedBy = actor.id;
    asg.approvedAt = iso(parseTime(input.at) ?? now());
    commit();
    return asg;
  }

  function revokeAssignment(id, input) {
    const actor = actorOf(input.actorId);
    if (actor.role === 'delegation') throw new HttpError(403, 'delegation_cannot_approve', REASON_ZH.delegation_cannot_approve);
    requireRole(actor, ['operations', 'zonechief']);
    const asg = state.assignments.find(a => a.id === id);
    if (!asg) throw new HttpError(404, 'assignment_not_found', `未找到岗位指派 ${id}`);
    if (actor.role === 'zonechief' && actor.zone !== asg.zone) throw new HttpError(403, 'zone_scope');
    const at = parseTime(input.at) ?? now();
    asg.active = false;
    asg.status = 'revoked';
    asg.revokedAt = iso(at);
    asg.revokedBy = actor.id;
    asg.revokeReason = input.reason ?? '岗位撤销';
    const rev = addRevocation({
      kind: 'access', person: asg.person, zone: asg.zone, session: asg.session,
      assignmentId: asg.id, at, reason: asg.revokeReason, by: actor.id,
    });
    commit();
    return { assignment: asg, revocation: rev };
  }

  function assignmentActiveAt(a, at) {
    const t = ms(at ?? now());
    if (a.status !== 'approved' || !a.approvedAt) return false;
    if (ms(a.approvedAt) > t) return false;
    if (a.revokedAt && ms(a.revokedAt) <= t) return false;
    if (a.endedAt && ms(a.endedAt) <= t) return false;
    return true;
  }

  // ---------- 通行证与证件代次 ----------
  function badgeView(personId) {
    const badge = state.badges[personId];
    if (!badge) return null;
    return { ...badge, generations: badge.generations.map(g => ({ ...g })) };
  }
  function generationValidAt(personId, generation, at) {
    const badge = state.badges[personId];
    if (!badge) return { ok: false, code: 'no_badge' };
    const gen = badge.generations.find(g => g.generation === Number(generation));
    if (!gen) return { ok: false, code: 'badge_generation_invalid' };
    const t = (at ?? now()).getTime();
    if (ms(gen.issuedAt) > t) return { ok: false, code: 'badge_generation_invalid' };
    if (gen.revokedAt && ms(gen.revokedAt) <= t) return { ok: false, code: 'badge_generation_invalid' };
    return { ok: true, gen };
  }

  function issueBadge(input) {
    const actor = actorOf(input.actorId);
    requireRole(actor, ['credential', 'operations']);
    const person = findPerson(input.person);
    if (person.identityStatus !== 'confirmed') {
      throw new HttpError(422, 'identity_unconfirmed', REASON_ZH.identity_unconfirmed);
    }
    if (state.badges[person.id]) {
      throw new HttpError(409, 'badge_exists', '该人员已有通行证；挂失/换证请使用 reissue 或 revoke');
    }
    const at = parseTime(input.at) ?? now();
    const generation = input.generation ?? 1;
    state.badges[person.id] = {
      person: person.id,
      currentGeneration: generation,
      synthetic: true,
      generations: [{
        generation,
        badgeId: input.badgeId ?? `BADGE-${person.id}-G${generation}`,
        status: 'active',
        issuedAt: iso(at),
        issuedBy: actor.id,
        revokedAt: null,
        reason: null,
      }],
    };
    commit();
    return badgeView(person.id);
  }

  function addRevocation({ kind, person, generation = null, zone = null, session = null, assignmentId = null, at, reason, by }) {
    const rev = {
      id: nextId('revocation', 'RV'),
      revVersion: ++state.revVersion,
      kind, // badge | access
      person, generation, zone, session, assignmentId,
      at: iso(at ?? now()),
      reason: reason ?? (kind === 'badge' ? '证件挂失/换证' : '岗位撤销'),
      by: by ?? null,
    };
    state.revocations.push(rev);
    return rev;
  }

  function reissueBadge(input) {
    const actor = actorOf(input.actorId);
    requireRole(actor, ['credential', 'operations']);
    const person = findPerson(input.person);
    const badge = state.badges[person.id];
    if (!badge) throw new HttpError(404, 'badge_not_found', '该人员尚无通行证，请先 issue');
    const at = parseTime(input.at) ?? now();
    const oldGenNumber = input.oldGeneration ?? badge.currentGeneration;
    const old = badge.generations.find(g => g.generation === Number(oldGenNumber));
    if (!old) throw new HttpError(404, 'generation_not_found', `没有第 ${oldGenNumber} 代证件`);
    if (old.status === 'active' && !old.revokedAt) {
      old.status = 'revoked';
      old.revokedAt = iso(at);
      old.reason = input.reason ?? '补发新证，旧证失效';
      addRevocation({
        kind: 'badge', person: person.id, generation: old.generation, at,
        reason: old.reason, by: actor.id,
      });
    }
    const newGen = (input.newGeneration ?? badge.currentGeneration + 1);
    if (badge.generations.some(g => g.generation === Number(newGen))) {
      throw new HttpError(409, 'generation_exists', `第 ${newGen} 代已存在`);
    }
    badge.generations.push({
      generation: Number(newGen),
      badgeId: input.badgeId ?? `BADGE-${person.id}-G${newGen}`,
      status: 'active',
      issuedAt: iso(at),
      issuedBy: actor.id,
      revokedAt: null,
      reason: input.reason ?? '补发',
    });
    badge.currentGeneration = Number(newGen);
    commit();
    return {
      badge: badgeView(person.id),
      oldGenerationInvalid: old.generation,
      newGeneration: Number(newGen),
      presenceUnaffectedZh: '换证只改变许可与证件代次；该人员已有的实际在场记录继续保留，不会因换证消失。',
    };
  }

  function revokeBadge(input) {
    const actor = actorOf(input.actorId);
    requireRole(actor, ['credential', 'operations']);
    const person = findPerson(input.person);
    const badge = state.badges[person.id];
    if (!badge) throw new HttpError(404, 'badge_not_found', '该人员尚无通行证');
    const at = parseTime(input.at) ?? now();
    const genNumber = input.generation ?? badge.currentGeneration;
    const gen = badge.generations.find(g => g.generation === Number(genNumber));
    if (!gen) throw new HttpError(404, 'generation_not_found');
    let rev = null;
    if (!gen.revokedAt) {
      gen.status = 'revoked';
      gen.revokedAt = iso(at);
      gen.reason = input.reason ?? '挂失/撤销';
      rev = addRevocation({ kind: 'badge', person: person.id, generation: gen.generation, at, reason: gen.reason, by: actor.id });
    }
    commit();
    return { badge: badgeView(person.id), revocation: rev };
  }

  // ---------- 通行依据 / 有效权限（不含“是否到场”） ----------
  function approvedCategories(personId) {
    return new Set(state.applications
      .filter(a => a.person === personId && a.status === 'approved')
      .map(a => a.category));
  }

  function accessBasis(person, zone, session, at) {
    const t = at ?? now();
    const reasons = [];
    const basis = {
      identityConfirmed: person.identityStatus === 'confirmed',
      approvedCategories: [...approvedCategories(person.id)],
      training: trainingSatisfied(person.id, zone.training, t),
      assignments: [],
      grants: [],
    };
    if (!basis.identityConfirmed) reasons.push('identity_unconfirmed');
    if (!basis.training.ok) reasons.push('training_missing');

    const asgs = state.assignments.filter(a => a.person === person.id && a.zone === zone.id && a.session === session.id);
    basis.assignments = asgs.map(a => ({
      id: a.id, duty: a.duty, role: a.role, status: a.status, activeAtTime: assignmentActiveAt(a, t),
    }));
    const postOk = asgs.some(a => assignmentActiveAt(a, t));

    const cats = approvedCategories(person.id);
    const categoryOk = (zone.allowedCategories ?? []).some(c => cats.has(c));

    const grants = state.explicitGrants.filter(g =>
      g.person === person.id && g.zone === zone.id &&
      (!g.session || g.session === session.id) &&
      (!g.from || ms(g.from) <= t.getTime()) &&
      (!g.until || ms(g.until) > t.getTime()) &&
      g.status === 'approved');
    basis.grants = grants.map(g => ({ id: g.id, scope: g.scope, session: g.session }));

    if (!postOk && !categoryOk && grants.length === 0) {
      // 有培训要求的敏感区域按“缺岗位核准”提示；其余区域按“缺通行依据”提示。
      reasons.push(zone.training ? 'assignment_missing' : 'access_grant_missing');
    }
    const permitted = !reasons.length;
    return { permitted, reasons, basis, postOk, categoryOk, grantOk: grants.length > 0 };
  }

  function sessionTimeState(session, at) {
    const t = (at ?? now()).getTime();
    const start = ms(session.start) - (state.entryLeadSeconds ?? 0) * 1000;
    const end = ms(session.end);
    return {
      entryWindowOpen: t >= start && t <= end,
      sessionOngoing: t >= ms(session.start) && t <= end,
      start: session.start, end: session.end,
      entryLeadSeconds: state.entryLeadSeconds ?? 0,
    };
  }

  function resolveSession(atIsoValue, preferred) {
    if (preferred) return findSession(preferred);
    const t = ms(atIsoValue);
    const lead = (state.entryLeadSeconds ?? 0) * 1000;
    const hit = state.sessions.find(s => t >= ms(s.start) - lead && t <= ms(s.end));
    if (hit) return hit;
    return state.sessions[0] ?? null;
  }

  function evaluateEntry(input) {
    const at = parseTime(input.at, '事件时间') ?? now();
    const person = findPerson(input.person);
    const gate = findGate(input.gate);
    const zone = findZone(input.zone ?? gate.zone);
    const session = resolveSession(input.at, input.session);
    const checks = {};
    const reasons = [];
    checks.personKnown = true;
    checks.identityConfirmed = person.identityStatus === 'confirmed';
    if (!checks.identityConfirmed) reasons.push('identity_unconfirmed');

    const badgeCheck = input.badgeGeneration == null
      ? { ok: false, code: 'no_badge' }
      : generationValidAt(person.id, Number(input.badgeGeneration), at);
    checks.badgeGenerationValid = badgeCheck.ok;
    if (!badgeCheck.ok) reasons.push(badgeCheck.code);

    if (session) {
      const access = accessBasis(person, zone, session, at);
      checks.trainingCurrent = access.basis.training.ok;
      checks.accessBasis = access.permitted;
      checks.postOrCategoryOrGrant = access.postOk || access.categoryOk || access.grantOk;
      if (!access.permitted) reasons.push(...access.reasons);
      const timeState = sessionTimeState(session, at);
      checks.sessionWindow = timeState.entryWindowOpen;
      if (!timeState.entryWindowOpen) reasons.push('outside_session');
    } else {
      checks.sessionWindow = false;
      reasons.push('outside_session');
    }

    // 在场 / 容量由调用方结合投影补充。
    return { allowed: reasons.length === 0, reasons, checks, at, person, gate, zone, session };
  }

  // ---------- 在场投影：只依赖不可变事件，按事件时间重放 ----------
  function voidedEventIds() {
    const set = new Set();
    for (const resolution of Object.values(state.disputeResolutions)) {
      for (const id of resolution.voidEventIds ?? []) set.add(id);
    }
    return set;
  }

  function replay(options = {}) {
    const until = options.until ? ms(options.until) : null;
    const voided = voidedEventIds();
    const events = state.events
      .filter(e => e.status === 'applied' && !e.voided && !voided.has(e.id))
      .filter(e => until === null || ms(e.at) <= until)
      .sort((a, b) =>
        (ms(a.at) - ms(b.at)) ||
        (ms(a.receivedAt) - ms(b.receivedAt)) ||
        a.id.localeCompare(b.id));

    const stays = {}; // person -> open stay
    const effects = {}; // eventId -> effect descriptor
    const anomalies = [];
    for (const e of events) {
      const personId = e.person;
      const open = stays[personId] ?? null;
      if (e.type === 'enter') {
        if (!open) {
          stays[personId] = {
            person: personId, zone: e.zone, session: e.session,
            gate: e.gate, enterEvent: e.id, at: e.at, badgeGeneration: e.badgeGeneration,
          };
          effects[e.id] = { effect: 'opened', zone: e.zone };
        } else if (open.zone === e.zone) {
          effects[e.id] = { effect: 'repeat_enter_ignored', zone: e.zone };
          e.flags = Array.from(new Set([...(e.flags ?? []), 'already_in_zone']));
        } else {
          effects[e.id] = { effect: 'conflict_enter', zone: e.zone, openZone: open.zone };
          e.flags = Array.from(new Set([...(e.flags ?? []), 'location_conflict']));
          anomalies.push({
            key: `D-${e.id}`,
            kind: 'location_conflict',
            person: personId,
            events: [open.enterEvent, e.id],
            zones: [open.zone, e.zone],
            session: e.session ?? open.session,
            latestEvent: e.id,
            at: e.at,
          });
          // 临时投影：以事件时间更晚的入场为“推定位置”，但争议保持打开，
          // 两个区域的查询都会看到 disputedClaims；绝不删除任何原始记录。
          stays[personId] = {
            person: personId, zone: e.zone, session: e.session ?? open.session,
            gate: e.gate, enterEvent: e.id, at: e.at, badgeGeneration: e.badgeGeneration,
            presumed: true, conflictWith: open.enterEvent,
          };
        }
      } else if (e.type === 'exit') {
        if (open && open.zone === e.zone) {
          effects[e.id] = { effect: 'closed', zone: e.zone, closedEnter: open.enterEvent };
          stays[personId] = null;
        } else if (open) {
          effects[e.id] = { effect: 'exit_zone_mismatch', zone: e.zone, openZone: open.zone };
          e.flags = Array.from(new Set([...(e.flags ?? []), 'exit_zone_mismatch']));
          anomalies.push({
            key: `D-${e.id}`,
            kind: 'exit_zone_mismatch',
            person: personId,
            events: [open.enterEvent, e.id],
            zones: [open.zone, e.zone],
            at: e.at,
          });
          // 不在本区域扣减：出场区域与实际在场区域不一致。
        } else {
          effects[e.id] = { effect: 'exit_without_entry', zone: e.zone };
          e.flags = Array.from(new Set([...(e.flags ?? []), 'exit_without_entry']));
          anomalies.push({
            key: `D-${e.id}`,
            kind: 'exit_without_entry',
            person: personId,
            events: [e.id],
            zones: [e.zone],
            at: e.at,
          });
        }
      }
    }
    // 附加解决信息
    for (const a of anomalies) {
      const resolution = state.disputeResolutions[a.key];
      if (resolution) a.resolution = resolution;
      a.status = resolution ? 'resolved' : 'open';
    }
    return { stays, effects, anomalies };
  }

  function currentProjection() {
    return replay();
  }
  function presenceAt(atValue) {
    return replay({ until: iso(parseTime(atValue) ?? now()) });
  }
  function isOnSite(personId, zoneId, sessionId, atIsoValue) {
    const proj = atIsoValue ? presenceAt(atIsoValue) : currentProjection();
    const stay = proj.stays[personId];
    // 推定位置（存在未决区域争议）不能算作确定到岗。
    return !!(stay && stay.zone === zoneId && !stay.presumed && (!sessionId || stay.session === sessionId));
  }

  function openDisputes() {
    return currentProjection().anomalies.filter(a => a.status === 'open');
  }

  // 争议核实并作废事件后，异常可能不再被重放出来；用核实档案补回“已解决”条目，保证可追溯。
  function listDisputes() {
    const proj = currentProjection();
    const activeKeys = new Set(proj.anomalies.map(a => a.key));
    const archived = Object.values(state.disputeResolutions)
      .filter(r => !activeKeys.has(r.key))
      .map(r => ({
        key: r.key, kind: r.kind ?? 'resolved', person: r.person ?? null,
        zones: r.zones ?? [], events: r.events ?? [], status: 'resolved', resolution: r,
      }));
    return [...proj.anomalies, ...archived];
  }

  function resolveDispute(key, input) {
    const actor = actorOf(input.actorId);
    requireRole(actor, ['operations', 'zonechief']);
    const proj = currentProjection();
    const anomaly = proj.anomalies.find(a => a.key === key);
    if (!anomaly) throw new HttpError(404, 'dispute_not_found', `未找到争议 ${key}`);
    if (state.disputeResolutions[key]) throw new HttpError(409, 'dispute_resolved', '该争议已有结论；更正请保留原结论并发起新的核实记录');
    const at = parseTime(input.at) ?? now();
    const voidEventIds = new Set(input.voidEventIds ?? []);
    if (input.decision === 'actual_location') {
      if (!input.actualZone) throw new HttpError(400, 'actual_zone_required', 'actual_location 结论需要 actualZone');
      // 未显式指定保留/作废时，作废与核实位置不一致的争议入场事件。
      if (!input.voidEventIds) {
        for (const eventId of anomaly.events) {
          const ev = state.events.find(e => e.id === eventId);
          if (ev && ev.type === 'enter' && ev.zone !== input.actualZone) voidEventIds.add(ev.id);
        }
      }
    }
    for (const id of voidEventIds) {
      const ev = state.events.find(e => e.id === id);
      if (!ev) throw new HttpError(404, 'event_not_found', `未找到事件 ${id}`);
      ev.voided = true;
      ev.voidedAt = iso(at);
      ev.voidedBy = actor.id;
    }
    const resolution = {
      key,
      kind: anomaly.kind,
      person: anomaly.person,
      zones: anomaly.zones,
      events: anomaly.events,
      decision: input.decision ?? 'actual_location',
      actualZone: input.actualZone ?? null,
      note: input.note ?? '',
      voidEventIds: [...voidEventIds],
      by: actor.id,
      at: iso(at),
    };
    state.disputeResolutions[key] = resolution;
    state.verifications.push({ id: nextId('verification', 'VRF'), kind: 'dispute', dispute: key, ...resolution });
    commit();
    return { resolution, projection: currentProjection().stays[anomaly.person] ?? null };
  }

  // ---------- 容量 / 区域视图 ----------
  function zoneOccupancy(zoneId, query = {}) {
    const zone = findZone(zoneId);
    const session = query.session ? findSession(query.session) : (resolveSession(query.at, query.session) ?? state.sessions[0]);
    const proj = query.at ? presenceAt(query.at) : currentProjection();
    const inside = Object.values(proj.stays)
      .filter(s => s && s.zone === zoneId && (!session || !s.session || s.session === session.id));
    const openConflicts = proj.anomalies.filter(a => a.status === 'open' && a.kind === 'location_conflict' && a.zones.includes(zoneId));
    const disputedClaims = openConflicts
      .map(a => ({ dispute: a.key, person: a.person, zones: a.zones, events: a.events }));

    const at = parseTime(query.at) ?? now();
    const people = inside.map(stay => {
      const person = state.people.find(p => p.id === stay.person);
      const access = session ? accessBasis(person, zone, session, at) : null;
      const genCheck = stay.badgeGeneration != null ? generationValidAt(person.id, stay.badgeGeneration, at) : { ok: null };
      const reasons = [];
      if (access && !access.permitted) reasons.push(...access.reasons);
      if (genCheck.ok === false) reasons.push(genCheck.code);
      if (session && !sessionTimeState(session, at).sessionOngoing && ms(at) > ms(session.end)) reasons.push('session_ended');
      return {
        person: person.id, name: person.name, since: stay.at, gate: stay.gate,
        badgeGeneration: stay.badgeGeneration, presumed: !!stay.presumed,
        disputeWith: stay.conflictWith ?? null,
        currentPermissionValid: access ? access.permitted && genCheck.ok !== false : null,
        reasons,
      };
    });

    // 超员部分：按入场时间最晚的若干人作为建议离场候选（策略明确标注，可由负责人调整）。
    const overBy = Math.max(0, people.length - zone.capacity);
    const sortedByEnterDesc = [...people].sort((a, b) => ms(b.since) - ms(a.since));
    const overCapacityIds = new Set(sortedByEnterDesc.slice(0, overBy).map(p => p.person));
    for (const p of people) {
      p.overCapacity = overCapacityIds.has(p.person);
      if (p.overCapacity && !p.reasons.includes('capacity_full')) p.reasons.push('capacity_full');
    }
    const mustLeave = people
      .filter(p => p.reasons.length > 0)
      .map(p => ({ person: p.person, name: p.name, reasons: p.reasons, overCapacity: p.overCapacity }));

    return {
      zone: zone.id, name: zone.name ?? zone.id, capacity: zone.capacity,
      session: session?.id ?? null,
      insideCount: people.length,
      remaining: Math.max(0, zone.capacity - people.length),
      overCapacityBy: overBy,
      capacityExceeded: people.length > zone.capacity,
      people,
      disputedClaims,
      mustLeave,
      summaryZh: `区域 ${zone.id} 当前实际在场 ${people.length} 人，容量 ${zone.capacity}，剩余 ${Math.max(0, zone.capacity - people.length)}；` +
        (overBy ? `已超员 ${overBy} 人。` : '未超员。') +
        (mustLeave.length ? ` 有 ${mustLeave.length} 人存在失效许可/超员等待离场情形。` : ' 未发现需离场人员。') +
        (disputedClaims.length ? ` 另有 ${disputedClaims.length} 条位置争议，实际位置待核实。` : ''),
    };
  }

  // ---------- 按人查询：有效权限 + 实际位置/争议 ----------
  function personStatus(personId, query = {}) {
    const person = findPerson(personId);
    const at = parseTime(query.at) ?? now();
    const badge = badgeView(personId);
    const proj = query.at ? presenceAt(query.at) : currentProjection();
    const stay = proj.stays[personId] ?? null;
    const disputes = listDisputes().filter(a => a.person === personId);
    const sessions = query.session ? [findSession(query.session)] : state.sessions;
    const accessList = [];
    for (const session of sessions) {
      for (const zone of state.zones) {
        const access = accessBasis(person, zone, session, at);
        const timeState = sessionTimeState(session, at);
        const currentGen = badge?.currentGeneration ?? null;
        const genValid = currentGen != null ? generationValidAt(personId, currentGen, at).ok : false;
        accessList.push({
          zone: zone.id, session: session.id,
          permitted: access.permitted,
          reasons: access.reasons,
          basis: access.basis,
          currentBadgeGeneration: currentGen,
          currentGenerationValidAtTime: genValid,
          sessionWindow: timeState,
          canEnterAtTime: access.permitted && genValid && timeState.entryWindowOpen,
          issuedPermitZh: access.permitted
            ? `已下发/具备 ${zone.id}@${session.id} 的许可依据（身份、培训、岗位/类别均有效）`
            : `当前不具备 ${zone.id}@${session.id} 许可：${access.reasons.map(r => REASON_ZH[r] ?? r).join('；')}`,
        });
      }
    }
    const events = state.events.filter(e => e.person === personId).slice(-30).reverse();
    const openDisputesForPerson = disputes.filter(d => d.status === 'open');
    let presenceZh;
    if (!stay) presenceZh = '实际到场：无在场记录（可能尚未入场或已正常出场）。';
    else {
      presenceZh = `实际到场：${stay.zone}（${stay.gate} 闸机 ${stay.at} 入场${stay.presumed ? '，为按事件时间得到的推定位置，存在未决争议' : ''}）。`;
    }
    const permitLine = accessList.filter(a => a.permitted).length
      ? `有效许可：${accessList.filter(a => a.permitted).map(a => `${a.zone}@${a.session}`).join('、')}。`
      : '有效许可：无。';
    const summaryZh = `${person.name}（${person.id}，不得按姓名合并身份）。${permitLine}${presenceZh}` +
      (openDisputesForPerson.length ? ` 有 ${openDisputesForPerson.length} 条位置/流水争议待现场核实。` : '') +
      ' 注意：“已下发许可”和“实际到场”是两件事。';
    return {
      at: iso(at),
      person,
      applications: state.applications.filter(a => a.person === personId),
      training: state.training.filter(t => t.person === personId),
      assignments: state.assignments.filter(a => a.person === personId),
      replacements: state.replacements.filter(r => r.outgoing === personId || r.incoming === personId),
      badge,
      effectiveAccess: accessList,
      presence: stay ? { ...stay, inside: true } : { inside: false },
      disputes,
      events,
      summaryZh,
    };
  }

  // ---------- 某人今天是否可以值勤（资格/岗位，不等同于已到场） ----------
  function dutyEligibility(personId, date) {
    const person = findPerson(personId);
    const day = date ?? dayKey(now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, 'bad_date', 'date 必须是 YYYY-MM-DD');
    const sessions = state.sessions.filter(s => s.start.slice(0, 10) === day);
    const proj = currentProjection();
    const duties = [];
    for (const session of sessions) {
      for (const duty of state.duties.filter(d => d.session === session.id)) {
        const zone = findZone(duty.zone);
        const at = new Date(session.start);
        const asgs = state.assignments.filter(a => a.person === personId && a.duty === duty.id);
        const activeAsg = asgs.find(a => assignmentActiveAt(a, at));
        const training = trainingSatisfied(personId, zone.training, at);
        const identityOk = person.identityStatus === 'confirmed';
        const badge = state.badges[personId] ?? null;
        const badgeOk = !!badge?.generations.some(g => ms(g.issuedAt) <= at.getTime() && (!g.revokedAt || ms(g.revokedAt) > at.getTime()));
        const reasons = [];
        if (!identityOk) reasons.push('identity_unconfirmed');
        if (!training.ok) reasons.push('training_missing');
        if (!activeAsg) reasons.push('assignment_missing');
        if (!badgeOk) reasons.push('no_badge');
        const stay = proj.stays[personId] ?? null;
        duties.push({
          duty: duty.id, role: duty.role, zone: duty.zone, session: session.id,
          assignment: activeAsg?.id ?? null,
          eligible: reasons.length === 0,
          reasons, reasonsZh: reasons.map(r => REASON_ZH[r] ?? r),
          currentlyOnSite: !!(stay && stay.zone === duty.zone && !stay.presumed),
        });
      }
    }
    const canDuty = duties.some(d => d.eligible);
    return {
      person: person.id, name: person.name, date: day,
      canDuty,
      duties,
      summaryZh: duties.length === 0
        ? `${person.name}（${person.id}）在 ${day} 没有对应场次的核心岗位安排。`
        : canDuty
          ? `${person.name}（${person.id}）${day} 具备值勤资格（身份、培训、岗位核准、证件齐备）；是否实际到岗请看 currentlyOnSite / 按人位置查询。`
          : `${person.name}（${person.id}）${day} 尚不能值勤：` +
            [...new Set(duties.flatMap(d => d.reasonsZh))].join('；'),
    };
  }

  // ---------- 替班 ----------
  function replacementChecks(duty, incoming, atValue) {
    const at = parseTime(atValue) ?? now();
    const person = findPerson(incoming);
    const reasons = [];
    if (person.identityStatus !== 'confirmed') reasons.push('identity_unconfirmed');
    const training = trainingSatisfied(incoming, findZone(duty.zone).training, at);
    if (!training.ok) reasons.push('training_missing');
    const incomingAsg = state.assignments.find(a =>
      a.person === incoming && a.duty === duty.id && assignmentActiveAt(a, at));
    if (!incomingAsg) reasons.push('assignment_missing');
    const onSite = isOnSite(incoming, duty.zone, duty.session, atValue ? iso(at) : null);
    if (!onSite) reasons.push('incoming_not_on_site');
    return {
      qualified: !reasons.includes('identity_unconfirmed') && !reasons.includes('training_missing') && !reasons.includes('assignment_missing'),
      arrived: onSite,
      ready: reasons.length === 0,
      reasons,
      reasonsZh: reasons.map(r => REASON_ZH[r] ?? r),
      incomingAssignment: incomingAsg?.id ?? null,
    };
  }

  function createReplacement(input) {
    const actor = actorOf(input.actorId);
    requireRole(actor, ['operations', 'zonechief']);
    const duty = input.dutyId ? findDuty(input.dutyId) : findDuty(input.duty);
    const outgoing = findPerson(input.outgoing);
    const incoming = findPerson(input.incoming);
    if (outgoing.id === incoming.id) throw new HttpError(422, 'same_person', '替班的出班人与接班人不能是同一身份');
    if (actor.role === 'zonechief' && actor.zone !== duty.zone) throw new HttpError(403, 'zone_scope');
    const outgoingAsg = state.assignments.find(a =>
      a.person === outgoing.id && a.duty === duty.id && assignmentActiveAt(a, parseTime(input.at) ?? now()));
    const checks = replacementChecks(duty, incoming.id, input.at);
    const rep = {
      id: nextId('replacement', 'REP'),
      duty: duty.id,
      zone: duty.zone,
      session: duty.session,
      outgoing: outgoing.id,
      outgoingAssignment: outgoingAsg?.id ?? null,
      incoming: incoming.id,
      status: checks.ready ? 'ready' : checks.qualified ? 'awaiting_arrival' : 'blocked',
      checks,
      createdAt: iso(parseTime(input.at) ?? now()),
      createdBy: actor.id,
      completedAt: null,
      completedBy: null,
    };
    state.replacements.push(rep);
    commit();
    return rep;
  }

  function completeReplacement(id, input) {
    const actor = actorOf(input.actorId);
    requireRole(actor, ['operations', 'zonechief']);
    const rep = state.replacements.find(r => r.id === id);
    if (!rep) throw new HttpError(404, 'replacement_not_found', `未找到替班单 ${id}`);
    if (rep.status === 'completed') throw new HttpError(409, 'already_completed', '该替班已完成');
    if (actor.role === 'zonechief' && actor.zone !== rep.zone) throw new HttpError(403, 'zone_scope');
    const at = parseTime(input.at) ?? now();
    // 完成瞬间重新核对：资格 + 到岗，防止建单后状态变化。
    const checks = replacementChecks(findDuty(rep.duty), rep.incoming, input.at ? iso(at) : null);
    rep.checks = checks;
    if (!checks.qualified) {
      rep.status = 'blocked'; commit();
      throw new HttpError(422, 'not_qualified', REASON_ZH.not_qualified, checks);
    }
    if (!checks.arrived) {
      rep.status = 'awaiting_arrival'; commit();
      // 关键：原岗位保持不动，绝不先撤岗。
      throw new HttpError(409, 'incoming_not_on_site', REASON_ZH.incoming_not_on_site, checks);
    }
    // 原子交接：先确认接班人有效指派，再结束出班人岗位。
    const incomingAsg = state.assignments.find(a => a.id === checks.incomingAssignment);
    if (incomingAsg) {
      incomingAsg.active = true;
      if (incomingAsg.status !== 'approved') incomingAsg.status = 'approved';
    }
    if (rep.outgoingAssignment) {
      const out = state.assignments.find(a => a.id === rep.outgoingAssignment);
      if (out && assignmentActiveAt(out, at)) {
        out.active = false;
        out.endedAt = iso(at);
        out.endReason = `替班 ${rep.id}，由 ${rep.incoming} 接替`;
      }
    }
    rep.status = 'completed';
    rep.completedAt = iso(at);
    rep.completedBy = actor.id;
    commit();
    return rep;
  }

  function cancelReplacement(id, input) {
    const actor = actorOf(input.actorId);
    requireRole(actor, ['operations', 'zonechief']);
    const rep = state.replacements.find(r => r.id === id);
    if (!rep) throw new HttpError(404, 'replacement_not_found', `未找到替班单 ${id}`);
    if (rep.status === 'completed') throw new HttpError(409, 'already_completed', '已完成的替班不能取消');
    rep.status = 'cancelled';
    rep.cancelledAt = iso(parseTime(input.at) ?? now());
    rep.cancelledBy = actor.id;
    // 出班人岗位从未被提前撤销，因此无需恢复。
    commit();
    return rep;
  }

  function addGrant(input) {
    const actor = actorOf(input.actorId);
    requireRole(actor, ['operations', 'zonechief']);
    findPerson(input.person); findZone(input.zone);
    if (input.session) findSession(input.session);
    if (actor.role === 'zonechief' && actor.zone !== input.zone) throw new HttpError(403, 'zone_scope');
    const grant = {
      id: nextId('grant', 'GRANT'),
      person: input.person, zone: input.zone, session: input.session ?? null,
      scope: input.scope ?? 'zone-session',
      from: input.from ?? null, until: input.until ?? null,
      reason: input.reason ?? '', status: 'approved',
      by: actor.id, at: iso(parseTime(input.at) ?? now()),
    };
    state.explicitGrants.push(grant);
    commit();
    return grant;
  }

  // ---------- 按场次：岗位齐备 / 最低在岗 / 放行下一场 ----------
  function sessionStaffing(sessionId, query = {}) {
    const session = findSession(sessionId);
    const atValue = query.at ? iso(parseTime(query.at)) : null;
    const proj = atValue ? presenceAt(atValue) : currentProjection();
    const dutyViews = state.duties.filter(d => d.session === session.id).map(duty => {
      const zone = findZone(duty.zone);
      const asgs = state.assignments.filter(a => a.duty === duty.id);
      const active = asgs.filter(a => assignmentActiveAt(a, parseTime(atValue) ?? now()));
      const qualified = active.filter(a => trainingSatisfied(a.person, zone.training, parseTime(atValue) ?? now()).ok);
      const present = qualified.filter(a => {
        const stay = proj.stays[a.person];
        return stay && stay.zone === duty.zone && (!stay.session || stay.session === duty.session) && !stay.presumed;
      });
      // 有争议的到岗单独列出，不计入确定在岗人数。
      const disputedPresent = qualified.filter(a => {
        const stay = proj.stays[a.person];
        return stay && stay.zone === duty.zone && stay.presumed;
      });
      return {
        duty: duty.id, zone: duty.zone, role: duty.role, minimum: duty.minimum,
        assignments: asgs.map(a => ({ id: a.id, person: a.person, status: a.status, active: assignmentActiveAt(a, parseTime(atValue) ?? now()) })),
        activeCount: active.length,
        qualifiedCount: qualified.length,
        present: present.map(a => ({ assignment: a.id, person: a.person })),
        presentCount: present.length,
        disputedPresent: disputedPresent.map(a => a.person),
        met: present.length >= duty.minimum,
      };
    });
    const allMet = dutyViews.every(d => d.met);
    const release = state.releases[session.id] ?? null;
    return {
      session: session.id,
      at: atValue ?? 'ledger-current',
      duties: dutyViews,
      allCorePostsMet: allMet,
      releaseAllowed: allMet,
      release,
      summaryZh: allMet
        ? `场次 ${session.id} 核心岗位最低在岗要求均已满足，可以放行下一场。`
        : `场次 ${session.id} 核心岗位尚未齐备：` +
          dutyViews.filter(d => !d.met).map(d => `${d.role}(${d.zone}) 在岗 ${d.presentCount}/${d.minimum}`).join('；') +
          '。最低在岗人数约束下一场放行。',
    };
  }

  function releaseSession(sessionId, input) {
    const actor = actorOf(input.actorId);
    requireRole(actor, ['operations', 'zonechief']);
    const view = sessionStaffing(sessionId, { at: input.at });
    if (!view.allCorePostsMet) {
      throw new HttpError(409, 'core_posts_short', '核心岗位最低在岗人数不足，不能放行下一场', view);
    }
    const at = parseTime(input.at) ?? now();
    state.releases[sessionId] = { session: sessionId, releasedAt: iso(at), releasedBy: actor.id, note: input.note ?? '' };
    commit();
    return state.releases[sessionId];
  }

  // ---------- 闸机同步：许可快照 + 明确额度 + 撤销版本 ----------
  function gateSync(gateId, input = {}) {
    const actor = input.actorId ? actorOf(input.actorId) : null;
    if (actor && !['operations', 'credential', 'zonechief'].includes(actor.role)) {
      throw new HttpError(403, 'forbidden_role', '该角色不能执行门禁同步');
    }
    const gate = findGate(gateId);
    const at = parseTime(input.at) ?? now();
    const session = input.session ? findSession(input.session) : (state.sessions[0] ? findSession(state.sessions[0].id) : null);
    if (!session) throw new HttpError(422, 'session_required', '没有可同步的场次');
    const zone = findZone(gate.zone);

    // 生成当前有效的许可清单（只含已确认、资格/依据有效且已发证的人）。
    const permits = [];
    for (const person of state.people) {
      const access = accessBasis(person, zone, session, at);
      if (!access.permitted) continue;
      const badge = state.badges[person.id];
      if (!badge) continue;
      // 快照必须反映“同步完成那一刻”有效的代次，而不是后来换证后的当前指针。
      const validGen = badge.generations.find(g =>
        ms(g.issuedAt) <= at.getTime() && (!g.revokedAt || ms(g.revokedAt) > at.getTime()));
      if (!validGen) continue;
      permits.push({
        syncRequest: undefined, // 下面拿到 syncId 后补
        person: person.id,
        name: person.name,
        badgeGeneration: validGen.generation,
        zone: zone.id,
        session: session.id,
        basis: { post: access.postOk, category: access.categoryOk, grant: access.grantOk },
      });
    }

    // 容量额度分配：当前实际在场 + 其他离线快照尚未使用的预留额度。
    const proj = currentProjection();
    const occupancy = Object.values(proj.stays).filter(s => s && s.zone === zone.id && s.session === session.id).length;
    const reservedUnused = Object.entries(state.syncs)
      .flatMap(([gid, bySession]) => Object.entries(bySession).map(([sid, snap]) => ({ gid, sid, snap })))
      .filter(x => x.sid === session.id && x.snap.zone === zone.id && !(x.gid === gate.id))
      .reduce((sum, x) => sum + Math.max(0, x.snap.quota - quotaUsed(x.snap.id)), 0);
    const distributable = Math.max(0, zone.capacity - occupancy - reservedUnused);
    const requested = input.quota === undefined ? distributable : Math.max(0, Math.floor(Number(input.quota)));
    const quotaGranted = Math.min(requested, distributable);

    const syncId = nextId('sync', 'SYNC');
    for (const p of permits) p.syncRequest = `${syncId}-${p.person}-G${p.badgeGeneration}`;
    const offlineWindowSeconds = state.protocol.offlineWindowSeconds ?? 120;
    const snap = {
      id: syncId,
      gate: gate.id,
      zone: zone.id,
      session: session.id,
      syncedAt: iso(at),
      offlineWindowSeconds,
      offlineUntil: new Date(at.getTime() + offlineWindowSeconds * 1000).toISOString(),
      revVersionAtSync: state.revVersion,
      quota: quotaGranted,
      quotaRequested: requested,
      occupancyAtSync: occupancy,
      reservedUnusedAtSync: reservedUnused,
      distributableAtSync: distributable,
      permits,
      partnerNonce: null,
      partner: null,
    };
    state.syncs[gate.id] = state.syncs[gate.id] ?? {};
    state.syncs[gate.id][session.id] = snap;
    state.syncHistory.push({ id: syncId, gate: gate.id, session: session.id, at: iso(at), quota: quotaGranted, revVersion: state.revVersion, permitCount: permits.length });
    gate.lastSyncAt = iso(at);
    commit();
    return {
      sync: snap,
      quotaNoteZh: `本次离线可用额度 ${quotaGranted}（同步时在场 ${occupancy}、其他闸机未用预留 ${reservedUnused}、容量 ${zone.capacity}、可分配 ${distributable}）。多台闸机不会各自拿到全部剩余额度。`,
      offlineNoteZh: `闸机 ${gate.id} 离线后仅可在 ${snap.offlineUntil} 前、且在额度 ${quotaGranted} 内按此快照放行；超过短期有效窗必须停止放行。`,
    };
  }

  function quotaUsed(syncId) {
    return state.events.filter(e => e.syncId === syncId && e.type === 'enter' && (e.status === 'applied')).length;
  }

  function gateCoverage(gateId, query = {}) {
    const gate = findGate(gateId);
    const at = parseTime(query.at) ?? now();
    const bySession = state.syncs[gate.id] ?? {};
    const sessions = query.session ? [query.session] : Object.keys(bySession);
    const snapshots = sessions.map(sid => bySession[sid]).filter(Boolean).map(snap => decorateCoverage(snap, at));
    const latest = query.session ? bySession[query.session] : Object.values(bySession).sort((a, b) => ms(b.syncedAt) - ms(a.syncedAt))[0];
    return {
      gate: gate.id, zone: gate.zone, mode: gate.mode,
      currentRevVersion: state.revVersion,
      lastSyncAt: latest?.syncedAt ?? gate.lastSyncAt ?? null,
      snapshots,
      summaryZh: snapshots[0]?.coverageZh ?? `闸机 ${gate.id} 从未同步许可与撤销；离线时没有可用许可。在线时由服务端按最新状态拦截。`,
    };
  }

  function decorateCoverage(snap, at) {
    const pendingRevocations = state.revocations.filter(r => r.revVersion > snap.revVersionAtSync);
    const oldPermitRevocations = pendingRevocations.filter(r =>
      r.kind === 'badge'
        ? snap.permits.some(p => p.person === r.person && p.badgeGeneration === r.generation)
        : snap.permits.some(p => p.person === r.person && p.zone === r.zone && p.session === r.session));
    const windowActive = at.getTime() <= ms(snap.offlineUntil);
    const used = quotaUsed(snap.id);
    const covered = pendingRevocations.length === 0;
    const mayStillHonorOldPermit = gateModeIsOffline(snap.gate) ? (oldPermitRevocations.length > 0 && windowActive) : false;
    // 即使闸机当前标记 online，只要未重新同步，撤销覆盖仍显示缺口；在线中央决策会立即拒绝。
    const onlineCentralEnforces = true;
    let coverageZh;
    if (covered) {
      coverageZh = `闸机 ${snap.gate} 的 ${snap.id} 快照已包含到第 ${snap.revVersionAtSync} 版为止的全部撤销；重新联网同步后旧证必被拒。`;
    } else {
      coverageZh = `闸机 ${snap.gate} 的快照停留在撤销版本 ${snap.revVersionAtSync}，有 ${pendingRevocations.length} 条新撤销未同步，其中 ${oldPermitRevocations.length} 条对应其快照中的许可；` +
        (windowActive
          ? `若闸机处于离线状态，在 ${snap.offlineUntil} 前仍可能按旧许可放行（不能声称已全场撤销），超过该窗口必须停止放行。`
          : `离线有效窗已于 ${snap.offlineUntil} 截止，闸机应已停止离线放行；重新同步后按最新撤销拒绝。`);
    }
    return {
      syncId: snap.id, session: snap.session, zone: snap.zone,
      syncedAt: snap.syncedAt, offlineUntil: snap.offlineUntil, windowActive,
      revVersionAtSync: snap.revVersionAtSync,
      currentRevVersion: state.revVersion,
      covered,
      pendingRevocations,
      affectedPermitRevocations: oldPermitRevocations,
      mayStillHonorOldPermit,
      onlineCentralEnforces,
      quota: { granted: snap.quota, used, remaining: Math.max(0, snap.quota - used) },
      partner: snap.partner,
      coverageZh,
    };
  }
  function gateModeIsOffline(gateId) {
    return state.gates.find(g => g.id === gateId)?.mode === 'offline';
  }

  function allSyncCoverage(query = {}) {
    const at = parseTime(query.at) ?? now();
    const gates = state.gates.map(g => gateCoverage(g.id, { ...query, at: query.at }));
    const revCoverage = state.revocations.slice().reverse().map(rev => {
      const perGate = state.gates.map(gate => {
        const snaps = Object.values(state.syncs[gate.id] ?? {});
        const snap = snaps.sort((a, b) => ms(b.syncedAt) - ms(a.syncedAt))[0];
        const included = snap ? snap.revVersionAtSync >= rev.revVersion : false;
        const windowActive = snap ? at.getTime() <= ms(snap.offlineUntil) : false;
        const heldPermit = snap?.permits.some(p => rev.kind === 'badge'
          ? p.person === rev.person && p.badgeGeneration === rev.generation
          : p.person === rev.person && p.zone === rev.zone && p.session === rev.session);
        return {
          gate: gate.id, zone: gate.zone, mode: gate.mode,
          syncedRevVersion: snap?.revVersionAtSync ?? 0,
          covered: included,
          mayStillHonor: !included && !!heldPermit && windowActive && gate.mode === 'offline',
          exposureUntil: !included && heldPermit ? snap?.offlineUntil ?? null : null,
        };
      });
      return {
        revocation: rev,
        gates: perGate,
        unSyncedGates: perGate.filter(g => !g.covered).map(g => g.gate),
        offlineExposedGates: perGate.filter(g => g.mayStillHonor).map(g => g.gate),
        globalRevokedZh: perGate.every(g => g.covered)
          ? `撤销 ${rev.id} 已同步覆盖全部闸机。`
          : `撤销 ${rev.id} 尚未覆盖：${perGate.filter(g => !g.covered).map(g => g.gate).join('、')}；` +
            `离线风险闸机：${perGate.filter(g => g.mayStillHonor).map(g => `${g.gate}(至 ${g.exposureUntil})`).join('、') || '无（离线窗已过或未持有该许可）'}。不能声称已全场撤销。`,
      };
    });
    return { at: iso(at), gates, revocations: revCoverage };
  }

  function setGateMode(gateId, input) {
    const gate = findGate(gateId);
    const actor = input.actorId ? actorOf(input.actorId) : null;
    if (actor) requireRole(actor, ['operations', 'zonechief']);
    if (!['online', 'offline'].includes(input.mode)) throw new HttpError(400, 'bad_mode', 'mode 必须是 online / offline');
    gate.mode = input.mode;
    gate.modeChangedAt = iso(parseTime(input.at) ?? now());
    commit();
    return gate;
  }

  function createGate(input) {
    const actor = actorOf(input.actorId);
    requireRole(actor, ['operations']);
    findZone(input.zone);
    const gate = { id: input.id ?? nextId('gate', 'GATE'), zone: input.zone, mode: input.mode ?? 'online' };
    if (state.gates.some(g => g.id === gate.id)) throw new HttpError(409, 'gate_exists');
    state.gates.push(gate);
    commit();
    return gate;
  }

  // ---------- 闸机事件接收（幂等、时钟核查、离线/在线判定） ----------
  function ingestEvent(input, options = {}) {
    // 兼容常见别名字段，降低现场对接歧义。
    input.gate ??= input.gateId;
    input.person ??= input.personId;
    input.badgeGeneration ??= input.generation;
    const rawKind = input.event ?? input.type ?? input.kind ?? input.action;
    input.event = { entry: 'enter', entrance: 'enter', in: 'enter', out: 'exit', leave: 'exit', egress: 'exit' }[rawKind] ?? rawKind;
    const gateId = input.gate;
    const gate = findGate(gateId);
    if (input.sequence === undefined || input.sequence === null || !Number.isFinite(Number(input.sequence))) {
      throw new HttpError(400, 'sequence_required', '事件必须带闸机序号 sequence；闸机流水按 gate+sequence 唯一');
    }
    const sequence = Number(input.sequence);
    const key = `${gateId}#${sequence}`;
    const fingerprint = JSON.stringify({
      person: input.person, badgeGeneration: Number(input.badgeGeneration),
      type: input.event ?? input.type, at: input.at, localSerial: input.localSerial ?? null,
    });
    if (state.eventIndex[key]) {
      const existing = state.events.find(e => e.id === state.eventIndex[key]);
      if (existing.fingerprint !== fingerprint) {
        throw new HttpError(409, 'sequence_conflict', '相同 gate+sequence 对应不同事件资料', { key });
      }
      return { httpStatus: 200, body: { duplicate: true, received: true, key, event: existing } };
    }
    findPerson(input.person);
    if (input.badgeGeneration === undefined || input.badgeGeneration === null) {
      throw new HttpError(400, 'generation_required', '事件必须带证件代次 badgeGeneration');
    }
    const type = input.event ?? input.type;
    if (!['enter', 'exit'].includes(type)) throw new HttpError(400, 'bad_event', 'event/type 必须是 enter / exit');
    const at = parseTime(input.at, '事件时间');
    if (!at) throw new HttpError(400, 'at_required', '事件必须带发生时间 at');
    const receivedAt = parseTime(input.receivedAt, '接收时间') ?? (options.receivedAt ? parseTime(options.receivedAt) : now());
    const skewSeconds = Math.abs(at.getTime() - receivedAt.getTime()) / 1000;
    const clockBad = skewSeconds > (state.protocol.clockToleranceSeconds ?? 30);

    const evt = {
      id: nextId('event', 'EVT'),
      key,
      gate: gateId,
      sequence,
      localSerial: input.localSerial ?? null,
      person: input.person,
      badgeGeneration: Number(input.badgeGeneration),
      type,
      at: iso(at),
      receivedAt: iso(receivedAt),
      skewSeconds,
      offline: !!input.offline,
      session: input.session ?? null,
      zone: gate.zone,
      status: 'received',
      decision: null,
      reasons: [],
      flags: [],
      syncId: null,
      fingerprint,
      createdAt: iso(now()),
    };
    state.events.push(evt);
    state.eventIndex[key] = evt.id;

    if (clockBad && input.force !== true) {
      evt.status = 'pending';
      evt.decision = 'pending_verification';
      evt.reasons = ['clock_skew'];
      commit();
      return { httpStatus: 202, body: { received: true, pending: true, code: 'clock_skew', event: evt } };
    }
    const result = decideStoredEvent(evt, { scan: options.scan === true });
    commit();
    return result;
  }

  function decideStoredEvent(evt, options = {}) {
    const at = new Date(evt.at);
    const gate = findGate(evt.gate);
    const session = resolveSession(evt.at, evt.session);
    evt.session = session?.id ?? evt.session;

    // 出场始终保留事实并允许通行离场，只做流水匹配，不做许可拦截。
    if (evt.type === 'exit') {
      const proj = replay({ until: new Date(at.getTime() + 1).toISOString() });
      const open = proj.stays[evt.person];
      evt.status = 'applied';
      evt.decision = 'allowed';
      if (!open) evt.flags.push('exit_without_entry');
      else if (open.zone !== evt.zone) evt.flags.push('exit_zone_mismatch');
      commit();
      return { httpStatus: 200, body: { received: true, allowed: true, decision: 'allowed', event: evt } };
    }

    // 入场：先做资格评估。
    const evaluation = evaluateEntry({
      person: evt.person, gate: evt.gate, zone: evt.zone,
      badgeGeneration: evt.badgeGeneration, at: evt.at, session: evt.session,
    });
    evt.reasons = [...evaluation.reasons];

    if (evt.offline || gate.mode === 'offline') {
      // 乱序补传：按事件时间重放“该事件之前”的状态，不依赖接收顺序。
      const before = replay({ until: new Date(at.getTime() - 1).toISOString() });
      const openStay = before.stays[evt.person] ?? null;
      const denyOffline = (code, extra = {}) => {
        evt.status = 'denied';
        evt.decision = 'denied';
        evt.reasons = Array.from(new Set([...evt.reasons, code]));
        Object.assign(evt, extra);
        commit();
        return { httpStatus: options.scan ? 403 : 200, body: { received: true, allowed: false, decision: 'denied', reasons: evt.reasons, reasonsZh: evt.reasons.map(r => REASON_ZH[r] ?? r), event: evt } };
      };
      const snap = state.syncs[gate.id]?.[session?.id];
      if (!snap) {
        return denyOffline('offline_snapshot_missing');
      }
      evt.syncId = snap.id;
      if (at.getTime() > ms(snap.offlineUntil)) {
        // 超过短期窗后闸机本应停止放行：记录保留为拒绝/异常，不计入在场。
        return denyOffline('offline_window_expired', { sync: { offlineUntil: snap.offlineUntil } });
      }
      const permittedAtSync = snap.permits.some(p => p.person === evt.person && p.badgeGeneration === evt.badgeGeneration);
      if (!permittedAtSync) {
        // 快照已包含对应撤销 → 同步后的离线闸机也应按最新撤销拒绝旧证。
        const knownRevocation = state.revocations.some(r =>
          r.revVersion <= snap.revVersionAtSync &&
          (r.kind === 'badge'
            ? (r.person === evt.person && r.generation === evt.badgeGeneration)
            : r.person === evt.person));
        return denyOffline(knownRevocation ? 'badge_generation_invalid' : 'offline_permit_absent');
      }
      // 时段是闸机本地时钟即可判定的条件：不在场次时段内，离线也不放行。
      if (evaluation.reasons.includes('outside_session')) {
        return denyOffline('outside_session');
      }
      // 快照内许可即闸机当时可执行的许可；中央最新撤销造成的不合格只加标记，
      // 不抹掉已经发生的入场事实。
      const usedBefore = state.events.filter(e => e.syncId === snap.id && e.type === 'enter' && e.id !== evt.id && e.status === 'applied').length;
      if (usedBefore >= snap.quota) {
        evt.flags.push('over_quota');
        evt.reasons.push('offline_quota_exceeded');
      }
      const staleRevs = state.revocations.filter(r => r.revVersion > snap.revVersionAtSync &&
        (r.kind === 'badge' ? (r.person === evt.person && r.generation === evt.badgeGeneration) : r.person === evt.person));
      if (staleRevs.length) evt.flags.push('revocation_not_synced');
      if (openStay && openStay.zone !== evt.zone) evt.flags.push('location_conflict');
      evt.status = 'applied';
      evt.decision = 'allowed_offline_snapshot';
      commit();
      return { httpStatus: 201, body: { received: true, allowed: true, offline: true, event: evt, quota: { granted: snap.quota, usedAfter: usedBefore + 1 } } };
    }

    // 在线闸机：以账本当前投影为准，“检查+落事件”在同一同步段完成，
    // Node 单线程保证多闸机并发时容量不会被各用一份全部余额。
    const live = currentProjection();
    const openStay = live.stays[evt.person] ?? null;
    if (openStay && openStay.zone === evt.zone) {
      evaluation.reasons.push('already_in_zone');
    } else if (openStay && openStay.zone !== evt.zone) {
      evaluation.reasons.push('location_conflict');
    }
    let occupancyNow = Object.values(live.stays).filter(s => s && s.zone === evt.zone && s.session === session?.id).length;
    // 未决跨区争议：核实前，对争议涉及且投影位置不在本区域的人员额外保留一个容量位，
    // 避免两个区域都把其当作“不在本场”而同时放行导致事实超员。
    for (const personId of new Set(live.anomalies
      .filter(a => a.status === 'open' && a.kind === 'location_conflict' && a.zones.includes(evt.zone))
      .map(a => a.person))) {
      if (live.stays[personId]?.zone !== evt.zone) occupancyNow += 1;
    }
    if (occupancyNow >= evaluation.zone.capacity && !openStay) {
      evaluation.reasons.push('capacity_full');
    }
    evt.reasons = Array.from(new Set(evaluation.reasons));
    if (evt.reasons.length) {
      evt.status = 'denied';
      evt.decision = 'denied';
      commit();
      const httpStatus = options.scan ? 403 : 200;
      return { httpStatus, body: { received: true, allowed: false, decision: 'denied', reasons: evt.reasons, reasonsZh: evt.reasons.map(r => REASON_ZH[r] ?? r), event: evt } };
    }
    evt.status = 'applied';
    evt.decision = 'allowed';
    commit();
    return { httpStatus: options.scan ? 200 : 201, body: { received: true, allowed: true, decision: 'allowed', event: evt } };
  }

  function verifyEvent(id, input) {
    const actor = actorOf(input.actorId);
    requireRole(actor, ['operations', 'zonechief']);
    const evt = state.events.find(e => e.id === id || e.key === id);
    if (!evt) throw new HttpError(404, 'event_not_found', `未找到事件 ${id}`);
    if (evt.status !== 'pending') throw new HttpError(409, 'not_pending', `事件状态为 ${evt.status}，无需待核实处理`);
    const at = parseTime(input.at) ?? now();
    state.verifications.push({
      id: nextId('verification', 'VRF'), kind: 'event_clock', event: evt.id,
      decision: input.decision, by: actor.id, at: iso(at), note: input.note ?? '',
    });
    if (input.decision === 'reject') {
      evt.status = 'rejected';
      evt.verifiedBy = actor.id; evt.verifiedAt = iso(at);
      commit();
      return { event: evt };
    }
    if (input.decision !== 'confirm') throw new HttpError(400, 'bad_decision', 'decision 必须为 confirm / reject');
    evt.clockVerified = true;
    evt.verifiedBy = actor.id; evt.verifiedAt = iso(at);
    const result = decideStoredEvent(evt);
    commit();
    return { event: result.body.event, result: result.body };
  }

  // ---------- sourceChanges：原始变更资料不自动生效，只提供显式办理入口 ----------
  function executeSourceChange(id, input = {}) {
    const sc = state.sourceChanges.find(c => c.id === id);
    if (!sc) throw new HttpError(404, 'source_change_not_found', `未找到来源变更 ${id}`);
    if (sc.processed && !input.force) throw new HttpError(409, 'already_processed', `来源变更 ${id} 已办理`, sc.processResult);
    let result;
    if (id === 'TRAIN-REVIEW' || ('training' in sc && 'decision' in sc && 'reviewer' in sc)) {
      result = reviewTraining(sc.training, { actorId: input.actor ?? sc.reviewer, decision: sc.decision, at: input.at });
    } else if (id === 'REPLACE-BADGE' || ('oldGeneration' in sc && 'newGeneration' in sc)) {
      result = reissueBadge({
        person: sc.person, oldGeneration: sc.oldGeneration, newGeneration: sc.newGeneration,
        reason: sc.reason, actorId: input.actor ?? 'credential', at: input.at,
      });
    } else if (id === 'DUTY-HANDOVER' || ('outgoing' in sc && 'incoming' in sc && 'duty' in sc)) {
      const rep = createReplacement({ dutyId: sc.duty, outgoing: sc.outgoing, incoming: sc.incoming, actorId: input.actor ?? 'operations', at: input.at });
      if (input.complete !== false && rep.checks.ready) {
        result = completeReplacement(rep.id, { actorId: input.actor ?? 'operations', at: input.completedAt ?? input.at });
      } else result = rep;
    } else if ('sequence' in sc && 'gate' in sc) {
      result = ingestEvent({
        gate: sc.gate, sequence: sc.sequence, person: sc.person,
        badgeGeneration: sc.badgeGeneration, event: sc.event, at: sc.at,
        receivedAt: input.receivedAt, offline: input.offline, localSerial: input.localSerial ?? sc.id,
      });
      result = result.body;
    } else {
      throw new HttpError(422, 'unknown_source_change', '不知道如何办理该来源变更，请改用标准 HTTP 操作');
    }
    sc.processed = true;
    sc.processedAt = iso(now());
    sc.processResult = JSON.parse(JSON.stringify(result ?? null));
    commit();
    return { sourceChange: sc, result };
  }

  function recordPartnerSubmission(nonce, info) {
    state.partnerSubmissions[nonce] = { nonce, ...info, at: iso(now()) };
    commit();
    return state.partnerSubmissions[nonce];
  }

  return {
    state, fixtures,
    save: commit,
    // helpers exposed for tests/checks
    currentProjection, presenceAt, openDisputes, listDisputes, isOnSite,
    quotaUsed, gateCoverage, allSyncCoverage, zoneOccupancy, personStatus, sessionStaffing,
    dutyEligibility,
    // operations
    createPerson, createZone, createSession, createDuty,
    createDeclaration, decideApplication, confirmIdentity,
    addTraining, reviewTraining, trainingSatisfied,
    createAssignment, approveAssignment, revokeAssignment, assignmentActiveAt,
    issueBadge, reissueBadge, revokeBadge, badgeView, generationValidAt,
    accessBasis, evaluateEntry,
    createReplacement, completeReplacement, cancelReplacement, replacementChecks,
    addGrant,
    releaseSession,
    gateSync, setGateMode, createGate,
    ingestEvent, verifyEvent, resolveDispute,
    executeSourceChange, recordPartnerSubmission,
    findPerson, findZone, findSession, findDuty, findGate, actorOf,
  };
}
