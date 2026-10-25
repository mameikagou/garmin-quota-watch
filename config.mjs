import { homedir } from "node:os";
import { join } from "node:path";

export const configDirectory = process.env.QUOTA_CONFIG_DIR ?? join(homedir(), ".config/quota-watch");

export function quotaEndpoint() {
  if (!process.env.QUOTA_ENDPOINT) throw new Error("请设置 QUOTA_ENDPOINT 为自己的 Worker 地址");
  const endpoint = new URL(process.env.QUOTA_ENDPOINT);
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("QUOTA_ENDPOINT 需要 HTTP(S) 地址");
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error("QUOTA_ENDPOINT 只填写服务根地址");
  }
  return endpoint.origin;
}
