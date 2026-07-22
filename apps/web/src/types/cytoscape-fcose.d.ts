// cytoscape-fcose (fast fCoSE layout) ships no TypeScript declarations. It's a
// cytoscape layout extension consumed only via `cytoscape.use(fcose)`, so a minimal
// ambient declaration is enough to let the import resolve.
declare module 'cytoscape-fcose' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fcose: any;
  export default fcose;
}
