import type { PersonnelDatabase } from '../domain/store.ts';
import { handlePersonnelRequest, type PersonnelRequest, type PersonnelResponse, type PersonnelRouteOptions } from './routes.ts';
import type { PersonnelActor } from './access.ts';

/** 宿主认证上下文到人员模块角色的最小适配边界。 */
export interface PersonnelHostRequest {
  method: PersonnelRequest['method'];
  path: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  requestId?: string;
}

export interface PersonnelHostContext {
  resolveActor(request: PersonnelHostRequest): PersonnelActor;
}

export interface PersonnelRouteRegistration {
  method: PersonnelRequest['method'];
  path: string;
  handle(request: PersonnelHostRequest): PersonnelResponse;
}

export interface PersonnelRouteRegistrar {
  register(registration: PersonnelRouteRegistration): void;
}

/**
 * 生成可交给宿主路由器的注册项（覆盖契约中的人员、任职、状态与历史路由）。
 *
 * 这里不依赖 Express/Fastify/Nest 等框架，也不读取 cookie、token 或用户表；
 * 宿主通过 PersonnelHostContext 注入认证结果后，所有请求仍统一经过 routes.ts
 * 的服务端门禁。
 */
export function registerPersonnelRoutes(
  registrar: PersonnelRouteRegistrar,
  db: PersonnelDatabase,
  host: PersonnelHostContext,
  options: { prefix: string; routeOptions?: PersonnelRouteOptions },
): void {
  const prefix = normalizePrefix(options.prefix);
  const register = (method: PersonnelRequest['method'], suffix: string): void => {
    registrar.register({
      method,
      path: `${prefix}${suffix}`,
      handle: (request) => handlePersonnelRequest(db, {
        method: request.method,
        path: stripPrefix(request.path, prefix),
        actor: host.resolveActor(request),
        body: request.body,
        query: request.query,
        requestId: request.requestId,
      }, options.routeOptions),
    });
  };

  register('GET', '/persons');
  register('POST', '/persons');
  register('GET', '/persons/:personId');
  register('PATCH', '/persons/:personId');
  register('DELETE', '/persons/:personId');
  register('POST', '/persons/:personId/assignments');
  register('POST', '/persons/:personId/assignments/:assignmentId/retract');
  register('POST', '/persons/:personId/status-transitions');
  register('GET', '/persons/:personId/history');
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.trim();
  if (normalized === '' || !normalized.startsWith('/')) throw new Error('personnel route prefix must start with /');
  return normalized.replace(/\/+$/u, '');
}

function stripPrefix(path: string, prefix: string): string {
  const normalized = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return normalized === '' ? '/' : normalized;
}
