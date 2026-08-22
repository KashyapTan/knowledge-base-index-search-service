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
  ConfiguredEmbeddingDevice,
  EmbeddingConfig,
  EmbeddingDevice,
  EmbeddingEncodingConfig,
  EmbeddingPoolingConfig,
  EmbeddingPoolingStrategy,
  EmbeddingProfileCompatibility,
  EmbeddingTokenizerConfig,
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
  DEFAULT_EMBEDDING_DEVICE,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_INDEX_CONFIG,
  DEFAULT_PORT,
  DEFAULT_SOURCE_ROOT,
  SUPPORTED_EMBEDDING_DEVICES,
  SUPPORTED_QUANTIZATIONS,
} from "./defaults.ts";
export {
  composeEmbeddingInput,
  DEFAULT_EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_PROFILES,
  type EmbeddingExecutionProfile,
  type EmbeddingModelProfile,
  type EmbeddingTaskAlternative,
  embeddingConfigFromProfile,
  findEmbeddingModelProfile,
  resolveProfileDevice,
  UNAVAILABLE_EMBEDDING_CANDIDATES,
  type UnavailableEmbeddingCandidate,
  validateEmbeddingModelProfile,
} from "./embedding-profiles.ts";
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
