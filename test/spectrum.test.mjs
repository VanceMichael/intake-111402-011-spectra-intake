import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';

function encode(values,bits,compress = false) {
  const bytes = Buffer.alloc(values.length * (bits / 8));
  values.forEach((value,index) => bits === 32 ? bytes.writeFloatLE(value,index * 4) : bytes.writeDoubleLE(value,index * 8));
  return (compress ? deflateSync(bytes) : bytes).toString('base64');
}

const mz64 = encode([100.5,200.25,300.125],64,true);
const intensity32 = encode([10.5,20.25,30.125],32,true);
const missingPrecisionData = encode([1.5,2.5],64);

const fixture = {
  exchanges: [
    {path:'/run',method:'GET',status:200,requires:{},sets:{},query:{},body:{
      runId:'run7',sourceRevision:'v7',
      spectrumIndex:[{id:'scan=1',offset:10},{id:'scan=2',offset:20},{id:'scan=3'}],
    }},
    {path:'/offset/10',method:'GET',status:200,requires:{},sets:{},query:{},body:{id:'scan=1',defaultArrayLength:3}},
    {path:'/offset/20',method:'GET',status:200,requires:{},sets:{},query:{},body:{id:'scan=2',defaultArrayLength:2}},
    {path:'/spectrum/scan=1',method:'GET',status:200,requires:{},sets:{},query:{},body:{
      id:'scan=1',defaultArrayLength:3,
      instrumentConfigurationRef:'ic1',referenceableParamGroupRef:'p1',
      binaryDataArrays:[
        {arrayType:'MS:1000514',precision:'MS:1000523',referenceableParamGroupRef:'p3',data:mz64},
        {arrayType:'MS:1000515',precision:'MS:1000521',referenceableParamGroupRef:'p3',data:intensity32},
      ],
    }},
    {path:'/params/p3',method:'GET',status:200,requires:{},sets:{},query:{},body:{cvParams:[
      {accession:'MS:1000574'},
    ]}},
    {path:'/spectrum/scan=2',method:'GET',status:200,requires:{},sets:{},query:{},body:{
      id:'scan=2',defaultArrayLength:2,instrumentConfigurationRef:'ic1',
      binaryDataArrays:[{arrayType:'MS:1000514',data:missingPrecisionData}],
    }},
    {path:'/spectrum/scan=3',method:'GET',status:200,requires:{},sets:{},query:{},body:{
      id:'scan=3',defaultArrayLength:2,referenceableParamGroupRef:'p1',
      precursors:[{spectrumRef:'scan=1',referenceableParamGroupRef:'p1'}],
      binaryDataArrays:[
        {arrayType:'MS:1000514',referenceableParamGroupRef:'p2',data:encode([5,6],32,true)},
        {arrayType:'MS:1000515',referenceableParamGroupRef:'p2',data:encode([7,8],32,true)},
      ],
    }},
    {path:'/params/p1',method:'GET',status:200,requires:{},sets:{},query:{},body:{cvParams:[
      {accession:'MS:1000511',value:'2'},
    ]}},
    {path:'/params/p2',method:'GET',status:200,requires:{},sets:{},query:{},body:{cvParams:[
      {accession:'MS:1000574'},{accession:'MS:1000521'},
    ]}},
    {path:'/instruments/ic1',method:'GET',status:200,requires:{},sets:{},query:{},body:{
      id:'ic1',analyzers:['MS:1000081'],cvParams:[{accession:'MS:1000031',value:'ESI'}],
    }},
    {path:'/sequential',method:'GET',status:200,requires:{},sets:{},query:{page:'1'},body:{
      items:[{id:'scan=1',defaultArrayLength:3},{id:'scan=2',defaultArrayLength:2},{id:'scan=3',defaultArrayLength:2}],
      next:null,
    }},
  ],
  cases: {
    'stale-index': [
      {path:'/offset/20',method:'GET',status:200,requires:{},sets:{},query:{},body:{id:'scan=9',defaultArrayLength:2}},
    ],
  },
};

async function withSource(scenario,run) {
  const directory = await mkdtemp(join(tmpdir(),'spectrum-fixture-'));
  const path = join(directory,'source.json');
  await writeFile(path,JSON.stringify(fixture));
  const source = await createSource({fixture:path,scenario});
  try {await run(source);}
  finally {await source.close();await rm(directory,{recursive:true,force:true});}
}

