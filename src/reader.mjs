import {createResolver, interpretSpectrum, normalizeLength, normalizeOffset} from './spectrum.mjs';

const MAX_PAGES = 10000;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function indexedRows(run) {
  const index = run?.spectrumIndex;
  if (!Array.isArray(index)) throw new Error('source run has no spectrumIndex array');
  const runId = typeof run.runId === 'number' ? String(run.runId) : run.runId;
  if (typeof runId !== 'string' || !runId) throw new Error('source run has no runId');
  return index.map((entry,position) => {
    if (typeof entry === 'string' || typeof entry === 'number') {
      return {position,id:String(entry),offset:null,arrayLength:null};
    }
    const owned = isObject(entry) ? entry : {};
    return {
      position,
      id: typeof owned.id === 'string' && owned.id ? owned.id : (typeof owned.id === 'number' ? String(owned.id) : null),
      offset: normalizeOffset(owned.offset),
      arrayLength: normalizeLength(owned.defaultArrayLength ?? owned.arrayLength),
    };
  });
}

function nextTarget(next) {
  if (next === null || next === undefined || next === false || next === '' || next === 0) return null;
  // A bare page number is a page token, not a path.
  if (typeof next === 'number') return Number.isSafeInteger(next) && next > 0 ? `/sequential?page=${next}` : null;
  if (isObject(next)) return nextTarget(next.page ?? next.path ?? next.href ?? next.url);
  if (typeof next !== 'string') return null;
  if (/^\d+$/.test(next)) return `/sequential?page=${next}`;
  try {
    const url = new URL(next,'http://127.0.0.1');
    return `${url.pathname}${url.search}`;
  } catch {return null;}
}

function reason(stage,error,path,extra = {}) {
  const result = {stage,reason:error?.message ?? String(error)};
  if (path) result.path = path;
  if (error?.status !== undefined) result.status = error.status;
  if (error?.expected !== undefined) result.expected = error.expected;
  if (error?.actual !== undefined) result.actual = error.actual;
  return {...result,...extra};
}

function identityFailure(message,expected,actual) {
  return Object.assign(new Error(message),{identity:true,expected,actual});
}

function runMatches(value,run) {
  if (!isObject(value) || value.runId === undefined || value.runId === null) return true;
  if (run.runId === undefined || run.runId === null) return true;
  return value.runId === run.runId;
}

// The sequential listing is the source's ordered path. It is read lazily and
// once per collection: one unreliable offset does not force every later
// spectrum through a second route, and pagination is followed to the end.
function sequentialReader(client) {
  let loaded;
  return function load() {
    if (!loaded) loaded = (async () => {
      const items = new Map();
      const order = [];
      const visited = new Set();
      let target = '/sequential?page=1';
      let pages = 0;
      while (target !== null) {
        if (visited.has(target)) throw new Error(`sequential pagination repeats ${target}`);
        if (pages >= MAX_PAGES) throw new Error('sequential pagination exceeds page limit');
        visited.add(target);
        pages++;
        const body = await client(target);
        if (!isObject(body) || !Array.isArray(body.items)) throw new Error(`sequential page ${pages} has no items array`);
        for (const raw of body.items) {
          if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) continue;
          if (items.has(raw.id)) items.set(raw.id,{...items.get(raw.id),...raw});
          else {items.set(raw.id,raw);order.push(raw.id);}
        }
        target = nextTarget(body.next);
      }
      return {items,order,pages,path:'/sequential?page=1'};
    })();
    return loaded;
  };
}

function spectrumLoader(client,run) {
  const cache = new Map();
  return function load(id) {
    const key = String(id);
    if (!cache.has(key)) cache.set(key, (async () => {
      const path = `/spectrum/${encodeURIComponent(key)}`;
      try {
        const spectrum = await client(path);
        if (!isObject(spectrum) || spectrum.id !== key) {
          throw identityFailure(`spectrum endpoint returned ${JSON.stringify(isObject(spectrum) ? spectrum.id ?? null : null)}, expected ${JSON.stringify(key)}`,
            key,isObject(spectrum) ? spectrum.id ?? null : null);
        }
        if (!runMatches(spectrum,run)) {
          throw identityFailure(`spectrum ${JSON.stringify(key)} belongs to run ${JSON.stringify(spectrum.runId)}, expected ${JSON.stringify(run.runId)}`,
            run.runId,spectrum.runId);
        }
        return {spectrum,path};
      } catch (error) {
        return {spectrum:null,path,error:reason('spectrum',error,path,{identity:Boolean(error.identity)})};
      }
    })());
    return cache.get(key);
  };
}

