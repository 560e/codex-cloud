import type { UpstreamBalance } from './types.js';

export function balanceErrorText(balance: UpstreamBalance): string {
  if (balance.errorCode === 'timeout') return '余额查询超时';
  if (balance.errorCode === 'network') return '余额连接失败';
  if (balance.errorCode === 'invalid_response') return '余额数据格式异常';
  if (balance.errorCode === 'http') {
    if (balance.httpStatus === 429) return '余额查询被限流';
    if (balance.httpStatus === 401 || balance.httpStatus === 403) return '余额查询无权限';
    if (balance.httpStatus === 404) return '不支持余额查询';
    if ((balance.httpStatus ?? 0) >= 500) return '余额服务暂不可用';
  }
  return '查询失败';
}
