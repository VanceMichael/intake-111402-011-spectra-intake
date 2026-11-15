import {inflateSync} from 'node:zlib';

// Only accessions decide how bytes are interpreted. Display names are kept for
// traceability but never used to guess a type.
export const PRECISIONS = new Map([
  ['MS:1000521', {bits:32, name:'float32'}],
  ['MS:1000523', {bits:64, name:'float64'}],
]);
export const COMPRESSIONS = new Map([
  ['MS:1000576','none'],
  ['MS:1000574','zlib'],
]);
export const ARRAY_TYPES = new Map([
  ['MS:1000514','mz'],
  ['MS:1000515','intensity'],
]);

const PARAM_REF_FIELDS = ['referenceableParamGroupRef','referenceableParamGroupRefs','referenceableParamGroup'];
const PARAM_LIST_FIELDS = ['cvParams','params','parameters'];
const MAX_VALUES = 8_000_000;

function isObject(value) {return value !== null && typeof value === 'object' && !Array.isArray(value);}

export function accessionOf(value) {
  if (typeof value === 'string') return /^MS:\d+$/.test(value) ? value : null;
  if (isObject(value) && typeof value.accession === 'string' && /^MS:\d+$/.test(value.accession)) return value.accession;
  return null;
}

export function normalizeParams(value) {
  if (value === null || value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  const result = [];
  for (const item of values) {
    if (Array.isArray(item)) result.push(...normalizeParams(item));
    else if (typeof item === 'string') result.push({accession:item});
    else if (isObject(item)) result.push({...item});
  }
  return result;
}

export function readParams(owner) {
  if (Array.isArray(owner)) return normalizeParams(owner);
  if (!isObject(owner)) return [];
  const result = [];
  for (const field of PARAM_LIST_FIELDS) {
    if (owner[field] !== undefined) result.push(...normalizeParams(owner[field]));
  }
  return result;
}

function referenceId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (isObject(value)) {
    for (const field of ['id','ref','referenceableParamGroupRef','value']) {
      if (value[field] !== undefined && value[field] !== null && value[field] !== '') return String(value[field]);
    }
  }
  return null;
}

export function referenceIds(owner) {
  if (!isObject(owner) && !Array.isArray(owner)) return [];
  const ids = [];
  const add = value => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {for (const item of value) add(item);return;}
    const id = referenceId(value);
    if (id !== null) ids.push(id);
  };
  for (const field of PARAM_REF_FIELDS) add(owner[field]);
  return [...new Set(ids)];
}

function paramGroupPath(id) {return `/params/${encodeURIComponent(id)}`;}
function instrumentPath(id) {return `/instruments/${encodeURIComponent(id)}`;}

function failedReference(stage, label, id, path, error) {
  return {
    stage,
    reason:`${label} ${id}: ${error?.message ?? String(error)}`,
    path,
    ...(error?.status === undefined ? {} : {status:error.status}),
  };
}

export function createResolver(client) {
  const groups = new Map();
  const instruments = new Map();

  async function loadGroup(id, visiting) {
    const path = paramGroupPath(id);
    if (visiting.has(id)) {
      return {id,params:[],errors:[{stage:'params',reason:`circular parameter group reference ${id}`,path}]};
    }
    visiting.add(id);
    try {
      const body = await client(path);
      const params = readParams(body);
      const errors = [];
      for (const nested of referenceIds(body)) {
        if (nested === id) continue;
        const group = await loadGroup(nested, visiting);
        params.push(...group.params);
        errors.push(...group.errors);
      }
      return {id,params,errors};
    } catch (error) {
      return {id,params:[],errors:[failedReference('params','parameter group',id,path,error)]};
    } finally {
      visiting.delete(id);
    }
  }

  async function group(id) {
    const key = String(id);
    if (!groups.has(key)) groups.set(key,loadGroup(key,new Set()));
    return groups.get(key);
  }

  async function loadInstrument(id) {
    const path = instrumentPath(id);
    try {
      const body = await client(path);
      const params = readParams(body);
      const errors = [];
      for (const nested of referenceIds(body)) {
        const groupResult = await group(nested);
        params.push(...groupResult.params);
        errors.push(...groupResult.errors);
      }
      return {id,body,params,errors};
    } catch (error) {
      return {id,body:null,params:[],errors:[failedReference('instrument','instrument configuration',id,path,error)]};
    }
  }

  async function instrument(id) {
    const key = String(id);
    if (!instruments.has(key)) instruments.set(key,loadInstrument(key));
    return instruments.get(key);
  }

  return {group,instrument};
}

function normalizeLength(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
  }
  return null;
}

function normalizeOffset(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return null;
}