// A random-access hit is only accepted when it names the same object as the
// index entry. A mismatch means the offset landed on another spectrum, which
// may belong to another sample, so it is never attached to this id.
async function verifyOffset(client,entry,run) {
  const path = `/offset/${encodeURIComponent(entry.offset)}`;
  try {
    const object = await client(path);
    if (!isObject(object)) throw identityFailure(`offset ${entry.offset} returned no spectrum object`,entry.id,null);
    if (object.id !== entry.id) {
      throw identityFailure(`offset ${entry.offset} returned ${JSON.stringify(object.id ?? null)}, expected ${JSON.stringify(entry.id)}`,
        entry.id,object.id ?? null);
    }
    if (!runMatches(object,run)) {
      throw identityFailure(`offset ${entry.offset} belongs to run ${JSON.stringify(object.runId)}, expected ${JSON.stringify(run.runId)}`,
        run.runId,object.runId);
    }
    // Identity is confirmed by id/run. A differing length is index metadata
    // drift, recorded but not grounds for discarding the confirmed object.
    const warnings = [];
    const actualLength = normalizeLength(object.defaultArrayLength);
    if (actualLength !== null && entry.arrayLength !== null && actualLength !== entry.arrayLength) {
      warnings.push({stage:'offset',path,reason:`offset ${entry.offset} has defaultArrayLength ${actualLength}, index says ${entry.arrayLength}`,
        expected:entry.arrayLength,actual:actualLength});
    }
    return {ok:true,path,object,warnings};
  } catch (error) {
    return {ok:false,error:reason('offset',error,path,{identity:Boolean(error.identity)})};
  }
}

async function readFromSequential(loadSequential,loadSpectrum,entry,run) {
  let listing;
  try {listing = await loadSequential();}
  catch (error) {return {spectrum:null,reasons:[reason('sequential',error,'/sequential?page=1')]};}
  const candidate = entry.id === null ? undefined : listing.items.get(entry.id);
  if (!candidate) {
    return {spectrum:null,reasons:[reason('sequential',
      new Error(`spectrum ${JSON.stringify(entry.id)} absent from sequential listing`),listing.path)]};
  }
  if (!runMatches(candidate,run)) {
    return {spectrum:null,reasons:[reason('sequential',
      new Error(`sequential item belongs to run ${JSON.stringify(candidate.runId)}, expected ${JSON.stringify(run.runId)}`),listing.path)]};
  }
  if (Array.isArray(candidate.binaryDataArrays)) {
    return {spectrum:candidate,path:listing.path,mode:'sequential'};
  }
  const direct = await loadSpectrum(entry.id);
  if (direct.spectrum) return {spectrum:direct.spectrum,path:direct.path,mode:'sequential'};
  return {spectrum:null,reasons:[reason('sequential',
    new Error(`sequential lists ${JSON.stringify(entry.id)} but its data could not be read: ${direct.error.reason}`),listing.path),
    ...(direct.error ? [direct.error] : [])]};
}

