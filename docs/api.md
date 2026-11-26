# 业务 HTTP 接口与现场语义

零第三方依赖的 Node.js 服务。所有人员、证件、机构均为合成资料，只连接本地闸机协议替身，不接触真实门禁或设备。

## 1. 启动与核对

```bash
npm install        # 无第三方依赖；npm ci --ignore-scripts 亦可
npm test           # node:test 全套（含合作方协议与 15 个业务用例）
npm run check      # 中文剧本：换证 / 替班 / 离线迟到相遇 / 额度 / 撤销覆盖
npm run demo       # 带合成演示数据的服务（默认 http://127.0.0.1:4318/ui）
npm start          # 空业务服务，默认 PORT=4318，状态 APP_STATE=.local/app.json
npm run start:all  # 同时启动业务(4318)与本地闸机同步方(4317)
```

浏览器打开 `/ui` 是中文核对台：按人、按场次、按区域、按闸机查询，并可处理待核实事件与位置争议。

业务服务的所有路由同时支持 `/api/...` 与不带 `/api` 的同名路径（例如 `/api/events` 与 `/events` 等价）。操作人用请求头 `X-Actor: operations` 或请求体/查询参数 `actor` 传入；可用角色来自 `fixtures/records.json` 的 `actors`：

| actor | 角色 | 权限边界 |
| --- | --- | --- |
| `operations` | 组委会运营 | 身份确认、岗位核准/撤销、替班、放行、争议核实、闸机管理 |
| `credential` | 证件中心 | 身份确认、培训核准、发证/补发/挂失、申报核准 |
| `zone-chief` | Z-ICE 区域负责人 | 本区域岗位核准、替班完成、争议核实、闸机模式 |
| `delegation-a` | A 团 | 只能申报本团成员；**不能确认身份、不能批准任何岗位/后台通行** |

> 接口形式没有历史兼容约束；以上鉴权是本实现采用的合成规则。省略 actor 调用受保护操作会得到 `401 actor_required`。

## 2. 必须区分的六件事

1. **申报/申请（application）**：代表团、志愿者、媒体等主张，可以同一人有多份；收件不等于批准。
2. **身份（person.identityStatus）**：必须由 `credential`/`operations` 确认。两个“沈安”（PE-1、PE-2）永远是两个身份，**同名不合并**。
3. **资格（training）**：培训记录初始 `pending`，须独立核准；区域要求的培训必须在有效期内。媒体身份不能代替 `ice-safety` 培训。
4. **岗位（assignment）**：指派后 `pending_approval`，经 `operations`/`zone-chief` 核准才有效。资格审核与岗位审核互相独立，且**代表团不能批准自己的后台通行**。
5. **证件/许可（badge / permit）**：通行证关联本人与证件代次；补发新证后旧代次按时间点失效。“有许可”只说明证件/资格/岗位有效，**不代表人已到场**。
6. **实际到场（presence）**：只由闸机事件流水重放得到。换证、岗位撤销都不会删除已经发生的入场事实。

`GET /api/people/:id/status` 的 `summaryZh` 会同时给出“有效许可：…”与“实际到场：…”两句话。

## 3. 主要操作

### 3.1 申报与身份

- `POST /api/declarations`：`{category, personId? , person?:{name,delegation}, delegation?, claims?}`。不给 `personId` 时一律新建独立身份（即使同名）。`delegation` 角色只能申报本团。
- `GET /api/applications`
- `POST /api/applications/:id/decision`：`{decision:"approve"|"reject"}`（credential/operations）。
- `GET /api/people` / `GET /api/people/:id`
- `POST /api/people`：`{id?,name,delegation}`（credential/operations）。
- `POST /api/people/:id/confirm-identity`
- `GET /api/people/:id/status?at=ISO&session=SS-1`：有效权限、证件代次、实际位置、争议、最近事件。
- `GET /api/people/:id/duty?date=YYYY-MM-DD`（或 `GET /api/duty?person=&date=`）：**某人今天是否可以值勤**，返回 `canDuty`、缺口原因中文与 `currentlyOnSite`。

### 3.2 培训与岗位核准

- `GET/POST /api/training`，`POST /api/training/:id/review`：`{decision:"allow"|"deny"}`。
- `GET/POST /api/assignments`：`{person,dutyId,role}`（或 `zone+session+role`）。
- `POST /api/assignments/:id/approve` / `.../revoke`。撤销会产生一条 `kind:"access"` 的撤销版本，必须同步到闸机。

### 3.3 替班（不先撤岗）

