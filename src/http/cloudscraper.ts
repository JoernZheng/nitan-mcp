import type { Logger } from "../util/logger.js";
import { resolvePythonScript, runPythonRequest, type PythonRequest, type PythonResponse } from "./python_process.js";

export type CloudscraperRequest = PythonRequest;
export type CloudscraperResponse = PythonResponse;

export class CloudscraperClient {
  private scriptPath = resolvePythonScript("cloudscraper_wrapper.py");
  constructor(_logger: Logger, private pythonPath = "python3") {}
  request(request: CloudscraperRequest, options: { signal?: AbortSignal } = {}): Promise<CloudscraperResponse> {
    return runPythonRequest(this.pythonPath, this.scriptPath, request, options);
  }
}
