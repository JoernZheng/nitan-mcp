import type { Logger } from "../util/logger.js";
import { resolvePythonScript, runPythonRequest, type PythonRequest, type PythonResponse } from "./python_process.js";

export type CurlCffiRequest = PythonRequest;
export type CurlCffiResponse = PythonResponse;

export class CurlCffiClient {
  private scriptPath = resolvePythonScript("curl_cffi_wrapper.py");
  constructor(_logger: Logger, private pythonPath = "python3") {}
  request(request: CurlCffiRequest, options: { signal?: AbortSignal } = {}): Promise<CurlCffiResponse> {
    return runPythonRequest(this.pythonPath, this.scriptPath, request, options);
  }
}
