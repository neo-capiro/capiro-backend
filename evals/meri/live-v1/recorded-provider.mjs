export class RecordedCaptureProvider {
  constructor(records) {
    if (!Array.isArray(records)) throw new TypeError('records must be an array');
    this.records = new Map(records.map((record) => [record.caseId, record]));
    if (this.records.size !== records.length) throw new Error('duplicate recorded case IDs');
  }

  id() {
    return 'meri-live-v1-recorded-read-only';
  }

  async callApi(_prompt, context = {}) {
    const caseId = context?.vars?.caseId ?? context?.caseId;
    const record = this.records.get(caseId);
    if (!record) throw new Error(`no recorded output for case ${String(caseId)}`);
    if (record.execute === true || record.networkRequest || record.writeRequest || record.operationRequest) {
      throw new Error('recorded provider refuses network or write execution fields');
    }
    if (typeof record.output !== 'string' || !record.outputSha256) {
      throw new Error(`recorded output/hash missing for case ${String(caseId)}`);
    }
    return {
      output: record.output,
      metadata: {
        caseId,
        outputSha256: record.outputSha256,
        source: 'recorded-capture',
        writeExecution: false,
      },
      tokenUsage: { total: 0, prompt: 0, completion: 0 },
    };
  }
}

export default RecordedCaptureProvider;
