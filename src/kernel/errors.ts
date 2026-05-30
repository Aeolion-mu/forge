/**
 * 模型 API 错误归类。库（OpenAI SDK）已在单请求层做退避重试；当错误仍冒到这里，
 * 说明重试已耗尽或不可重试。这里区分「瞬时(可再试)」与「致命(需人工)」，给可读提示。
 * 注意：整轮不自动重试——工具可能已执行，重放会重复副作用；瞬时错误交由用户重发。
 */

export interface ExplainedError {
  /** 瞬时错误（限流 / 5xx / 网络 / 超时）：用户可直接重发。 */
  transient: boolean;
  message: string;
}

/** 从各种错误形态里尽力抠出 HTTP 状态码。 */
function statusOf(e: Record<string, unknown>): number | undefined {
  for (const k of ["status", "statusCode", "code"]) {
    const v = e[k];
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^\d{3}$/.test(v)) return Number(v);
  }
  const resp = e.response as { status?: number } | undefined;
  return typeof resp?.status === "number" ? resp.status : undefined;
}

export function explainApiError(err: unknown): ExplainedError {
  const e = (err ?? {}) as Record<string, unknown>;
  const status = statusOf(e);
  const code = String(e.code ?? "");
  const msg = String((e.message as string) ?? err ?? "unknown error");

  // 致命：认证 / 额度 / 请求本身有问题，重试无意义
  if (status === 401 || status === 403) return { transient: false, message: `Auth failed (${status}): check API key / permissions.` };
  if (status === 402) return { transient: false, message: `Out of credits (402): account balance or quota exhausted.` };
  if (status === 400 || status === 404 || status === 422) return { transient: false, message: `Request rejected (${status}): ${msg}` };

  // 瞬时：限流 / 服务端 / 网络 / 超时，可直接重发
  if (status === 429) return { transient: true, message: `Rate limited (429): retried with backoff but still failing.` };
  if (status !== undefined && status >= 500) return { transient: true, message: `Server error (${status}): retried but still failing.` };
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|timeout|timed out|aborted|socket hang up|network/i.test(`${code} ${msg}`))
    return { transient: true, message: `Network/timeout: retried but still failing.` };

  return { transient: false, message: msg };
}
