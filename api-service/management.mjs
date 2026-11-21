import { ApiError, httpBase, readUpstreamJSON, upstream } from './http.mjs';

/** Sign in as the service account only when a request needs the catalog. */
export function managementClient(baseUrl, { username, password, sessionToken, shutdownSignal }) {
  const base = baseUrl ? httpBase(baseUrl) : null;
  const loginName = username?.trim();
  let access;

  /** Normalize both transport and business errors without exposing upstream response bodies. */
  async function request(route, options) {
    const response = await upstream(`${base}/api/client/${route}`, options);
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) return { authStatus: response.status };
      throw new ApiError(502, 'management_unavailable', `管理端请求失败（HTTP ${response.status}）。`);
    }
    const envelope = await readUpstreamJSON(response);
    if ([401, 403].includes(envelope?.code)) return { authStatus: envelope.code };
    if (envelope?.code !== 0) {
      throw new ApiError(502, 'invalid_management_response', '管理端未返回有效数据。');
    }
    return { data: envelope.data };
  }

  /** Share concurrent logins and keep the credential in memory for the next catalog read. */
  function currentAccess() {
    access ??= request('login', { json: { username: loginName, password }, signal: shutdownSignal })
      .then(({ data, authStatus }) => {
        if (authStatus) {
          throw new ApiError(502, 'management_auth_failed', '管理端登录失败，请检查 API 服务配置的用户名、密码及账号状态。');
        }
        if (typeof data?.token !== 'string' || !/^[!-~]{1,4096}$/.test(data.token)) {
          throw new ApiError(502, 'invalid_management_response', '管理端登录响应缺少有效令牌。');
        }
        return data.token;
      })
      .catch((error) => {
        access = undefined;
        throw error;
      });
    return access;
  }

  /** A caller disconnect must not cancel a login shared by other requests. */
  async function catalog(credential, signal) {
    const key = await credential;
    signal?.throwIfAborted();
    return request('models', { key, signal });
  }

  return {
    /** Fetch current model authorizations under the API service's configured management account. */
    async models(signal) {
      if (!base || (!sessionToken && (!loginName || !password))) {
        throw new ApiError(503, 'model_catalog_not_configured', '请为 API 进程配置管理端地址、用户名和密码。');
      }
      signal?.throwIfAborted();
      let credential = sessionToken ? Promise.resolve(sessionToken) : currentAccess();
      let result = await catalog(credential, signal);
      if (result.authStatus === 401 && sessionToken) {
        throw new ApiError(502, 'management_auth_failed', '客户端管理端登录已失效，请重新登录并开启本地 API。');
      }
      if (result.authStatus === 401) {
        // Only invalidate the generation that was rejected. A sibling request may already be refreshing it.
        if (access === credential) access = undefined;
        signal?.throwIfAborted();
        credential = currentAccess();
        result = await catalog(credential, signal);
        if (result.authStatus === 401 && access === credential) access = undefined;
      }
      if (result.authStatus) {
        throw new ApiError(502, 'management_auth_failed', '管理端拒绝读取模型列表，请检查账号状态及模型授权。');
      }
      if (!Array.isArray(result.data)) {
        throw new ApiError(502, 'invalid_management_response', '管理端未返回有效的模型列表。');
      }
      return result.data.filter((model) => typeof model?.code === 'string' && model.code.length > 0);
    },
  };
}

/** Select only an enabled model from the authorized catalog, never from caller-controlled URLs. */
export function selectModel(models, code, kind) {
  const model = models.find((item) => item.code === code);
  if (!model) throw new ApiError(403, 'model_not_allowed', '模型不在 API 服务可用的模型列表中。');
  const unsupported = kind === 'chat' && (model.supportsChat === false || model.supports_chat === false)
    || kind === 'transcribe' && (model.supportsAudioTranscription === false || model.supports_audio_transcription === false);
  if (unsupported) throw new ApiError(400, 'model_capability', '所选模型不支持该任务类型。');
  try {
    return { code, base: httpBase(model.baseUrl), key: typeof model.apiKey === 'string' ? model.apiKey : '' };
  } catch { throw new ApiError(502, 'invalid_model_address', '管理端配置的模型地址无效。'); }
}
