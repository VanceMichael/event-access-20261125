// 同时启动业务服务（默认 4318）与本地闸机同步方协议替身（默认 4317）。
import { createServer as createBusinessServer } from '../server.mjs';
import { createPeer } from './peer.mjs';
import { readFileSync } from 'node:fs';

const partnerConfig = JSON.parse(readFileSync(new URL('../fixtures/partner.json', import.meta.url), 'utf8'));

const businessPort = Number(process.env.PORT ?? 4318);
const partnerPort = Number(process.env.PARTNER_PORT ?? 4317);
const host = process.env.HOST ?? '0.0.0.0';

const partner = createPeer(partnerConfig, process.env.PARTNER_STATE ?? '.local/partner.json');
const business = createBusinessServer({
  stateFile: process.env.APP_STATE ?? '.local/app.json',
  partnerUrl: process.env.PARTNER_URL ?? `http://127.0.0.1:${partnerPort}`,
  autoForwardPartner: process.env.AUTO_FORWARD_PARTNER === '1',
});

partner.listen(partnerPort, host, () => {
  console.log(JSON.stringify({ message: '本地闸机同步方已启动', port: partnerPort }));
});
business.listen(businessPort, host, () => {
  console.log(JSON.stringify({ message: '赛事工作证业务服务已启动', port: businessPort, ui: `http://127.0.0.1:${businessPort}/ui` }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    partner.close(() => business.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
