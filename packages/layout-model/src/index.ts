// The layout model shared by the host (browser) and the layout service (Node):
// views, slots, blocks, wiring, CEL expressions, and validation. Pure — no DOM,
// no Preact, no Node APIs — so both sides run exactly the same rules.
export * from './layout';
export * from './expressions';
export * from './scope';
export * from './validate';
export * from './ports';
