# 赛事工作证的岗位准入与闸机离线回传

本仓库保存该业务的合成登记资料、原始变更资料、本地闸机同步方协议服务，以及连接“代表团申报—身份确认—培训/岗位核准—按场次区域通行—闸机事件—在场投影”的 Node.js 业务服务。所有机构、人员、金额和文书均为虚构，不连接真实业务系统或真实门禁设备。

## 运行环境

使用 Node.js 22.23.4。没有第三方 npm 依赖，package-lock.json 锁定当前依赖清单。

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run check     # 中文端到端核对：换证、替班、离线迟到入场相遇
npm run demo      # 带合成演示数据的业务服务 + 中文核对台 /ui
npm start         # 业务服务，默认端口 4318
npm run start:all # 同时启动业务服务(4318)与合作方/闸机同步方(4317)
npm run start:partner
```

业务服务默认监听 4318 端口，`GET /health` 查询存活，`GET /` 返回接口清单，`GET /ui` 是中文核对台。`PORT` 可更换端口，`APP_STATE` 可指定业务持久状态文件，默认 `.local/app.json`；停止进程后用同一状态文件启动会保留全部流水与决定。`npm run demo` 使用 `.local/demo.json` 并预置争议、待核实事件与撤销缺口，`DEMO_RESET=1 npm run demo` 可重建。

完整 HTTP 接口、角色边界与“许可 ≠ 到场”的语义见 [docs/api.md](docs/api.md)。

### 一分钟本地核对

```bash
npm run check
```

该脚本在临时目录/随机端口启动业务服务与本地合作方，按剧本断言：同名身份不合并；媒体身份不能代替冰区培训；代表团不能批准后台岗位；替班在接班人具备资格并实际到岗前不能完成、原岗不撤；换证后旧证在线被拒但在场事实保留；多闸机额度不重叠、并发在线扫描不超员；撤销覆盖逐闸机显示缺口与离线风险时限；离线迟到记录先过时钟核查，再与新证跨区记录形成位置争议，原始流水不被接收顺序覆盖。

## Docker

```bash
docker build -t event-access:local .
docker run --rm -p 4317:4317 -p 4318:4318 event-access:local
```

容器内 `npm run start:all` 同时监听合作方 4317 与业务/核对台 4318（`http://127.0.0.1:4318/ui`）。


容器要保留状态时，将可写目录挂载到 /app/.local；该目录需允许容器 node 用户写入。测试使用临时目录与随机本地端口，可独立运行。

## 合作方协议服务

`npm run start:partner` 单独启动本地闸机同步方替身，默认 4317 端口，`GET /health` 可查询存活。`PORT` 更换端口，`PARTNER_STATE` 指定持久状态文件，默认 `.local/partner.json`。停止进程后用同一状态文件启动会保留合作方流水。协议见 [docs/partner.md](docs/partner.md)。业务服务在设置 `PARTNER_URL` 或使用 `start:all` 后可把同步批次转发给它。

## 资料

fixtures/records.json 是业务原始资料，sourceChanges 保存后续收到的变更或申请，均没有自动导入成已批准决定。fixtures/relations.json 声明登记资料的关联字段，docs/data.md 解释计量和身份语义。fixtures/partner.json 定义合作方接口名称及字段。support/peer.mjs 提供合作方行为，docs/partner.md 是实际协议；tests 检查该协议和资料关系。
