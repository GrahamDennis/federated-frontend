// The React plugin SDK: everything a React plugin needs to be a write-once,
// run-hosted-or-standalone citizen, layered on the framework-agnostic
// @ff/protocol wire contract.
//
// `connectToHost` is also available framework-free at `@ff/plugin-sdk-react/connect`
// for plugins that render their own UI (e.g. the map and Places plugins) and
// don't need the component kit / standalone chrome.
export * from './connect';
export * from './platform';
export {createHostedPlatform, RemoteContributions} from './hosted';
export {createStandalonePlatform, StandaloneChrome} from './standalone';