- `POST /api/replacements`：`{duty|dutyId, outgoing, incoming, at?}`。立即计算 `checks`：
  - `qualified`：身份 + 区域培训 + 已核准有效岗位；
  - `arrived`：按事件流水，接班人**确定地**在该区域（争议中的推定位置不算到岗）；
  - `ready = qualified && arrived`，单据状态为 `ready | awaiting_arrival | blocked`。
- `POST /api/replacements/:id/complete`：完成瞬间重新核对；资格不足 `422 not_qualified`，未到岗 `409 incoming_not_on_site`，且**出班人岗位保持不变**。成功时才原子地结束出班指派、确认接班指派。
- `POST /api/replacements/:id/cancel`
- `POST /api/duties/:id/replace`：建单并在 `ready` 时一步完成，否则 `409` 且 `details.replacement` 保留替班单。
- `GET /api/sessions/:id/staffing?at=`：每个核心岗位的最低人数、有效指派/合格/确定到岗/争议到岗，以及 `allCorePostsMet`、`releaseAllowed`。
- `POST /api/sessions/:id/release`：最低在岗不足时 `409 core_posts_short`，约束下一场放行。

### 3.4 发证、补发、挂失

- `POST /api/badges/issue`：`{person, at?}`，身份未确认返回 `422 identity_unconfirmed`。
- `POST /api/badges/reissue`（别名 `/api/badges/replace`）：`{person, reason?, oldGeneration?, newGeneration?, at?}`。旧代次立即记撤销并递增 `revVersion`，新代次生效；响应明确 `presenceUnaffectedZh`。
- `POST /api/badges/revoke`（别名 `/api/badges/loss`）：`{person, generation?, reason?, at?}`。
- `GET /api/badges/:person`

权限/入场试算（不落流水）：`POST /api/access/evaluate`，body 可含 `person,gate,zone,session,badgeGeneration,at`；返回 `allowed / reasons / reasonsZh / checks`。

### 3.5 闸机同步、明确额度与撤销覆盖

- `GET/POST /api/gates`；`GET /api/gates/:id`；`POST /api/gates/:id/mode`：`{mode:"online"|"offline"}`。
- `POST /api/gates/:id/sync?forward=partner`：生成该闸机在本区域+场次的离线许可快照：
  - `permits[]`：只含**同步时刻**有效的许可与当时有效证件代次；
  - `revVersionAtSync`：同步时的撤销版本；
  - `offlineUntil = syncedAt + protocol.offlineWindowSeconds`（夹具为 120 秒）；
  - `quota`：**明确分配给这台闸机的离线可用额度**。

额度分配：`可分配 = 容量 - 当前实际在场 - 其他闸机有效快照中尚未使用的预留额度`。因此容量 6、场内 0 时，第一台要 6 得 6，第二台只能得 0；不会出现“每台都按全部剩余放行”。离线实际入场超过本闸机额度时，事件保留且打 `over_quota`，**不依赖联网补账把已发生的人抹掉**；区域视图据此给出超员与建议离场名单。

- `GET /api/gates/:id/sync?at=`（别名 `/coverage`、`/revocations`）：该闸机快照、未同步撤销、额度用量、`windowActive`、`mayStillHonorOldPermit` 与中文 `coverageZh`。
- `GET /api/sync-coverage?at=`（别名 `/api/revocations/coverage`、`/api/gates/coverage/all`）：每条撤销 × 每台闸机的覆盖矩阵，给出 `unSyncedGates`、`offlineExposedGates`、`exposureUntil` 与 `globalRevokedZh`。存在离线缺口时文案明确“**不能声称已全场撤销**”。

传播规则：

- **在线闸机**：中央按最新状态决定，旧证/已撤岗位立即 `403`。
- **离线闸机**：只认最后同步快照；事件时间超过 `offlineUntil` 一律拒绝（`offline_window_expired`）。
- **重新同步后的离线闸机**：快照已含对应撤销，旧代次事件按 `badge_generation_invalid` 拒绝。
- 新撤销尚未同步到的离线闸机：覆盖接口列出其在 `offlineUntil` 前“仍可能持有旧许可”的风险时限；窗口过后闸机本身也必须停止离线放行。

若启动时设置 `PARTNER_URL=http://127.0.0.1:4317`（或用 `npm run start:all`），同步带 `forward=partner` 时会按 `docs/partner.md` 以 `Sync-Nonce: biz-SYNC-n` 把许可项投递给本地合作方，并把受理结果写入快照与 `GET /api/partner/submissions`。

