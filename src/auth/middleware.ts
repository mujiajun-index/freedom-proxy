import type { IncomingMessage } from 'http';
import { readCookie, verifySession, SESSION_COOKIE } from './session';
import type { ConfigStore } from '../store/config';

/** 从请求中解析当前会话（无效或未登录返回 null） */
export function getSession(req: IncomingMessage, store: ConfigStore) {
  const token = readCookie(req, SESSION_COOKIE);
  return verifySession(token, store.sessionSecret);
}

export function isAuthenticated(req: IncomingMessage, store: ConfigStore): boolean {
  return getSession(req, store) !== null;
}