test('谱图数组按 accession 解释并连接运行、仪器、前体与参数组',async () => {
  await withSource('normal',async source => {
    const client = createClient(source.origin);
    const rows = await collect(client);
    assert.equal(rows.length,3);

    const first = rows[0];
    assert.equal(first.id,'run7:scan=1');
    assert.equal(first.runId,'run7');
    assert.equal(first.sourceRevision,'v7');
    assert.equal(first.status,'interpreted');
    assert.equal(first.readMode,'offset');
    assert.deepEqual(first.massAxis,[100.5,200.25,300.125]);
    assert.deepEqual(first.arrays[1].values,[10.5,20.25,30.125]);
    assert.equal(first.arrays[0].precision,'MS:1000523');
    assert.equal(first.arrays[1].precision,'MS:1000521');
    // Compression comes from the referenced parameter group, not a guess.
    assert.equal(first.arrays[0].compression,'zlib');
    assert.equal(first.arrays[1].compression,'zlib');
    assert.equal(first.referenceableParamGroupRef,'p1');
    assert.ok(first.params.some(param => param.accession === 'MS:1000511'));
    assert.equal(first.instrumentConfigurationRef,'ic1');
    assert.deepEqual(first.instrument.analyzers,['MS:1000081']);
    assert.ok(first.instrument.params.some(param => param.accession === 'MS:1000031'));

    const third = rows[2];
    assert.equal(third.status,'interpreted');
    assert.equal(third.readMode,'index');
    assert.deepEqual(third.massAxis,[5,6]);
    assert.deepEqual(third.intensity,[7,8]);
    // Array-level group references supply precision and compression.
    assert.equal(third.arrays[0].referenceableParamGroupRef,'p2');
    assert.equal(third.arrays[0].compression,'zlib');
    assert.deepEqual(third.precursorRefs,['scan=1']);
    assert.equal(third.precursors[0].runSpectrumId,'run7:scan=1');
    assert.ok(third.precursors[0].params.some(param => param.accession === 'MS:1000511'));
  });
});

test('缺失精度声明不猜测字节，单条谱图失败不影响其他谱图',async () => {
  await withSource('normal',async source => {
    const rows = await collect(createClient(source.origin));
    assert.equal(rows.length,3);
    const broken = rows[1];
    assert.equal(broken.id,'run7:scan=2');
    assert.equal(broken.status,'uninterpreted');
    assert.equal(broken.interpreted,false);
    assert.equal(broken.sourcePath,'/spectrum/scan%3D2');
    assert.equal(broken.offsetPath,'/offset/20');
    const decodeError = broken.errors.find(error => error.stage === 'decode');
    assert.ok(decodeError,JSON.stringify(broken.errors));
    assert.match(decodeError.reason,/precision/);
    assert.equal(broken.arrays[0].decoded,false);
    assert.equal(broken.arrays[0].data,missingPrecisionData);
    assert.equal(broken.instrumentConfigurationRef,'ic1');
    assert.equal(rows[0].status,'interpreted');
    assert.equal(rows[2].status,'interpreted');
  });
});

test('偏移命中错误谱图时核对身份并退回顺序读取',async () => {
  await withSource('stale-index',async source => {
    const client = createClient(source.origin);
    const rows = await collect(client);
    const second = rows[1];
    assert.equal(second.id,'run7:scan=2');
    assert.equal(second.readMode,'sequential');
    assert.equal(second.arrays[0].data,missingPrecisionData);
    assert.ok(second.warnings.some(item => item.stage === 'offset' && item.identity));
    assert.ok(!second.errors.some(error => error.stage === 'offset'));
    const audit = await client('/__audit');
    assert.ok(audit.requests.some(request => request.path === '/sequential'));
  });
});

test('有效谱图与无法解释的谱图一起归档，查询保留失败原因和原件位置',async () => {
  const {Archive} = await import('../src/archive.mjs');
  const {createApi} = await import('../src/api.mjs');
  await withSource('normal',async source => {
    const directory = await mkdtemp(join(tmpdir(),'intake-archive-'));
    try {
      const archive = new Archive(directory);
      const rows = await collect(createClient(source.origin));
      await archive.put(rows,{source:source.origin,adapter:'current'});
      const api = await createApi(archive);
      try {
        const stored = await (await fetch(`${api.origin}/records`)).json();
        assert.equal(stored.length,3);
        const byId = new Map(stored.map(entry => [entry.row.id,entry.row]));
        assert.deepEqual(byId.get('run7:scan=1').massAxis,[100.5,200.25,300.125]);
        assert.deepEqual(byId.get('run7:scan=3').intensity,[7,8]);
        assert.equal(byId.get('run7:scan=2').status,'uninterpreted');
        assert.match(byId.get('run7:scan=2').errors[0].reason,/precision/);
      } finally {await api.close();}
    } finally {await rm(directory,{recursive:true,force:true});}
  });
});