function decodeBase64(text) {
  const compact = text.replace(/\s+/g,'');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new Error('data is not valid base64');
  }
  const bytes = Buffer.from(compact,'base64');
  if (bytes.toString('base64').replace(/=+$/,'') !== compact.replace(/=+$/,'')) {
    throw new Error('data is not canonical base64');
  }
  return bytes;
}

function pickDeclaration(map,primary,secondary) {
  // Array declarations win, but an explicit spectrum-level declaration is
  // still valid input. Within one scope an ambiguous declaration is an error,
  // not a choice.
  const scopes = (primary?.length ?? 0) > 0 ? [primary,secondary ?? []] : [secondary ?? []];
  for (const scope of scopes) {
    const found = [];
    for (const param of scope) {
      const value = map.get(param.accession);
      if (value) found.push({accession:param.accession,value});
    }
    if (found.length > 0) {
      const distinct = new Set(found.map(item => JSON.stringify(item.value)));
      if (distinct.size > 1) return {error:'conflicting declarations'};
      return found[0];
    }
  }
  return {missing:true};
}

// Precision is only ever taken from an accession. A display name can be
// recorded for traceability but can never decide how bytes are typed; bytes
// with no accession declaration stay undecoded rather than guessed.
function resolvePrecision(array,params,fallbackParams,notes) {
  const declared = array.precision ?? array.precisionAccession ?? array.precisionRef;
  if (declared !== undefined && declared !== null && declared !== '') {
    const accession = accessionOf(declared);
    const precision = accession ? PRECISIONS.get(accession) : null;
    if (precision) return {accession,precision};
    const label = typeof declared === 'string' ? declared : (declared.name ?? declared);
    notes.push({stage:'precision',warning:`ignoring non-accession precision label ${JSON.stringify(label)}`});
  }
  const picked = pickDeclaration(PRECISIONS,params,fallbackParams);
  if (picked.missing) return {error:'missing precision declaration; bytes cannot be typed'};
  if (picked.error) return {error:`${picked.error} for precision`};
  return {accession:picked.accession,precision:picked.value};
}

function resolveCompression(array,params,fallbackParams,notes) {
  const declared = array.compression ?? array.compressionType;
  if (declared !== undefined && declared !== null && declared !== '') {
    const result = compressionValue(declared);
    if (result) return {compression:result};
    const label = typeof declared === 'string' ? declared : (declared.name ?? declared);
    notes.push({stage:'compression',warning:`ignoring unknown compression label ${JSON.stringify(label)}`});
  }
  const picked = pickDeclaration(COMPRESSIONS,params,fallbackParams);
  if (picked.missing) return {compression:'none'};
  if (picked.error) return {error:`${picked.error} for compression`};
  return {compression:picked.value};
}

function compressionValue(value) {
  if (typeof value === 'string') {
    const accession = accessionOf(value);
    if (accession) return COMPRESSIONS.get(accession) ?? null;
    const token = value.toLowerCase();
    if (token === 'none' || token === 'uncompressed') return 'none';
    if (token === 'zlib') return 'zlib';
    return null;
  }
  const accession = accessionOf(value);
  return accession ? COMPRESSIONS.get(accession) ?? null : null;
}

function resolveArrayType(array,params,fallbackParams,notes) {
  const declared = array.arrayType ?? array.arrayTypeRef ?? array.type;
  const declaredAccession = accessionOf(declared);
  let accession = declaredAccession;
  if (!accession) {
    // Only mz (MS:1000514) and intensity (MS:1000515) are interpreted; a
    // spectrum-level declaration is still usable when the array has none.
    const picked = pickDeclaration(new Map([...ARRAY_TYPES.keys()].map(key => [key,true])),params,fallbackParams);
    if (!picked.missing && !picked.error) accession = picked.accession;
    if (declared !== undefined && declared !== null && declared !== '' && !accession) {
      const label = typeof declared === 'string' ? declared : (declared.name ?? null);
      if (label) notes.push({stage:'arrayType',warning:`array type ${JSON.stringify(label)} has no recognised accession`});
    }
  }
  const kind = accession ? ARRAY_TYPES.get(accession) ?? 'other' : 'unknown';
  return {accession,kind,declaredAccession:Boolean(declaredAccession)};
}

