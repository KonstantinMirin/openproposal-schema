// A known-bad input for the typecheck gate, which only the repository's own
// compiler options reject: null where a string is required (strict), and a
// list item that may be missing (noUncheckedIndexedAccess). The fixture's
// tsconfig extends the repository's, so relaxing either option there makes
// the fixture pass and the gate self-tests fail.
const names: string[] = [];
export const missing: string = null;
export const first: string = names[0];
