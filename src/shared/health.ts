import { API_ROOT } from "./api.ts";

// Contract of the health check, shared by the server that answers it and the web app that reads it.
export const HEALTH_PATH = `${API_ROOT}/health`;

export interface HealthResponse {
  status: "ok";
}

export function isHealthResponse(value: unknown): value is HealthResponse {
  return typeof value === "object" && value !== null && "status" in value && value.status === "ok";
}
