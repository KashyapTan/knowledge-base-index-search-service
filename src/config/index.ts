export {
  classifyIndexCompatibility,
  createIndexCompatibility,
  readCompatibilityMetadata,
  writeCompatibilityMetadata,
} from "./compatibility.ts";
export { type LoadAppConfigOptions, loadAppConfig, parseCliOptions } from "./configuration.ts";
export type {
  ActiveStartupPhase,
  AppConfig,
  CompatibilityAssessment,
  CompatibilityError,
  CompatibilityStatus,
  ConfigurationError,
  EmbeddingConfig,
  IndexCompatibility,
  IndexConfig,
  ResolvedPaths,
  SourceRoot,
  StartupEvent,
  StartupIssue,
  StartupState,
  StartupTransitionError,
} from "./contracts.ts";
export { LOOPBACK_HOST } from "./contracts.ts";
export {
  APPLICATION_NAME,
  APPLICATION_VERSION,
  DEFAULT_EMBEDDING_CONFIG,
  DEFAULT_INDEX_CONFIG,
  DEFAULT_PORT,
  DEFAULT_SOURCE_ROOT,
  SUPPORTED_QUANTIZATIONS,
} from "./defaults.ts";
export {
  canonicalizeSourceRoot,
  createRootIdentity,
  expandHomePath,
  type PlatformDirectories,
  type PlatformDirectoryOptions,
  resolveLocalPaths,
  resolvePlatformDirectories,
} from "./paths.ts";
export {
  classifyPortBindError,
  type PortProbe,
  type PortSelection,
  selectAvailableLoopbackPort,
} from "./port.ts";
export {
  initialStartupState,
  StartupStateStore,
  transitionStartupState,
} from "./startup-state.ts";
