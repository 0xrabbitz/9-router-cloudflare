// Shim → direct repo re-exports so edge middleware (e.g. dashboardGuard)
// can tree-shake unrelated repositories and Node-only modules.
// Kept for backward compatibility with existing imports.
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl,
} from "./db/repos/settingsRepo.js";
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./db/repos/connectionsRepo.js";
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./db/repos/nodesRepo.js";
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
} from "./db/repos/proxyPoolsRepo.js";
export {
  getApiKeys, getApiKeyById, getApiKeyByKey, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
} from "./db/repos/apiKeysRepo.js";
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./db/repos/combosRepo.js";
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
} from "./db/repos/aliasRepo.js";
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./db/repos/pricingRepo.js";
export {
  exportDb, importDb,
} from "@/lib/db/index.js";
