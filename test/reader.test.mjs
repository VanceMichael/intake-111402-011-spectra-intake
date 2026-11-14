import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';
let source,client;
before(async () => {source = await createSource();client = createClient(source.origin);});
after(async () => {await source.close();});

test('索引行保存运行和谱图双重身份', async () => {
  const rows = await collect(client);
  assert.equal(rows[0].spectrumId, 'scan=1');
  assert.equal(rows[0].arrayLength, 2);
  assert.equal((await client('/offset/100')).id, 'scan=1');
});