function baseRow(run,entry) {
  return {
    id:`${run.runId}:${entry.id ?? `#${entry.position}`}`,
    runId:run.runId,
    sourceRevision:run.sourceRevision ?? null,
    revision:run.sourceRevision ?? null,
    spectrumId:entry.id,
    indexPosition:entry.position,
    offset:entry.offset === null ? null : Number(entry.offset),
    arrayLength:entry.arrayLength,
  };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(item => {
    const key = JSON.stringify([item.stage,item.path,item.reason,item.arrayIndex]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uninterpretedRow(run,entry,{reasons,readMode,sourcePath,warnings = []}) {
  const unique = dedupe(reasons);
  return {
    ...baseRow(run,entry),
    status:'uninterpreted',
    interpreted:false,
    readMode,
    sourcePath:sourcePath ?? (entry.id === null ? null : `/spectrum/${encodeURIComponent(entry.id)}`),
    offsetPath:entry.offset === null ? null : `/offset/${encodeURIComponent(entry.offset)}`,
    reasons:unique,
    errors:unique,
    params:[],
    referenceableParamGroupRef:null,
    instrument:null,
    instrumentConfigurationRef:null,
    precursors:[],
    precursorRefs:[],
    arrays:[],
    warnings:dedupe(warnings),
  };
}

function interpretedRow(run,entry,{spectrum,reasons,warnings:readWarnings = [],readMode,sourcePath},interpretation) {
  // Recovered identity mismatches are warnings with their original location;
  // only failures that prevented decoding count as errors.
  const errors = dedupe([...interpretation.errors]);
  const warnings = dedupe([...interpretation.warnings,...readWarnings,...reasons.map(item => ({...item,recovered:true}))]);
  const decoded = interpretation.arrays.filter(array => array.decoded);
  let status = 'interpreted';
  if (errors.length > 0) status = decoded.length > 0 ? 'partial' : 'uninterpreted';
  const row = {
    ...baseRow(run,entry),
    arrayLength:interpretation.arrayLength ?? entry.arrayLength,
    status,
    interpreted:status === 'interpreted',
    readMode,
    sourcePath,
    offsetPath:entry.offset === null ? null : `/offset/${encodeURIComponent(entry.offset)}`,
    params:interpretation.params,
    referenceableParamGroupRef:interpretation.referenceableParamGroupRef,
    parameterGroupSource:interpretation.parameterGroupSource,
    instrument:interpretation.instrument,
    instrumentConfigurationRef:interpretation.instrumentConfigurationRef,
    instrumentConfigurationSource:interpretation.instrumentConfigurationSource,
    precursors:interpretation.precursors,
    precursorRefs:interpretation.precursorRefs,
    arrays:interpretation.arrays,
    warnings,
    errors,
  };
  if (interpretation.massAxis) row.massAxis = interpretation.massAxis;
  if (interpretation.intensity) row.intensity = interpretation.intensity;
  if (interpretation.massAxes) row.massAxes = interpretation.massAxes;
  if (interpretation.intensities) row.intensities = interpretation.intensities;
  return row;
}

export async function collect(client) {
  const runBody = await client('/run');
  const run = isObject(runBody) ? {...runBody,runId:runBody.runId === undefined || runBody.runId === null ? runBody.runId : String(runBody.runId)} : runBody;
  const entries = indexedRows(run);
  const resolver = createResolver(client);
  const loadSequential = sequentialReader(client);
  const loadSpectrum = spectrumLoader(client,run);
  const rows = [];
  // Each index entry is attempted independently: one unreadable or
  // mis-indexed spectrum leaves its own row with reasons and original
  // locations, while every other spectrum is still delivered.
  for (const entry of entries) {
    const reasons = [];
    const warnings = [];
    let spectrum = null;
    let readMode = 'unavailable';
    let sourcePath = entry.id === null ? null : `/spectrum/${encodeURIComponent(entry.id)}`;

    if (entry.id !== null) {
      let offsetVerified = false;
      let offsetObject = null;
      if (entry.offset !== null) {
        const checked = await verifyOffset(client,entry,run);
        if (checked.ok) {
          offsetVerified = true;
          warnings.push(...(checked.warnings ?? []));
          offsetObject = checked.object;
        } else reasons.push(checked.error);
      }

      let direct = null;
      if (entry.offset === null || offsetVerified) {
        direct = await loadSpectrum(entry.id);
        if (direct.spectrum) {
          spectrum = direct.spectrum;
          readMode = offsetVerified ? 'offset' : 'index';
          sourcePath = direct.path;
        } else if (direct.error) reasons.push(direct.error);
      }

      // The verified offset object is a usable spectrum projection only when
      // it actually carries array data; it is never used unverified.
      if (!spectrum && offsetVerified && Array.isArray(offsetObject?.binaryDataArrays)) {
        spectrum = offsetObject;
        readMode = 'offset';
        sourcePath = `/offset/${encodeURIComponent(entry.offset)}`;
      }

      // A failed random-access identity check falls back to the ordered read,
      // never to whatever object the offset happened to point at.
      if (!spectrum && reasons.length > 0) {
        const fallback = await readFromSequential(loadSequential,loadSpectrum,entry,run);
        if (fallback.spectrum) {
          spectrum = fallback.spectrum;
          readMode = fallback.mode;
          sourcePath = fallback.path;
        } else {
          reasons.push(...fallback.reasons);
          // Last resort: the id-addressed spectrum is still identity checked.
          if (!direct) {
            const retry = await loadSpectrum(entry.id);
            if (retry.spectrum) {spectrum = retry.spectrum;readMode = 'direct';sourcePath = retry.path;}
            else if (retry.error && !reasons.some(item => item.path === retry.error.path)) reasons.push(retry.error);
          }
        }
      }
    } else {
      reasons.push({stage:'index',reason:'spectrum index entry has no usable id'});
    }

    if (!spectrum) {
      rows.push(uninterpretedRow(run,entry,{reasons,readMode,sourcePath,warnings}));
      continue;
    }
    let interpretation;
    try {
      interpretation = await interpretSpectrum({spectrum,run,resolver});
    } catch (error) {
      rows.push(uninterpretedRow(run,entry,{reasons:[...reasons,reason('interpretation',error,sourcePath)],readMode,sourcePath,warnings}));
      continue;
    }
    rows.push(interpretedRow(run,entry,{spectrum,reasons,warnings,readMode,sourcePath},interpretation));
  }
  return rows;
}