### 3.6 事件接收、幂等、时钟与争议

- `POST /api/events`：单条；`POST /api/events/batch`：`{events:[]}`；`POST /api/gates/:id/events`；实时扫描语义 `POST /api/gates/:id/scan`（拒绝时直接 `403`）。
- 事件字段：

```json
{
  "gate": "GATE-A",
  "sequence": 1,
  "localSerial": "LOCAL-JOURNAL-0001",
  "person": "PE-1",
  "badgeGeneration": 1,
  "event": "enter",
  "at": "2026-11-28T00:01:00Z",
  "receivedAt": "2026-11-28T00:03:30Z",
  "offline": true
}
```

- **幂等**：闸机流水按 `gate + sequence` 唯一。同键同资料重发返回 `200 {duplicate:true}`，不重复计人；同键不同资料 `409`。
- **时钟**：`|at - receivedAt| > clockToleranceSeconds`（夹具 30 秒）→ `202 pending / clock_skew`，暂不计人；`GET /api/events?status=pending`，`POST /api/events/:id/verify`：`{decision:"confirm"|"reject"}`（operations/zone-chief）。`receivedAt` 缺省取服务端当前时间；显式传入仅用于本地剧本/回放。
- **入场核对**：身份、培训、当前有效岗位/类别依据、场次时段（严格按 start–end；如确有赛前预备入场需要，可在状态/资料中设置 `entryLeadSeconds`）、证件代次在事件时刻是否有效、是否已在该区域、容量。
- **在场投影**：不可变事件按**事件时间**（再以接收时间、ID 兜底）重放，不按接收顺序替换事实。
  - 同区重复入场 → `already_in_zone`，不重复计数；
  - 未出场又在另一区域入场 → 两条原始记录都保留，生成 `location_conflict` 争议；投影给一个按事件时间更晚者的**推定位置**（`presumed:true`），两个区域都能在 `disputedClaims` 看到争议；
  - 出场按“人 + 区域”匹配：错区出场打 `exit_zone_mismatch` 并生成争议，**不反向扣减另一个区域总数**；无入场的出场打 `exit_without_entry`；
  - `GET /api/disputes`，`POST /api/disputes/:key/resolve`：`{decision:"actual_location", actualZone, voidEventIds?, note?}`。核实结论只把冲突事件标记 `voided` 并移出投影，**原始事件仍可在 `GET /api/events` 查到**。
- `GET /api/events?person=&gate=&status=`、`GET /api/events/:id`。

### 3.7 区域与场次视图

- `GET /api/zones/:id/occupancy?session=SS-1&at=`：`insideCount`（实际人数）、`capacity`、`remaining`、`overCapacityBy`、`people[]`（入场时间/闸机/是否推定/当前许可是否有效/原因）、`disputedClaims`、`mustLeave[]` 与 `summaryZh`。超员时按最晚入场给出建议超员候选（策略透明，可由负责人调整）。
- `GET /api/sessions/:id/staffing`：见 3.3。

### 3.8 原始 sourceChanges 的办理

`fixtures/records.json` 的 `sourceChanges` 只是待办原料，启动后 `processed:false`，不会自动变成决定。可显式办理：

- `GET /api/source-changes`
- `POST /api/source-changes/:id/execute`：按编号映射到标准操作（`TRAIN-REVIEW`→培训核准；`REPLACE-BADGE`→补发；`DUTY-HANDOVER`→替班单；`GATE-OLD/GATE-NEW`→事件入库），可在 body 传 `actor/at/receivedAt` 等。重复办理默认 `409`。

## 4. 持久化与测试可信度

- 业务状态是单个 JSON 文件（`APP_STATE`，默认 `.local/app.json`），写入采用临时文件 + rename 的原子替换；重启保留全部流水与决定。
- `npm test` 每个用例使用临时目录与随机端口；`npm run check` 端到端跑通规定的三个过程并断言：
  - 换证后旧证在线被拒、在场人数不变；
  - 接班人资格/到岗不满足时替班 `409` 且原岗仍 active，到岗后交接、岗位齐备；
  - 离线迟到旧记录先因时钟偏差待核实，确认后与新证跨区记录形成争议，两种接收顺序得到相同的事件时间投影与争议区域，核实后定位、错区出场不扣数；
  - 十台并发扫描恰好放行容量数；两台闸机的离线额度不重叠；
  - 撤销矩阵正确区分在线立即覆盖与离线暴露时限；同步转发合作方得到 202 受理。
