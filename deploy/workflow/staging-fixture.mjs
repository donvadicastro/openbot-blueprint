import { stagingFixture } from '../../test/fixtures/staging-target.mjs';

const token = process.env.STAGING_TARGET_TOKEN;
if (!token || token.length < 32) throw new Error('Configure a staging fixture token of at least 32 characters.');
const fixture = stagingFixture('/data/staging.sqlite', token, {
  dropFirstReceipt: process.env.STAGING_DROP_FIRST_RECEIPT === 'each' ? 'each' : process.env.STAGING_DROP_FIRST_RECEIPT === 'true',
});
fixture.server.listen(4520, '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => fixture.server.close(() => { fixture.close(); process.exit(0); }));