function decodeArray(array,index,expectedLength,params,fallbackParams) {
  const notes = [];
  const type = resolveArrayType(array,params,fallbackParams,notes);
  const declaredType = array.arrayType ?? array.arrayTypeRef ?? array.type;
  const output = {
    index,
    arrayType:type.accession ?? (typeof declaredType === 'string' ? declaredType : null),
    arrayTypeAccession:type.accession,
    kind:type.kind,
    data:typeof array.data === 'string' ? array.data : null,
  };
  if (!type.declaredAccession && declaredType !== undefined && declaredType !== null && declaredType !== '') {
    const label = typeof declaredType === 'string' ? declaredType : (declaredType.name ?? null);
    if (label) output.arrayTypeName = label;
  }

  const precision = resolvePrecision(array,params,fallbackParams,notes);
  if (precision.error) return {...output,error:precision.error,notes};
  output.precision = precision.accession;
  output.precisionBits = precision.precision.bits;
  output.precisionName = precision.precision.name;

  const compression = resolveCompression(array,params,fallbackParams,notes);
  if (compression.error) return {...output,error:compression.error,notes};
  output.compression = compression.compression;

  if (expectedLength === null) return {...output,error:'defaultArrayLength is missing or invalid'};
  if (expectedLength > MAX_VALUES) return {...output,error:`array length ${expectedLength} exceeds intake limit`};
  if (typeof array.data !== 'string') return {...output,error:'binary data is missing'};

  let encoded;
  try {encoded = decodeBase64(array.data);}
  catch (error) {return {...output,error:error.message};}
  output.encodedBytes = encoded.length;

  let bytes = encoded;
  if (compression.compression === 'zlib') {
    const expectedBytes = expectedLength * (precision.precision.bits / 8);
    try {
      bytes = inflateSync(encoded,{maxOutputLength:Math.min(Math.max(expectedBytes,1),MAX_VALUES * 8)});
    } catch (error) {
      return {...output,error:`invalid zlib array data: ${error.message}`};
    }
  }
  output.byteLength = bytes.length;

  const expectedBytes = expectedLength * (precision.precision.bits / 8);
  if (bytes.length !== expectedBytes) {
    return {...output,error:`array data has ${bytes.length} bytes, expected ${expectedBytes} for ${expectedLength} values`};
  }

  const values = new Array(expectedLength);
  let nonFinite = 0;
  if (precision.precision.bits === 32) {
    for (let i = 0; i < expectedLength; i++) {
      const value = bytes.readFloatLE(i * 4);
      if (!Number.isFinite(value)) nonFinite++;
      values[i] = value;
    }
  } else {
    for (let i = 0; i < expectedLength; i++) {
      const value = bytes.readDoubleLE(i * 8);
      if (!Number.isFinite(value)) nonFinite++;
      values[i] = value;
    }
  }
  output.values = values;
  output.valueCount = values.length;
  // Non-finite values are preserved as-is; JSON renders them as null, so the
  // count is recorded rather than silently implying a numeric reading.
  if (nonFinite > 0) output.nonFiniteCount = nonFinite;
  return output;
}

