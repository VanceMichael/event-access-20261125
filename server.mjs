// 赛事工作证业务 HTTP 服务（零第三方依赖）。
// 同时导出 createServer，便于 node:test 以随机端口或直接 listen 使用。
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createCore, HttpError, REASON_ZH } from './core.mjs';

const API_INDEX = {
  service: 'event-access-business',
  descriptionZh: '代表团申报、岗位/培训核准、替班、发补证、按场次区域通行、闸机同步与事件接收。许可与实际到场严格区分。',
  endpoints: [
    'GET  /health',
    'GET  /api/actors',
    'POST /api/declarations                代表团/志愿者/媒体申报（同名不合并）',
    'GET  /api/applications',
    'POST /api/applications/:id/decision   有权人员核准申请',
    'POST /api/people                      新建独立身份',
    'GET  /api/people',
    'GET  /api/people/:id',
    'POST /api/people/:id/confirm-identity 确认身份',
    'GET  /api/people/:id/status?at=&session=  按人查有效许可、实际位置与争议',
    'GET  /api/people/:id/duty?date=YYYY-MM-DD  某人今天是否可以值勤（资格，不等同到场）',
    'GET  /api/training ; POST /api/training ; POST /api/training/:id/review',
    'GET/POST /api/assignments ; POST /api/assignments/:id/approve|revoke',
    'GET/POST /api/replacements ; POST /api/replacements/:id/complete|cancel',
    'POST /api/duties/:id/replace          一步替班（资格+到岗不满足则 409，原岗不动）',
    'POST /api/badges/issue|reissue|revoke ; GET /api/badges/:person',
    'POST /api/access/evaluate ; GET /api/access ; POST /api/access/grants',
    'GET/POST /api/gates ; GET /api/gates/:id ; POST /api/gates/:id/mode',
    'POST /api/gates/:id/sync              生成离线许可快照、撤销版本与明确额度（可 ?forward=partner）',
    'GET  /api/gates/:id/sync              按闸机查同步与撤销覆盖',
    'GET  /api/sync-coverage               全部闸机 × 撤销覆盖矩阵',
    'GET  /api/revocations',
    'POST /api/events                      接收闸机事件（gate+sequence 幂等）',
    'POST /api/events/batch',
    'POST /api/gates/:id/scan              实时闸机核验（拒绝时 HTTP 403）',
    'GET  /api/events ; GET /api/events/:id ; POST /api/events/:id/verify',
    'GET  /api/disputes ; POST /api/disputes/:key/resolve',
    'GET  /api/zones ; GET /api/zones/:id/occupancy?session=&at=',
    'GET  /api/sessions ; GET /api/sessions/:id/staffing ; POST /api/sessions/:id/release',
    'GET  /api/source-changes ; POST /api/source-changes/:id/execute',
    'GET  /ui                               本地中文核对台',
  ],
  reasonZh: REASON_ZH,
};

