import {resolve} from 'node:path';
import {createSource} from './source.mjs';
import {createClient} from './transport.mjs';
import {collect} from './reader.mjs';
import {Archive} from './archive.mjs';
import {createApi} from './api.mjs';

const source = await createSource({port:Number(process.env.SOURCE_PORT ?? 4010),scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(resolve(process.env.DATA_DIR ?? '.state'));
const api = await createApi(archive,Number(process.env.PORT ?? 4020));
console.log(JSON.stringify({source:source.origin,api:api.origin}));
try {
  const rows = await collect(createClient(source.origin));
  const written = await archive.put(rows,{source:source.origin,adapter:'current'});
  const counts = {interpreted:0,partial:0,uninterpreted:0};
  for (const row of rows) if (row.status in counts) counts[row.status]++;
  console.log(JSON.stringify({...written,spectra:counts}));
} catch(error) {console.error(error.message);}
let stopping = false;
const stop = async () => {if(stopping) return;stopping = true;await Promise.all([source.close(),api.close()]);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
