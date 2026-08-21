import { loadAppConfig } from "../src/config/index.ts";
import { createTransformersEmbeddingProvider } from "../src/indexing/index.ts";

const config = await loadAppConfig({ argv: Bun.argv.slice(2), projectDir: process.cwd() });
if (!config.ok) {
  console.error(`${config.error.code}: ${config.error.message}`);
  process.exitCode = 1;
} else {
  const provider = createTransformersEmbeddingProvider(config.value);
  try {
    console.info(`Preparing ${config.value.embedding.modelId} in the configured local cache...`);
    const prepared = await provider.warmUp({ allowDownload: true });
    if (!prepared.ok) {
      console.error(`${prepared.error.code}: ${prepared.error.message}`);
      process.exitCode = 1;
    } else {
      console.info("Local model assets are ready; normal inference will remain offline.");
    }
  } finally {
    await provider.shutdown();
  }
}
