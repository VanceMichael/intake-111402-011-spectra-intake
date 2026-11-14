import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
test('来源变更与异常边界具有可观察的区别',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const choose = name => client('/__scenario',{method:'POST',body:{name}});
await choose('stale-index');
assert.notEqual((await client('/offset/100')).id,(await client('/run')).spectrumIndex[0].id);
const spectrum = await client('/spectrum/scan=1');
assert.equal(Buffer.from(spectrum.binaryDataArrays[0].data,'base64').readDoubleLE(0),1);
assert.equal((await client('/sequential?page=1')).items[0].id,'scan=1');
} finally {await source.close();}
});
