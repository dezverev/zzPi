import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

interface JitiInstance {
  import(id: string): Promise<unknown>;
}

interface CreateJiti {
  (id: string | URL, options?: Record<string, unknown>): JitiInstance;
}

interface JitiRoot {
  createJiti?: CreateJiti;
}

type JitiRootFactory = CreateJiti & JitiRoot;

export interface CustomPlugModuleLoaderOptions {
  /** A module inside the host package whose dependencies include public jiti. */
  readonly hostModulePath?: string;
}

function getRootCreateJiti(hostModulePath: string): CreateJiti {
  const loaded = createRequire(hostModulePath)("jiti") as JitiRootFactory;
  const createJiti = loaded.createJiti ?? loaded;
  if (typeof createJiti !== "function") {
    throw new TypeError("The host jiti package does not expose createJiti");
  }
  return createJiti;
}

async function getStaticCreateJiti(hostModulePath: string): Promise<CreateJiti> {
  const createBootstrapJiti = getRootCreateJiti(hostModulePath);
  const bootstrap = createBootstrapJiti(pathToFileURL(hostModulePath), {
    fsCache: false,
    moduleCache: false,
  });
  const loaded = await bootstrap.import("jiti/static") as {
    createJiti?: CreateJiti;
    default?: CreateJiti;
  };
  const createJiti = loaded.createJiti ?? loaded.default;
  if (typeof createJiti !== "function") {
    throw new TypeError("The public jiti/static module does not expose createJiti");
  }
  return createJiti;
}

/** Load a trusted custom-plug entry through public jiti/static without caches. */
export async function loadCustomPlugModule(
  entryPath: string,
  options: CustomPlugModuleLoaderOptions = {},
): Promise<unknown> {
  const hostModulePath = options.hostModulePath ?? process.argv[1];
  if (!hostModulePath) {
    throw new Error("Cannot resolve jiti without a host module path");
  }

  const createJiti = await getStaticCreateJiti(hostModulePath);
  const loader = createJiti(pathToFileURL(entryPath), {
    fsCache: false,
    interopDefault: false,
    moduleCache: false,
  });
  return loader.import(pathToFileURL(entryPath).href);
}
