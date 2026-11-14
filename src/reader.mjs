export async function collect(client) {
  const run = await client('/run');
  const rows = [];
  for (const entry of run.spectrumIndex) {
    const spectrum = await client(`/spectrum/${encodeURIComponent(entry.id)}`);
    rows.push({id:`${run.runId}:${spectrum.id}`,runId:run.runId,spectrumId:spectrum.id,
      arrayLength:spectrum.defaultArrayLength,offset:entry.offset,revision:run.sourceRevision});
  }
  return rows;
}
