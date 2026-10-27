/** An input the extractor can't classify or parse. Extraction stops on the first one. */
export class ExtractError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = "ExtractError";
  }
}