export function createServer(options = {}, maybeStateFile) {
  // 兼容 createServer(stateFile) 与 createServer(fixtures, stateFile) 的习惯。
  if (typeof options === 'string') options = { stateFile: options };
  else if (options && Array.isArray(options.people)) {
    options = {
      fixtures: options,
      ...(typeof maybeStateFile === 'string' ? { stateFile: maybeStateFile } : (maybeStateFile ?? {})),
    };
  }
  const core = createCore(options);
  const partnerUrl = options.partnerUrl ?? process.env.PARTNER_URL ?? null;

  async function forwardToPartner(snap) {
    if (!partnerUrl) return null;
    const itemsAll = snap.permits.length ? snap.permits : [{
      syncRequest: `${snap.id}-empty`, person: null, zone: snap.zone, session: snap.session, note: 'no-permits',
    }];
    const chunks = [];
    for (let i = 0; i < itemsAll.length; i += 100) chunks.push(itemsAll.slice(i, i + 100));
    const results = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const nonce = `biz-${snap.id}${chunks.length > 1 ? `-p${i}` : ''}`;
      let response; let httpStatus; let text;
      try {
        response = await fetch(`${partnerUrl.replace(/\/$/, '')}/gate/syncs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Sync-Nonce': nonce },
          body: JSON.stringify({ permits: chunks[i] }),
          signal: AbortSignal.timeout(4000),
        });
        httpStatus = response.status;
        text = await response.text();
        let json = null; try { json = JSON.parse(text); } catch { json = { raw: text }; }
        core.recordPartnerSubmission(nonce, { target: partnerUrl, httpStatus, response: json });
        results.push({ nonce, httpStatus, response: json });
      } catch (error) {
        core.recordPartnerSubmission(nonce, { target: partnerUrl, httpStatus: 0, error: error.message });
        results.push({ nonce, httpStatus: 0, error: error.message });
      }
    }
    snap.partner = { forwarded: true, target: partnerUrl, results };
    core.save();
    return snap.partner;
  }

  const routes = [];
  const add = (method, pattern, handler) => routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });

  function matchRoute(method, pathname) {
    const seg = pathname.split('/').filter(Boolean);
    outer: for (const r of routes) {
      if (r.method !== method || r.segments.length !== seg.length) continue;
      const params = {};
      for (let i = 0; i < seg.length; i += 1) {
        const spec = r.segments[i];
        if (spec.startsWith(':')) params[spec.slice(1)] = decodeURIComponent(seg[i]);
        else if (spec !== seg[i]) continue outer;
      }
      return { route: r, params };
    }
    return null;
  }

  const actor = ctx => ctx.headers['x-actor'] || ctx.body?.actor || ctx.query.get('actor') || null;

  // ---------- 元信息 ----------
  add('GET', '/health', () => ({ status: 'ok', service: API_INDEX.service, time: new Date().toISOString() }));
  add('GET', '/', () => API_INDEX);
  add('GET', '/actors', ctx => core.state.actors);
  add('GET', '/protocol', () => core.state.protocol);

  // ---------- 申报 / 身份 ----------
  add('POST', '/declarations', ctx => core.createDeclaration({ ...ctx.body, actorId: actor(ctx) }));
  add('POST', '/delegations/declare', ctx => core.createDeclaration({ ...ctx.body, actorId: actor(ctx) }));
  add('POST', '/delegations/declarations', ctx => core.createDeclaration({ ...ctx.body, actorId: actor(ctx) }));
  add('GET', '/applications', () => core.state.applications);
  add('POST', '/applications/:id/decision', ctx =>
    core.decideApplication(ctx.params.id, { ...ctx.body, actorId: actor(ctx), decision: ctx.body.decision }));
  add('POST', '/people', ctx => core.createPerson({ ...ctx.body, actorId: actor(ctx) }));
  add('GET', '/people', () => core.state.people);
  add('GET', '/people/:id', ctx => core.findPerson(ctx.params.id));
  add('POST', '/people/:id/confirm-identity', ctx => core.confirmIdentity(ctx.params.id, { ...ctx.body, actorId: actor(ctx) }));
  add('POST', '/people/:id/identity/confirm', ctx => core.confirmIdentity(ctx.params.id, { ...ctx.body, actorId: actor(ctx) }));
  add('GET', '/people/:id/status', ctx => core.personStatus(ctx.params.id, Object.fromEntries(ctx.query)));
  add('GET', '/people/:id/permissions', ctx => core.personStatus(ctx.params.id, Object.fromEntries(ctx.query)));
  add('GET', '/people/:id/access', ctx => core.personStatus(ctx.params.id, Object.fromEntries(ctx.query)));
  add('GET', '/people/:id/location', ctx => core.personStatus(ctx.params.id, Object.fromEntries(ctx.query)));
  add('GET', '/people/:id/duty', ctx => core.dutyEligibility(ctx.params.id, ctx.query.get('date') ?? undefined));
  add('GET', '/duty', ctx => {
    const person = ctx.query.get('person');
    if (!person) throw new HttpError(400, 'missing_person', '需要 person 参数');
    return core.dutyEligibility(person, ctx.query.get('date') ?? undefined);
  });

  // ---------- 培训 ----------
  add('GET', '/training', () => core.state.training);
  add('POST', '/training', ctx => core.addTraining(ctx.body));
  add('POST', '/training/:id/review', ctx => core.reviewTraining(ctx.params.id, { ...ctx.body, actorId: actor(ctx) }));

  // ---------- 岗位 ----------
  add('GET', '/assignments', () => core.state.assignments);
  add('POST', '/assignments', ctx => core.createAssignment({ ...ctx.body, actorId: actor(ctx) }));
  add('POST', '/assignments/:id/approve', ctx => core.approveAssignment(ctx.params.id, { ...ctx.body, actorId: actor(ctx) }));
  add('POST', '/assignments/:id/revoke', ctx => core.revokeAssignment(ctx.params.id, { ...ctx.body, actorId: actor(ctx) }));

  // ---------- 替班 ----------
  add('GET', '/replacements', () => core.state.replacements);
  add('POST', '/replacements', ctx => core.createReplacement({ ...ctx.body, actorId: actor(ctx) }));
  add('POST', '/replacements/:id/complete', ctx => core.completeReplacement(ctx.params.id, { ...ctx.body, actorId: actor(ctx) }));
  add('POST', '/replacements/:id/cancel', ctx => core.cancelReplacement(ctx.params.id, { ...ctx.body, actorId: actor(ctx) }));
  add('POST', '/duties/:id/replace', ctx => {
    const rep = core.createReplacement({ ...ctx.body, dutyId: ctx.params.id, actorId: actor(ctx) });
    if (rep.status === 'ready' && ctx.body.complete !== false) {
      return core.completeReplacement(rep.id, { ...ctx.body, actorId: actor(ctx) });
    }
    const error = new HttpError(409, rep.status === 'blocked' ? 'not_qualified' : 'incoming_not_on_site',
      '替班尚未满足完成条件，原岗位保持不变；满足后调用 /replacements/' + rep.id + '/complete', rep.checks);
    error.details = { replacement: rep, checks: rep.checks };
    throw error;
  });

  // ---------- 证件 ----------
  add('POST', '/badges/issue', ctx => core.issueBadge({ ...ctx.body, actorId: actor(ctx) }));
  add('POST', '/badges/reissue', ctx => core.reissueBadge({ ...ctx.body, actorId: actor(ctx) }));
  add('POST', '/badges/replace', ctx => core.reissueBadge({ ...ctx.body, actorId: actor(ctx) }));
  add('POST', '/badges/revoke', ctx => core.revokeBadge({ ...ctx.body, actorId: actor(ctx) }));
  add('POST', '/badges/loss', ctx => core.revokeBadge({ ...ctx.body, reason: ctx.body.reason ?? '挂失', actorId: actor(ctx) }));
  add('GET', '/badges', ctx => ctx.query.get('person') ? core.badgeView(ctx.query.get('person')) : Object.values(core.state.badges));
  add('GET', '/badges/:person', ctx => core.badgeView(ctx.params.person) ?? (() => { throw new HttpError(404, 'badge_not_found', '该人员尚无通行证'); })());

  // ---------- 权限评估 / 额外授权 ----------
  add('POST', '/access/evaluate', ctx => {
    const result = core.evaluateEntry(ctx.body);
    return {
      allowed: result.allowed,
      reasons: result.reasons,
      reasonsZh: result.reasons.map(r => REASON_ZH[r] ?? r),
      at: result.at, zone: result.zone.id, session: result.session?.id ?? null,
      checks: result.checks,
    };
  });
  add('GET', '/access', ctx => {
    const q = Object.fromEntries(ctx.query);
    if (!q.person || !q.zone || !q.session) throw new HttpError(400, 'missing_params', '需要 person、zone、session');
    const at = q.at ? new Date(q.at) : new Date();
    return core.accessBasis(core.findPerson(q.person), core.findZone(q.zone), core.findSession(q.session), at);
  });
  add('POST', '/access/grants', ctx => core.addGrant({ ...ctx.body, actorId: actor(ctx) }));

  // ---------- 闸机与同步 ----------
  add('GET', '/gates', () => core.state.gates);
  add('POST', '/gates', ctx => core.createGate({ ...ctx.body, actorId: actor(ctx) }));
  add('GET', '/gates/:id', ctx => core.findGate(ctx.params.id));
  add('POST', '/gates/:id/mode', ctx => core.setGateMode(ctx.params.id, { ...ctx.body, actorId: actor(ctx) }));
  add('POST', '/gates/:id/sync', async ctx => {
    const result = core.gateSync(ctx.params.id, { ...ctx.body, actorId: actor(ctx) });
    if (ctx.query.get('forward') === 'partner' || ctx.body.forward === true || (ctx.body.forward === undefined && partnerUrl && options.autoForwardPartner)) {
      await forwardToPartner(result.sync);
    }
    return result;
  });
  add('GET', '/gates/:id/sync', ctx => core.gateCoverage(ctx.params.id, Object.fromEntries(ctx.query)));
  add('GET', '/gates/:id/sync-status', ctx => core.gateCoverage(ctx.params.id, Object.fromEntries(ctx.query)));
  add('GET', '/gates/:id/coverage', ctx => core.gateCoverage(ctx.params.id, Object.fromEntries(ctx.query)));
  add('GET', '/gates/:id/revocations', ctx => core.gateCoverage(ctx.params.id, Object.fromEntries(ctx.query)));
  add('GET', '/gates/:id/events', ctx => core.state.events.filter(e => e.gate === ctx.params.id));
  add('GET', '/sync-coverage', ctx => core.allSyncCoverage(Object.fromEntries(ctx.query)));
  add('GET', '/gates/coverage/all', ctx => core.allSyncCoverage(Object.fromEntries(ctx.query)));
  add('GET', '/revocations/coverage', ctx => core.allSyncCoverage(Object.fromEntries(ctx.query)));
  add('GET', '/revocations', () => core.state.revocations);
  add('POST', '/gate/syncs', async ctx => {
    if (!ctx.body.gate) throw new HttpError(400, 'gate_required', '业务同步需要 gate 字段；合作方 /gate/syncs 协议由 support/peer.mjs 提供');
    const result = core.gateSync(ctx.body.gate, { ...ctx.body, actorId: actor(ctx) });
    if (ctx.body.forward === true || ctx.query.get('forward') === 'partner') await forwardToPartner(result.sync);
    return result;
  });
  add('POST', '/access/sync', async ctx => {
    if (!ctx.body.gate) throw new HttpError(400, 'gate_required', '需要 gate 字段');
    const result = core.gateSync(ctx.body.gate, { ...ctx.body, actorId: actor(ctx) });
    if (ctx.body.forward === true || ctx.query.get('forward') === 'partner') await forwardToPartner(result.sync);
    return result;
  });

  // ---------- 事件 ----------
  add('POST', '/events', ctx => core.ingestEvent(ctx.body));
  add('POST', '/gate/events', ctx => core.ingestEvent(ctx.body));
  add('POST', '/events/batch', ctx => {
    const list = ctx.body.events;
    if (!Array.isArray(list)) throw new HttpError(400, 'events_required', '需要 events 数组');
    return { results: list.map(e => core.ingestEvent(e)) };
  });
  add('POST', '/gates/:id/events', ctx => core.ingestEvent({ ...ctx.body, gate: ctx.params.id }));
  add('POST', '/gates/:id/scan', ctx => core.ingestEvent({ ...ctx.body, gate: ctx.params.id }, { scan: true }));
  add('GET', '/events', ctx => {
    let rows = core.state.events;
    if (ctx.query.get('status')) rows = rows.filter(e => e.status === ctx.query.get('status'));
    if (ctx.query.get('person')) rows = rows.filter(e => e.person === ctx.query.get('person'));
    if (ctx.query.get('gate')) rows = rows.filter(e => e.gate === ctx.query.get('gate'));
    return rows;
  });
  add('GET', '/events/:id', ctx => {
    const e = core.state.events.find(x => x.id === ctx.params.id || x.key === ctx.params.id);
    if (!e) throw new HttpError(404, 'event_not_found');
    return e;
  });
  add('POST', '/events/:id/verify', ctx => core.verifyEvent(ctx.params.id, { ...ctx.body, actorId: actor(ctx) }));

  // ---------- 争议 / 待核实 ----------
  add('GET', '/disputes', () => core.listDisputes());
  add('POST', '/disputes/:key/resolve', ctx =>
    core.resolveDispute(ctx.params.key, { ...ctx.body, actorId: actor(ctx) }));

  // ---------- 区域容量 ----------
  add('GET', '/zones', () => core.state.zones);
  add('POST', '/zones', ctx => core.createZone({ ...ctx.body, actorId: actor(ctx) }));
  add('GET', '/zones/:id/occupancy', ctx => core.zoneOccupancy(ctx.params.id, Object.fromEntries(ctx.query)));
  add('GET', '/zones/:id/presence', ctx => core.zoneOccupancy(ctx.params.id, Object.fromEntries(ctx.query)));

  // ---------- 场次 / 岗位齐备 / 放行 ----------
  add('GET', '/sessions', () => core.state.sessions);
  add('POST', '/sessions', ctx => core.createSession({ ...ctx.body, actorId: actor(ctx) }));
  add('POST', '/duties', ctx => core.createDuty({ ...ctx.body, actorId: actor(ctx) }));
  add('GET', '/sessions/:id', ctx => core.findSession(ctx.params.id));
  add('GET', '/sessions/:id/staffing', ctx => core.sessionStaffing(ctx.params.id, Object.fromEntries(ctx.query)));
  add('GET', '/sessions/:id/positions', ctx => core.sessionStaffing(ctx.params.id, Object.fromEntries(ctx.query)));
  add('POST', '/sessions/:id/release', ctx => core.releaseSession(ctx.params.id, { ...ctx.body, actorId: actor(ctx) }));

  // ---------- 原始变更资料办理 ----------
  add('GET', '/source-changes', () => core.state.sourceChanges);
  add('POST', '/source-changes/:id/execute', ctx => core.executeSourceChange(ctx.params.id, ctx.body ?? {}));

  // ---------- 合作方协议代理查询 ----------
  add('GET', '/partner/submissions', () => core.state.partnerSubmissions);
  add('GET', '/partner/items/:syncRequest', async ctx => {
    if (!partnerUrl) throw new HttpError(400, 'partner_not_configured', '未配置 PARTNER_URL');
    const resp = await fetch(`${partnerUrl.replace(/\/$/, '')}/gate/syncs/${encodeURIComponent(ctx.params.syncRequest)}`);
    const text = await resp.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { httpStatus: resp.status, body: json };
  });

  const server = createHttpServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Actor, Sync-Nonce');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && (url.pathname === '/ui' || url.pathname === '/ui/' || url.pathname === '/index.html')) {
        const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 4 * 1024 * 1024) return send(413, { error: '请求体过大' });
      }
      let body = {};
      if (raw) {
        try { body = JSON.parse(raw); } catch { return send(400, { error: 'JSON 格式不符' }); }
      }
      let pathname = url.pathname;
      if (pathname.startsWith('/api/')) pathname = pathname.slice(4);
      else if (pathname === '/api') pathname = '/';
      const matched = matchRoute(req.method, pathname);
      if (!matched) return send(404, { error: '没有对应的业务接口', path: url.pathname, hint: 'GET / 查看接口清单，GET /ui 打开核对台' });
      const ctx = {
        params: matched.params, query: url.searchParams, body,
        headers: req.headers, core,
      };
      const out = await matched.route.handler(ctx);
      // 核心事件接口自带 httpStatus
      if (out && typeof out === 'object' && 'httpStatus' in out && 'body' in out) {
        return send(out.httpStatus, out.body);
      }
      return send(req.method === 'POST' ? 201 : 200, out);
    } catch (error) {
      if (error instanceof HttpError) {
        return send(error.status, { error: error.message, code: error.code, details: error.details });
      }
      console.error(error);
      return send(500, { error: '业务服务内部错误', message: error.message });
    }
  });

  server.core = core;
  server.API_INDEX = API_INDEX;
  return server;
}

// 兼容多种可能的引用习惯。
export const createApp = createServer;
export const createBusinessServer = createServer;
export const createBusiness = createServer;
export const createService = createServer;
export default createServer;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4318);
  const host = process.env.HOST ?? '0.0.0.0';
  const stateFile = process.env.APP_STATE ?? '.local/app.json';
  const server = createServer({ stateFile });
  server.listen(port, host, () => {
    console.log(JSON.stringify({
      message: '赛事工作证业务服务已启动', port, host, stateFile,
      ui: `http://127.0.0.1:${port}/ui`,
    }));
  });
}