function precursorList(spectrum) {
  let value = spectrum.precursors ?? spectrum.precursorList ?? spectrum.precursor;
  if (isObject(value)) {
    if (Array.isArray(value.precursor)) value = value.precursor;
    else if (Array.isArray(value.precursors)) value = value.precursors;
    else if (value.id === undefined && value.spectrumRef === undefined && value.referenceableParamGroupRef === undefined) value = [];
  }
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export async function interpretSpectrum({spectrum,run,resolver}) {
  const warnings = [];
  const errors = [];
  const params = [];
  const groupRefs = [];
  // Spectrum-level declarations win; a run-level default only applies when the
  // spectrum itself declares nothing, and the inherited origin is recorded.
  const spectrumGroupRefs = referenceIds(spectrum);
  const runGroupRefs = isObject(run) ? referenceIds(run) : [];
  const groupSource = spectrumGroupRefs.length > 0 ? 'spectrum' : (runGroupRefs.length > 0 ? 'run' : null);
  for (const id of (groupSource === 'run' ? runGroupRefs : spectrumGroupRefs)) {
    groupRefs.push(id);
    const group = await resolver.group(id);
    params.push(...group.params);
    warnings.push(...group.errors);
  }
  params.push(...readParams(spectrum));

  let instrument = null;
  let instrumentSource = null;
  let instrumentRef = referenceId(
    spectrum.instrumentConfigurationRef ?? spectrum.instrumentConfigurationId ??
    (isObject(spectrum.instrumentConfiguration) ? spectrum.instrumentConfiguration.id : null)
  );
  if (instrumentRef !== null) instrumentSource = 'spectrum';
  else if (isObject(run)) {
    instrumentRef = referenceId(run.instrumentConfigurationRef ?? run.instrumentConfigurationId ??
      (isObject(run.instrumentConfiguration) ? run.instrumentConfiguration.id : null));
    if (instrumentRef !== null) instrumentSource = 'run';
  }
  if (instrumentRef !== null) {
    const resolved = await resolver.instrument(instrumentRef);
    warnings.push(...resolved.errors);
    const inline = instrumentSource === 'spectrum' && isObject(spectrum.instrumentConfiguration)
      ? spectrum.instrumentConfiguration
      : (instrumentSource === 'run' && isObject(run.instrumentConfiguration) ? run.instrumentConfiguration : null);
    const body = resolved.body ?? inline;
    if (body) {
      instrument = {...body};
      const instrumentParams = [...readParams(body),...resolved.params];
      if (instrumentParams.length > 0) instrument.params = instrumentParams;
    }
  } else if (isObject(spectrum.instrumentConfiguration)) {
    instrument = {...spectrum.instrumentConfiguration};
    const instrumentParams = readParams(spectrum.instrumentConfiguration);
    if (instrumentParams.length > 0) instrument.params = instrumentParams;
  }

  const precursors = [];
  const precursorRefs = [];
  const addPrecursorRef = value => {
    const ref = referenceId(value);
    if (ref === null || precursorRefs.includes(ref)) return;
    precursorRefs.push(ref);
  };
  for (const rawPrecursor of precursorList(spectrum)) {
    if (!isObject(rawPrecursor)) {
      addPrecursorRef(rawPrecursor);
      continue;
    }
    const precursor = {...rawPrecursor};
    const precursorParams = readParams(rawPrecursor);
    for (const id of referenceIds(rawPrecursor)) {
      const group = await resolver.group(id);
      precursorParams.push(...group.params);
      warnings.push(...group.errors);
    }
    if (precursorParams.length > 0) precursor.params = precursorParams;
    const ref = referenceId(rawPrecursor.spectrumRef ?? rawPrecursor.precursorSpectrumRef ?? rawPrecursor.precursorRef);
    if (ref !== null) {
      precursor.precursorRef = ref;
      if (run.runId !== undefined && run.runId !== null) precursor.runSpectrumId = `${run.runId}:${ref}`;
      addPrecursorRef(ref);
    }
    precursors.push(precursor);
  }
  if (Array.isArray(spectrum.precursorRefs)) for (const ref of spectrum.precursorRefs) addPrecursorRef(ref);

  const expectedLength = normalizeLength(spectrum.defaultArrayLength);
  let rawArrays = [];
  if (spectrum.binaryDataArrays !== undefined && spectrum.binaryDataArrays !== null) {
    if (!Array.isArray(spectrum.binaryDataArrays)) {
      errors.push({stage:'array',reason:'binaryDataArrays is not an array',path:'/spectrum'});
    } else {
      rawArrays = spectrum.binaryDataArrays;
    }
  }
  if (rawArrays.length === 0 && expectedLength !== 0) {
    errors.push({stage:'array',reason:'spectrum carries no binary data arrays'});
  }
  if (rawArrays.length > 0 && expectedLength === null) {
    errors.push({stage:'length',reason:'defaultArrayLength is missing or invalid'});
  }

  const arrays = [];
  const massAxes = [];
  const intensities = [];
  for (let index = 0; index < rawArrays.length; index++) {
    const raw = rawArrays[index];
    if (!isObject(raw)) {
      const message = 'binary data array is not an object';
      arrays.push({index,decoded:false,error:message,notes:[]});
      errors.push({stage:'decode',arrayIndex:index,reason:message});
      continue;
    }
    const arrayParams = readParams(raw);
    for (const id of referenceIds(raw)) {
      const group = await resolver.group(id);
      arrayParams.push(...group.params);
      warnings.push(...group.errors);
    }
    const decoded = decodeArray(raw,index,expectedLength,arrayParams,params);
    if (decoded.notes?.length > 0) warnings.push(...decoded.notes);
    if (decoded.error) {
      decoded.decoded = false;
      errors.push({stage:'decode',arrayIndex:index,arrayType:decoded.arrayTypeAccession ?? decoded.arrayType,reason:decoded.error});
    } else {
      decoded.decoded = true;
      if (decoded.kind === 'mz') massAxes.push(decoded.values);
      if (decoded.kind === 'intensity') intensities.push(decoded.values);
    }
    if (arrayParams.length > 0) decoded.params = arrayParams;
    const ownRefs = referenceIds(raw);
    if (ownRefs.length > 0) decoded.referenceableParamGroupRef = ownRefs.length === 1 ? ownRefs[0] : ownRefs;
    arrays.push(decoded);
  }

  const result = {
    arrays,
    arrayLength:expectedLength,
    params,
    referenceableParamGroupRef:groupRefs.length === 0 ? null : (groupRefs.length === 1 ? groupRefs[0] : groupRefs),
    parameterGroupSource:groupSource,
    instrument,
    instrumentConfigurationRef:instrumentRef,
    instrumentConfigurationSource:instrumentSource,
    precursors,
    precursorRefs,
    warnings,
    errors,
  };
  if (massAxes.length > 0) result.massAxis = massAxes[0];
  if (intensities.length > 0) result.intensity = intensities[0];
  if (massAxes.length > 1) result.massAxes = massAxes;
  if (intensities.length > 1) result.intensities = intensities;
  return result;
}

export {normalizeLength,normalizeOffset};
